# Binance Prediction Market Research Platform

Research-first платформа для Binance Wallet Prediction Markets: збір даних, backtest і paper trading. Live execution вимкнений за замовчуванням і не вмикається, поки не пройдуть risk gates.

Жодна стратегія не вважається прибутковою, доки це не підтвердить walk-forward / out-of-sample backtest з реальними комісіями, slippage і price impact.

## Поточний етап

**Phase 11 — Optional live execution**

Локально той самий дашборд, що й paper: `npm run dev` (paper) або `npm run dev:live` (live). Після відкриття UI — стратегії, **Старт** і **Стоп**. `placeOrder` викликається лише після Старт, коли команда `dev:live` увімкнула обидва прапорці. Docker/ECS лишають live вимкненим. З UI live-прапорці змінити не можна.

Далі: paper + walk-forward, перш ніж запускати `npm run dev:live`.

Повний план: [docs/architecture.md](docs/architecture.md).

## Вимоги

- Node.js 22.12+
- Docker Desktop (PostgreSQL + Redis)
- npm

## Швидкий старт

```bash
cp .env.example .env
docker compose up -d
npx prisma migrate dev --name init
npx prisma db seed
npm run dev
# live (той самий UI, реальні ордери після Старт):
# npm run dev:live
```

Dashboard: [http://localhost:3000](http://localhost:3000)  
Позиції: [http://localhost:3000/positions](http://localhost:3000/positions)  
Health: [http://localhost:3000/api/health](http://localhost:3000/api/health)  
Ready: [http://localhost:3000/api/ready](http://localhost:3000/api/ready)  
Metrics: [http://localhost:3000/api/metrics](http://localhost:3000/api/metrics)  
Спостереження: [http://localhost:3000/observability](http://localhost:3000/observability)  
Prisma Studio: `npx prisma studio`

Workers (окремий процес, не Next.js):

```bash
# Рекомендовано: prediction orderbook WSS + spot WSS
# REST лише рідко для назв ринків (раз на 10 хв), без поллінгу стаканів
npm run worker:live

# Окремо:
npm run worker:prediction   # wss://api.binance.com/sapi/wss topic=web3_prediction_orderbook_data
npm run worker:underlying   # публічний spot @ticker
npm run worker:rest         # тільки метадані ринків, раз на 10 хвилин
npm run worker:normalize    # replay data/raw/*.jsonl у нормалізовані таблиці
npm run worker:backtest -- configs/backtest.momentum-lag.json
npm run worker:backtest -- configs/backtest.example.json
npm run worker:backtest -- configs/backtest.fair-value.json
npm run worker:strategy
npm run worker:risk
npm run worker:paper          # paper fills vs getQuote + book; never placeOrder
npm run worker:live-exec      # same Start/Stop loop as dashboard; idle until Start
npm run worker:observe        # health / alerts / metrics snapshot
```

Для prediction WebSocket потрібні `BINANCE_PAPER_API_KEY` і `SECRET` (підписаний SApi WSS). Spot ключів не потребує.

Сирі payload-и: Redis (live стакан кожен тік) + Postgres/jsonl не частіше 1 раз/сек на ринок, щоб не забити диск.

## Змінні середовища

Див. `.env.example`. Критичні прапорці:

| Змінна | Значення за замовчуванням | Примітка |
| --- | --- | --- |
| `LIVE_TRADING_ENABLED` | `false` | Локально `npm run dev` форсить PAPER, `npm run dev:live` — LIVE |
| `TRADING_MODE` | `PAPER` | Потрібні обидва: `true` + `LIVE` (ставить `dev:live`) |
| `BINANCE_PAPER_API_KEY` | порожньо | Тільки сервер |
| `MAX_ENTRY_ASK` | `0.55` | Не купувати токен дорожче 55¢ (0.65–0.75 як раніше — ні; стоп ріже лузера) |
| `TAKE_PROFIT_MARK` | `0.45` | Закрити, коли executable mark ≈ скрін (0.13→0.47) |
| `STOP_LOSS_DELTA` / `STOP_LOSS_MARK` | `0.15` / `0.25` | Різати лузера: −15¢ від входу або mark ≤ 0.25 (дешеві 0.13 не чіпає) |
| `LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | Локальна Ollama, без ключа. Модель `llama3.1:8b` |
| `EDGE_MIN` / `EDGE_MAX` | `0.08` / `1` | Мін. 8% edge, max 100% = без стелі. На дашборді Стратегії можна змінити |

Секрети Binance ніколи не віддаються в браузер.

## Структура

```
src/app              Next.js dashboard + BFF
src/lib/binance      адаптери (Phase 2)
src/lib/normalize    REST/WS → Prisma snapshots (Phase 3)
src/lib/backtest     event-driven replay (Phase 4)
src/lib/strategy     pluggable evaluate() (Phase 5)
src/lib/risk         pre-trade gates / kill switch (Phase 6)
src/lib/paper        paper execution, quotes, idempotency (Phase 7)
src/lib/dashboard    BFF payload for the operator UI (Phase 8)
src/lib/observability health, metrics, alerts (Phase 9)
infra/aws            Terraform: ECS, RDS, Redis, EFS, S3, ALB (Phase 10)
src/lib/live         gated official placeOrder (Phase 11)
src/lib/config       env, live/paper gates
src/lib/db           Prisma + Redis
workers/src          окремі Node.js процеси
prisma               схема і seed
configs              приклади backtest
```

## AWS

```bash
docker compose -f docker-compose.yml -f docker-compose.app.yml up --build
npm run db:migrate:deploy
```

Прод-міграції: `npm run db:migrate:deploy` (`prisma migrate deploy`, не `migrate dev`). Terraform: `infra/aws` (скопіювати `terraform.tfvars.example`, секрети лише через `TF_VAR_*` або gitignored tfvars). **Не apply-ити наосліп.**

## Правила з ТЗ

1. Не вважати стратегію прибутковою апріорі.
2. Стратегії pluggable і незалежно backtestable.
3. Live trading не вмикати за замовчуванням.
4. API-секрети тільки на сервері.
5. У backtest не використовувати майбутні дані.
6. PnL завжди з fees, slippage, price impact і network/provider costs.
7. Брати реальні схеми Binance, не вигадувати endpoint-и.
8. Якщо capability немає — ізолювати за адаптером, не підробляти.
