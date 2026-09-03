# Architecture

Research-first платформа для Binance Wallet Prediction Markets.

## Принципи

- Дані і виконання живуть у worker-процесах; локальний дашборд Start крутить той самий цикл in-process (paper або live).
- Live trading вимкнений, поки `LIVE_TRADING_ENABLED=true` і `TRADING_MODE=LIVE` одночасно (`npm run dev:live` форсить обидва).
- Quote з Binance — джерело executable price, fees, slippage і price impact. `lastPrice` — історична ціна, не гарантія виконання.
- Стратегії реалізують `evaluate(context) -> Signal | null` і тестуються окремо.

## Фази

1. Структура проєкту + база даних
2. Binance адаптери + raw data collector
3. Нормалізована історична вибірка
4. Event-driven backtest engine
5. Три стратегії: Underlying Momentum Lag, Mean Reversion, Fair Value
6. Risk engine
7. Paper trading
8. Dashboard
9. Observability
10. AWS (ECS Fargate, RDS, ElastiCache, EFS, S3, CloudWatch, Secrets Manager, ALB)
11. Optional live execution (поточна: gated `placeOrder`, вимкнений за замовчуванням)

## Процеси

```
Binance Prediction REST/WS ──► prediction collector ──► raw jsonl / Redis
Binance Spot WS            ──► underlying collector  ──► raw jsonl / Redis
                                    │
                                    ▼
                             normalize (live + replay)
                                    │
                    MarketSnapshot / UnderlyingSnapshot
                                    │
                                    ▼
                             backtest (Phase 4)
                                    │
                                    ▼
                             strategy worker
                                    │
                                    ▼
                              risk engine
                                    │
                                    ▼
                         execution (paper | live adapter)
                                    │
                                    ▼
                           Next.js dashboard / BFF
```

Backtest читає тільки historical snapshots у порядку `observedAt` і не має доступу до майбутніх рядків.

## Дані (Prisma)

Ієрархія Binance: `MarketTopic` → `Market` → `MarketOutcome` (`tokenId`).

Знімки: `MarketSnapshot`, `UnderlyingSnapshot`, `PredictionQuote`, `RawIngestEvent`.

Торгівля: `Signal`, `Position`, `Order`, `Execution`, `Fee`.

Дослідження: `Strategy`, `BacktestRun`, `BacktestTrade`.

Ризик: `RiskEvent`, `RiskState`, `SystemSetting`, `SystemEvent`.

Поля quote звірені з офіційним `GetQuoteResponse` у `@binance/w3w-prediction`: `quoteId`, `chance`, `averagePrice`, `lastPrice`, `priceImpact`, `feeAmount`, `feeRateBps`, `slippageBps`, `minReceive`, `expireAt`.

## REST, який обгорнутий у Phase 2

Офіційний коннектор `@binance/w3w-prediction` 2.1.1, host `https://api.binance.com`:

- `GET /sapi/v1/w3w/wallet/prediction/category/list`
- `GET /sapi/v1/w3w/wallet/prediction/market/list`
- `GET /sapi/v1/w3w/wallet/prediction/market/detail`
- `GET /sapi/v1/w3w/wallet/prediction/market/search`
- `GET /sapi/v1/w3w/wallet/prediction/order-book`
- `GET /sapi/v1/w3w/wallet/prediction/order-book/last-trade-price`
- `POST /sapi/v1/w3w/wallet/prediction/trade/get-quote` (adapter only; collector не спамить quotes)

`feeRateBps` у запит getQuote **не передаємо**. Беремо фактичне значення з відповіді.

Spot underlying: combined stream `wss://stream.binance.com:9443/stream?streams={symbol}@ticker`.

Prediction realtime: офіційний SApi WSS
`wss://api.binance.com/sapi/wss?topic=web3_prediction_orderbook_data`
(підпис HMAC-SHA256 + заголовок `X-MBX-APIKEY`). Один стрім на всі ринки, ping кожні 30 с, reconnect з новим timestamp/signature, ротація до 24 год.

REST для prediction — лише рідке discovery (`market/list` + `detail`), без поллінгу order-book. Quote/order-book REST лишаються в адаптері для виконання угод, не для колектора.

## Нормалізація (Phase 3)

