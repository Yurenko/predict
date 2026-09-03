import { OrderSide, TradingMode } from "@prisma/client";
import { OfficialPredictionAdapter } from "@/lib/binance/prediction-adapter";
import { env, isLiveTradingEnabled } from "@/lib/config/env";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { asNumber } from "@/lib/normalize/numbers";
import { buildStrategyContext } from "@/lib/backtest/context";
import type { UnderlyingTick } from "@/lib/backtest/types";
import { evaluateRisk } from "@/lib/risk/evaluate";
import { limitsFromEnv } from "@/lib/risk/limits";
import { loadRiskState, persistRiskDecision, persistRiskSnapshot } from "@/lib/risk/persist";
import { recordClosedTrade } from "@/lib/risk/state";
import { createStrategy } from "@/lib/strategy";
import { readLiveOrderbook } from "@/lib/ingest/raw-store";
import { tradableMarketQuery } from "@/lib/markets/horizon";
import { sleep } from "@/lib/binance/rate-limit";
import {
  decidePaperAction,
  fetchOfficialPaperQuote,
  hasPredictionWallet,
  readPaperEntryMode,
  shouldSkipPeerEnter,
  persistPaperTrade,
  type PaperBook,
  type PaperQuote,
  type PaperTradeRequest,
} from "@/lib/paper";
import {
  executeLiveTrade,
  reconcileLiveOrders,
  type LiveTradeContext,
} from "@/lib/live";
import { tickFromSnapshot } from "@/lib/normalize/tick";

const log = childLogger({ component: "live-worker" });

