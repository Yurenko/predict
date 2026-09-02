import { OrderSide, SystemEventLevel, TradingMode } from "@prisma/client";
import { env, isLiveTradingEnabled } from "@/lib/config/env";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { asNumber } from "@/lib/normalize/numbers";
import { tickFromSnapshot } from "@/lib/normalize/tick";
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
import { inc } from "@/lib/observability/metrics";
import { recordSystemEvent } from "@/lib/observability/events";
import {
  decidePaperAction,
  executePaperTrade,
  fetchOfficialPaperQuote,
  hasPredictionWallet,
  readPaperEntryMode,
  shouldSkipPeerEnter,
  paperExitPnl,
  persistPaperTrade,
  skippedPaperTrade,
  writePaperCycle,
  PAPER_SKIP,
  type PaperBook,
  type PaperQuote,
  type PaperTradeRequest,
} from "@/lib/paper";
import { flattenExpiredPaperPositions } from "@/lib/paper/expiry";

const log = childLogger({ component: "paper-worker" });

export { tickFromSnapshot };

export async function runPaperOnce(): Promise<{
  enabled: number;
  considered: number;
  filled: number;
  skip: string | null;
}> {
  log.info(
    {
      liveTradingEnabled: isLiveTradingEnabled(),
      hasWallet: hasPredictionWallet(),
    },
    "paper cycle: PAPER fills only, never placeOrder",
  );

  const enabled = await prisma.strategy.findMany({ where: { enabled: true } });
  if (enabled.length === 0) {
    log.info("no enabled strategies; paper trader is idle (seed defaults are disabled)");
    const cycle = {
      at: new Date().toISOString(),
      enabled: 0,
      considered: 0,
      filled: 0,
      skip: PAPER_SKIP.noEnabledStrategies,
    };
    await writePaperCycle(cycle);
    return cycle;
  }

  if (!hasPredictionWallet()) {
    log.info("BINANCE_PREDICTION_WALLET_ADDRESS empty; getQuote skipped, no fills");
  }

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
  const settled = await flattenExpiredPaperPositions({
    now,
    riskState,
    limits,
    underlyingsBySymbol,
  });
  riskState = settled.riskState;
  const entryMode = await readPaperEntryMode();
  let considered = 0;
  let filled = settled.filled;

  for (const market of markets) {
    const latest = market.snapshots[0];
    if (!latest) continue;
    if (market.topic.endDate && now.getTime() >= market.topic.endDate.getTime()) continue;
    considered += 1;

    const outcome =
      market.outcomes.find((item) => item.id === latest.outcomeId) ??
      market.outcomes[0] ??
      null;
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

    const ctx = buildStrategyContext({
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
      const signal = strategy.evaluate(ctx);
      if (!signal) continue;

      const tokenId = tick.tokenId;
      if (!tokenId) continue;

      const open = await prisma.position.findFirst({
        where: {
          mode: TradingMode.PAPER,
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
            mode: TradingMode.PAPER,
            status: "OPEN",
            marketId: market.id,
            tokenId,
            NOT: { strategyId: row.id },
          },
          select: { id: true, strategyId: true },
        });
        if (shouldSkipPeerEnter(entryMode, action, Boolean(peer))) {
          log.info(
            { slug: row.slug, market: market.venueMarketId, peerStrategyId: peer?.strategyId, entryMode },
            "paper skip duplicate enter: same market already open",
          );
          continue;
        }
      }

      const executable =
        action === "EXIT" && open?.side === OrderSide.BUY
          ? tick.bestBid
          : tick.bestAsk;
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
        timeToExpirySec: ctx.timeToExpirySec,
        dataAgeMs,
      };

      const pre = evaluateRisk(
        {
          action,
          mode: TradingMode.PAPER,
          now,
          strategyId: row.slug,
          marketId: market.id,
          requestedNotional: notional,
          bestBid: tick.bestBid,
          bestAsk: tick.bestAsk,
          lastPrice: tick.lastPrice,
          liquidity: tick.liquidity,
          timeToExpirySec: ctx.timeToExpirySec,
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
        const reason = pre.checks.find((c) => !c.passed)?.name ?? "risk_rejected";
        const request: PaperTradeRequest = {
          mode: TradingMode.PAPER,
          action,
          strategyId: row.slug,
          marketId: market.id,
          outcomeId: tick.outcomeId ?? undefined,
          tokenId,
          signal,
          book,
          quote: null,
          now,
          requestedNotional: notional,
          maxPriceImpact: limits.maxPriceImpact,
          positionSide: open?.side,
          idempotencyWindowMs: env.PAPER_IDEMPOTENCY_MS,
        };
        await persistPaperTrade({
          request,
          result: skippedPaperTrade(request, reason),
          signal,
        });
        log.info(
          { slug: row.slug, market: market.venueMarketId, reason },
          "paper skipped before getQuote",
        );
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
        mode: TradingMode.PAPER,
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
        idempotencyWindowMs: env.PAPER_IDEMPOTENCY_MS,
      };

      const result = executePaperTrade(request, riskState, limits);
      if (result.riskDecision) {
        await persistRiskDecision(result.riskDecision, {
          marketId: market.id,
          strategyId: row.id,
        });
        riskState = result.riskDecision.nextState;
      }

      const saved = await persistPaperTrade({ request, result, signal });
      if (result.fill && (result.status === "FILLED" || result.status === "PARTIALLY_FILLED")) {
        filled += 1;
        if (action === "ENTER") {
          riskState = {
            ...riskState,
            openPositions: riskState.openPositions + 1,
            openNotional: riskState.openNotional + result.fill.notional,
          };
        } else if (action === "EXIT" && open) {
          const pnl =
            saved?.realizedPnl ??
            paperExitPnl(
              {
                side: open.side,
                avgPrice: Number(open.avgPrice),
                shares: Number(open.shares),
              },
              result.fill,
            );
          const closed = recordClosedTrade(riskState, pnl, now, limits);
          riskState = {
            ...closed.state,
            openPositions: Math.max(0, riskState.openPositions - 1),
            openNotional: Math.max(
              0,
              riskState.openNotional - Number(open.shares) * Number(open.avgPrice),
            ),
          };
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
          duplicate: result.duplicate,
        },
        "paper decision",
      );
    }
  }

  const skip =
    considered === 0
      ? markets.length === 0
        ? PAPER_SKIP.noNearExpiry
        : PAPER_SKIP.noPredictionBook
      : filled === 0
        ? PAPER_SKIP.noEntryYet
        : null;
  const cycle = {
    at: new Date().toISOString(),
    enabled: enabled.length,
    considered,
    filled,
    skip,
  };
  await writePaperCycle(cycle);
  log.info(cycle, "paper cycle complete");
  return cycle;
}

export async function startPaperTrader(): Promise<void> {
  assertPaperWorkerNotLive();
  log.info(
    { intervalMs: env.PAPER_LOOP_INTERVAL_MS },
    "starting paper trader (never calls Binance placeOrder)",
  );
  do {
    try {
      await runPaperOnce();
    } catch (error) {
      inc("paper.cycle_error");
      log.error({ err: String(error) }, "paper cycle failed");
      await recordSystemEvent({
        level: SystemEventLevel.ERROR,
        component: "paper-worker",
        message: String(error),
      });
    }
    if (env.COLLECTOR_ONCE) return;
    await sleep(env.PAPER_LOOP_INTERVAL_MS);
  } while (true);
}