- `GetMarketDetailResponse` → upsert Topic / Market / Outcome. Якщо WS прийшов раніше за REST, створюється stub `pending:{marketId}`, потім `venueMarketId` перелінковується.
- WSS orderbook — повний top-N snapshot на `marketId`. `chance` = mid книги, якщо mid ∈ (0, 1). `lastPrice` не заповнюється з цього стріму.
- Spot `@ticker` → `UnderlyingSnapshot`; last/close не вважається executable prediction quote.
- Replay: `npm run worker:normalize` читає `RAW_DATA_DIR` (jsonl) і пише ті самі таблиці.

## Backtest (Phase 4)

- Стрім подій: `UnderlyingSnapshot` і `MarketSnapshot`, сортування за `observedAt` (underlying раніше за market на тому самому часі).
- Контекст стратегії і фічі (returns, z-score) рахуються лише з `t <= now`.
- Філ: `bestAsk` / `bestBid`. `lastPrice` ігнорується.
- Якщо немає quote-комісії і `fallbackFeeRateBps` = null — угоди немає (не підставляємо 200 bps).
- Walk-forward: угоди лише в test-вікні кожного fold.
- Результат: `data/backtests/*.json`; Prisma `BacktestRun`, якщо є рядок `Strategy`.
- `engine-smoke` — не дослідницька стратегія, лише перевірка движка.

## Стратегії (Phase 5)

Усі реалізують `evaluate(context) → Signal | null` і незалежно backtestable. Seed: `enabled: false`.

1. **Underlying Momentum Lag** — underlying уже рухався, книга ще не переоцінила. Fair = logistic від 1m/5m/15m return. Executable = ask/bid.
2. **Mean Reversion** — z-score ймовірності vs rolling mean/vol. Немає правила «spread > X».
3. **Fair Value** — модель P(ITM) з moneyness і часом до експірації vs executable after costs + safety margin. Без startPrice/underlying — немає сигналу.

Комісію 200 bps не підставляємо. `lastPrice` не використовується як executable.

## Risk (Phase 6)

`evaluateRisk(intent, state, limits)` — чистий гейт перед входом.

- ENTER блокується: kill switch **лише для LIVE і лише якщо вручну ON**, max size/count/exposure, min liquidity (unknown ≠ ok), min time-to-expiry, відсутній bid/ask, LIVE без двох прапорців.
- Cooldown, stale WS, API breaker, slippage і price impact **не ріжуть ENTER** ні в PAPER, ні в LIVE.
- EXIT (flatten) дозволений при kill, якщо є executable book.
- Денний лос і просадка **не** армлять kill. Kill за замовчуванням off; Старт LIVE скидає leftover kill. Увімкнути — кнопка на `/risk`.
- `lastPrice` як proposed fill → `ABNORMAL_FILL`.

Backtest використовує ті самі size/tte/liquidity гейти; daily-loss kill у replay навмисно не ріже дослідження (ліміт 100% у backtest adapter).

## Paper trading (Phase 7)

Окремий Node-процес: `npm run worker:paper` (аліас `execution`).

- Філ лише через `executePaperTrade`: офіційний `getQuote` + книга. `lastPrice` відхиляється, якщо відрізняється від ask/bid.
- `placeOrder` **не викликається**. Якщо `mode=LIVE` або live-прапорці увімкнені — paper worker відмовляє (`npm run dev:live` + Старт).
- Немає quote / expireAt у минулому / немає feeAmount і feeRateBps → немає філу. `feeRateBps` у запит getQuote не передаємо.
- Idempotency: SHA-256 ключ на mode/strategy/market/token/side/action/time bucket; повтор у тому ж вікні не створює другий Execution.
- Order state machine: `PENDING → SUBMITTED → FILLED|PARTIALLY_FILLED|FAILED|EXPIRED|CANCELLED`.
- Стратегії seed `enabled: false`. Без увімкненої стратегії воркер idle.
- Потрібні `BINANCE_PREDICTION_WALLET_ADDRESS` і paper API ключі для реального getQuote. Інакше причина `missing_quote`.

## Dashboard (Phase 8)

Next.js UI + BFF (`GET /api/dashboard`). Workers лишаються окремими процесами.

- Огляд: mode, kill switch, equity / daily PnL / drawdown, DB/Redis, wallet/keys **лише як boolean**.
- Позиції: mark-to-market з bid (long) / ask (short). `lastPrice` окрема колонка «історична».
- Ордери, сигнали, ринки (live Redis book overlay), backtest runs, стратегії, risk events.
- `PATCH /api/dashboard/strategies` змінює тільки `Strategy.enabled`.
- `PATCH /api/dashboard/risk` армить/знімає kill switch. **LIVE_TRADING_ENABLED з UI змінити не можна.**
- Payload проходить `assertNoSecrets` — ключі Binance не серіалізуються.