export async function runLiveOnce(ctx: LiveTradeContext, venue: OfficialPredictionAdapter): Promise<{
  enabled: number;
  considered: number;
  submitted: number;
}> {
  const enabled = await prisma.strategy.findMany({ where: { enabled: true } });
  if (enabled.length === 0) {
    log.info("no enabled strategies; live trader is idle");
    return { enabled: 0, considered: 0, submitted: 0 };
  }

  const entryMode = await readPaperEntryMode();

  const markets = await prisma.market.findMany({
    ...tradableMarketQuery(),
    include: {
      topic: true,
      outcomes: true,
      snapshots: { orderBy: { observedAt: "desc" }, take: 60 },
    },
  });

  const underlyingsRaw = await prisma.underlyingSnapshot.findMany({
    where: { observedAt: { gte: new Date(Date.now() - 30 * 60_000) } },
    orderBy: { observedAt: "asc" },
  });
  const underlyingsBySymbol = new Map<string, UnderlyingTick[]>();
  for (const row of underlyingsRaw) {
    const price = asNumber(row.price);
    if (!price) continue;
    const list = underlyingsBySymbol.get(row.symbol) ?? [];
    list.push({
      observedAt: row.observedAt,
      symbol: row.symbol,
      price,
      bid: asNumber(row.bid),
      ask: asNumber(row.ask),
      volume: asNumber(row.volume),
    });
    underlyingsBySymbol.set(row.symbol, list);
  }

  const limits = limitsFromEnv();
  let riskState = await loadRiskState();
  const now = new Date();
  let considered = 0;
  let submitted = 0;

  for (const market of markets) {
    const latest = market.snapshots[0];
    if (!latest) continue;
    considered += 1;

    const outcome =
      market.outcomes.find((item) => item.id === latest.outcomeId) ?? market.outcomes[0] ?? null;
    let tick = tickFromSnapshot({ ...latest, market, outcome });
    const live = await readLiveOrderbook(market.venueMarketId);
    if (live) {
      tick = {
        ...tick,
        bestBid: asNumber(live.bestBid) ?? tick.bestBid,
        bestAsk: asNumber(live.bestAsk) ?? tick.bestAsk,
      };
    }

    const dataAgeMs = live?.updateTimestampMs
      ? now.getTime() - live.updateTimestampMs
      : now.getTime() - tick.observedAt.getTime();

    const probability = market.snapshots
      .slice()
      .reverse()
      .flatMap((row) => {
        const value = asNumber(row.chance) ?? asNumber(row.midPrice);
        return value === null ? [] : [{ observedAt: row.observedAt, value }];
      });

    const ctxStrategy = buildStrategyContext({
      now,
      tick,
      underlyings: tick.symbol ? (underlyingsBySymbol.get(tick.symbol) ?? []) : [],
      probability,
      quotes: [],
      rollingWindow: 60,
    });

    for (const row of enabled) {
      const params = (row.parameters ?? {}) as Record<string, unknown>;
      const strategy = createStrategy(row.slug, params);
      if (!strategy) continue;
      const signal = strategy.evaluate(ctxStrategy);
      if (!signal) continue;
      const tokenId = tick.tokenId;
      if (!tokenId) continue;

      const open = await prisma.position.findFirst({
        where: {
          mode: TradingMode.LIVE,
          status: "OPEN",
          marketId: market.id,
          strategyId: row.id,
          tokenId,
        },
      });
      const action = decidePaperAction(signal.direction, open?.side ?? null);
      if (action === "HOLD") continue;

      if (action === "ENTER") {
        const peer = await prisma.position.findFirst({
          where: {
            mode: TradingMode.LIVE,
            status: "OPEN",
            marketId: market.id,
            tokenId,
            NOT: { strategyId: row.id },
          },
          select: { id: true },
        });
        if (shouldSkipPeerEnter(entryMode, action, Boolean(peer))) continue;
      }

      const executable =
        action === "EXIT" && open?.side === OrderSide.BUY ? tick.bestBid : tick.bestAsk;
      const notional =
        action === "EXIT" && open
          ? Number(open.shares) * (executable ?? Number(open.avgPrice))
          : limits.bankrollUsdt * (limits.maxPositionPct / 100);

      const book: PaperBook = {
        bestBid: tick.bestBid,
        bestAsk: tick.bestAsk,
        lastPrice: tick.lastPrice,
        liquidity: tick.liquidity,
        bidDepth: tick.bidDepth,
        askDepth: tick.askDepth,
        timeToExpirySec: ctxStrategy.timeToExpirySec,
        dataAgeMs,
      };

      const pre = evaluateRisk(
        {
          action,
          mode: TradingMode.LIVE,
          now,
          strategyId: row.slug,
          marketId: market.id,
          requestedNotional: notional,
          bestBid: tick.bestBid,
          bestAsk: tick.bestAsk,
          lastPrice: tick.lastPrice,
          liquidity: tick.liquidity,
          timeToExpirySec: ctxStrategy.timeToExpirySec,
          estimatedSlippageBps: null,
          estimatedPriceImpact: null,
          quoteExpireAt: null,
          dataAgeMs,
        },
        riskState,
        limits,
      );
      if (!pre.allowed) {
        await persistRiskDecision(pre, { marketId: market.id, strategyId: row.id });
        riskState = pre.nextState;
        continue;
      }

      const side =
        action === "EXIT"
          ? open?.side === OrderSide.BUY
            ? "SELL"
            : "BUY"
          : signal.direction === "SELL"
            ? "SELL"
            : "BUY";

      const quote: PaperQuote | null = await fetchOfficialPaperQuote({
        tokenId,
        side,
        amountUsdt: notional,
        slippageBps: limits.maxSlippageBps,
      });

      const request: PaperTradeRequest = {
        mode: TradingMode.LIVE,
        action,
        strategyId: row.slug,
        marketId: market.id,
        outcomeId: tick.outcomeId ?? undefined,
        tokenId,
        signal,
        book,
        quote,
        now,
        requestedNotional: notional,
        maxPriceImpact: limits.maxPriceImpact,
        positionSide: open?.side,
        idempotencyWindowMs: env.LIVE_IDEMPOTENCY_MS,
      };

      const result = await executeLiveTrade(request, riskState, limits, venue, ctx);
      if (result.riskDecision) {
        await persistRiskDecision(result.riskDecision, {
          marketId: market.id,
          strategyId: row.id,
        });
        riskState = result.riskDecision.nextState;
      }

      if (result.placed || quote) {
        const saved = await persistPaperTrade({ request, result, signal });
        if (result.placed) submitted += 1;
        if (action === "EXIT" && open && saved?.realizedPnl !== null && saved?.realizedPnl !== undefined) {
          const closed = recordClosedTrade(riskState, saved.realizedPnl, now, limits);
          riskState = closed.state;
          await persistRiskSnapshot(riskState);
        }
      }

      log.info(
        {
          slug: row.slug,
          market: market.venueMarketId,
          action,
          status: result.status,
          reason: result.reason,
          venueOrderId: result.venueOrderId,
          placed: result.placed,
        },
        "live decision",
      );
    }
  }

  try {
    const [history, active] = await Promise.all([
      venue.queryOrderHistory({ walletAddress: ctx.walletAddress, limit: 50 }),
      venue.queryActiveOrders({ walletAddress: ctx.walletAddress, limit: 50 }),
    ]);
    const applied = await reconcileLiveOrders({ history, active });
    log.info({ applied }, "live reconcile");
  } catch (error) {
    log.warn({ err: String(error) }, "live reconcile skipped");
  }

  log.info({ enabled: enabled.length, considered, submitted }, "live cycle complete");
  return { enabled: enabled.length, considered, submitted };
}

export async function startLiveTrader(): Promise<void> {
  log.info(
    {
      intervalMs: env.LIVE_LOOP_INTERVAL_MS,
      liveTradingEnabled: isLiveTradingEnabled(),
      hasWallet: hasPredictionWallet(),
    },
    "starting live trader (placeOrder only after dashboard Start, when both live flags are on)",
  );

  if (!isLiveTradingEnabled()) {
    log.warn("LIVE_TRADING_ENABLED+TRADING_MODE=LIVE are off; not calling placeOrder");
    do {
      if (env.COLLECTOR_ONCE) return;
      await sleep(env.LIVE_LOOP_INTERVAL_MS);
    } while (true);
  }

  const { runRecordLoop } = await import("@/lib/record/loop");
  await runRecordLoop({ exitOnSignal: true });
}