## Observability (Phase 9)

- Pino JSON logs з redact `apiKey` / `apiSecret`. `src/instrumentation.ts` ловить server errors Next.js.
- `GET /api/health` — liveness + алерти + collector heartbeats (`ingest:health:*`), таймаут 1.5s.
- `GET /api/ready` — HTTP 503, якщо Postgres або Redis недоступні.
- `GET /api/metrics` — JSON counters/gauges цього процесу; `?format=prom` для Prometheus text.
- Алерти: database_down, redis_down, kill_switch, stale_data, api_breaker, collector_stale, paper_quote_unready, live_flags_on, live_keys_missing.
- Workers інкрементять метрики у своєму процесі (`ws.stale`, `paper.order`, `ingest.result`). `npm run worker:observe` друкує знімок.
- UI: `/observability`. Секрети не серіалізуються.

## AWS (Phase 10)

IaC у `infra/aws`. **Apply не є частиною цього етапу.**

- **Web:** ECS Fargate, Next.js standalone (`Dockerfile`), ALB. Target group health: `GET /api/ready` (Postgres+Redis). Container healthcheck: `GET /api/health` (процес живий).
- **Workers:** окремі сервіси `worker-live` (`collector:live`) і `worker-paper` (`paper`). Не всередині Next.js.
- **Дані:** RDS PostgreSQL 16 у private subnets, ElastiCache Redis 7 там само.
- **Сирі дампи:** EFS на `/data/raw` для collector; S3 bucket + IAM `PutObject` для майбутнього sync (SDK поки не підключений).
- **Мережа (research):** Fargate у public subnets з `assign_public_ip`, щоб дістати Binance WSS без NAT. RDS/Redis лишаються приватними.
- **Секрети:** Secrets Manager JSON (`DATABASE_URL`, `REDIS_URL`, paper API key/secret, wallet). У образах і committed tfvars ключів немає.
- **Live off:** `LIVE_TRADING_ENABLED=false` і `TRADING_MODE=PAPER` зашиті в Dockerfiles, compose і ECS task env. Live credentials у Secrets Manager не кладуться.
- **Локально prod-like:** `docker compose -f docker-compose.yml -f docker-compose.app.yml up --build`
- **Міграції:** `npm run db:migrate:deploy` / one-off ECS task з `npx prisma migrate deploy`.
- CI: `npm test` + `terraform fmt -check` + `terraform validate` (`.github/workflows/ci.yml`).

## Live execution (Phase 11)

Локальний UX як у paper: `npm run dev` або `npm run dev:live`, далі стратегії і **Старт/Стоп** на Огляді. Цикл крутиться в процесі дашборда (як record/paper). `placeOrder` лише поки сесія running і обидва live-прапорці on (`dev:live` їх форсить, dotenv їх не перебиває). **Не** додається в ECS з `LIVE_TRADING_ENABLED=true`.

- Увімкнення режиму — команда запуску, не кнопка на `/risk`. `PATCH /api/dashboard/risk` як і раніше відхиляє live flags.
- Credentials: `BINANCE_LIVE_API_KEY` / `SECRET` (окремо від paper). `placeOrder` у адаптері теж відмовляє без двох прапорців.
- Порядок: той самий risk gate → офіційний `getQuote` (без `feeRateBps`) → `POST .../trade/place-order-bundle` з `orderType=MARKET`, `timeInForce=FOK`, `quoteId`.
- `PlaceOrderResponse` має лише `orderId`. Філ не симулюється і не береться з `lastPrice`. Кількість/ціна — з `queryOrderHistory` / `queryActiveOrders` (`filledUsdtAmount`, `filledShareQty`, `price`, `marketProviderFee`, `networkFee`).
- `walletId`: `BINANCE_PREDICTION_WALLET_ID` або збіг адреси в `listPredictionWallets`. Немає id — немає ордера.
- Paper worker (`npm run worker:paper`) падає на старті, якщо live-прапорці увімкнені.
- `npm run worker:live-exec` — той самий record loop (чекає Старт); не запускати паралельно з `dev:live`.

