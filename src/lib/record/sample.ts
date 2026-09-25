import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { buildStrategyContext } from "@/lib/backtest/context";
import type { UnderlyingTick } from "@/lib/backtest/types";
import { readLiveOrderbook } from "@/lib/ingest/raw-store";
import { returnOver } from "@/lib/backtest/features";
import { asNumber } from "@/lib/normalize/numbers";
import { tradableMarketQuery, marketHeadline, isShortCryptoUpDownRow } from "@/lib/markets/horizon";
import { selectPrimarySnapshot, tickFromSnapshot } from "@/lib/normalize/tick";
import { createStrategy, loadResearchStrategies } from "@/lib/strategy";
import type { Strategy, StrategyContext, StrategySignal } from "@/lib/types/domain";
import { childLogger } from "@/lib/logger";
import { inc } from "@/lib/observability/metrics";
import { touchRecordSample } from "@/lib/record/control";
import type { RecordHypotheticalSignal } from "@/lib/record/types";

const log = childLogger({ component: "record-sample" });

function rollingWindowFromParams(params: Record<string, unknown>): number {
  const value = params.rollingWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 60;
}

export function hypotheticalSignals(
  context: StrategyContext,
  strategies: Array<{ slug: string; strategy: Strategy }>,
): RecordHypotheticalSignal[] {
  const out: RecordHypotheticalSignal[] = [];
  for (const row of strategies) {
    const signal = row.strategy.evaluate(context);
    if (!signal) continue;
    out.push(toHypothetical(row.slug, signal));
  }
  return out;
}

export function toHypothetical(slug: string, signal: StrategySignal): RecordHypotheticalSignal {
  return {
    strategySlug: slug,
    direction: signal.direction,
    fairProbability: signal.fairProbability,
    netEdge: signal.netEdge,
    reason: signal.reason,
  };
}

async function loadStrategies(): Promise<Array<{ slug: string; strategy: Strategy }>> {
  const rows = await prisma.strategy.findMany({ orderBy: { slug: "asc" } });
  if (rows.length === 0) {
    return loadResearchStrategies().map((strategy) => ({ slug: strategy.id, strategy }));
  }
  return rows.flatMap((row) => {
    if (!row.enabled) return [];
    const params = (row.parameters ?? {}) as Record<string, unknown>;
    const strategy = createStrategy(row.slug, params);
    return strategy ? [{ slug: row.slug, strategy }] : [];
  });
}

function maxRollingWindow(rows: Array<{ parameters: unknown }>): number {
  let window = 60;
  for (const row of rows) {
    const params = (row.parameters ?? {}) as Record<string, unknown>;
    window = Math.max(window, rollingWindowFromParams(params));
  }
  return window;
}

/**
 * One sample of the live feature tape. Never getQuote / placeOrder / paper fill.
 */
export async function sampleRecordOnce(sessionId: string): Promise<{
  ticks: number;
  signals: number;
  markets: number;
}> {
  const strategies = await loadStrategies();
  const strategyRows = await prisma.strategy.findMany({ select: { parameters: true } });
  const rollingWindow = maxRollingWindow(strategyRows);

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

  const now = new Date();
  const rows: Prisma.RecordTickCreateManyInput[] = [];
  let signalCount = 0;

  for (const market of markets) {
    if (!isShortCryptoUpDownRow(market)) continue;
    const picked = selectPrimarySnapshot(market.snapshots, market.outcomes);
    if (!picked) continue;
    const { snapshot: latest, outcome } = picked;
    let tick = tickFromSnapshot({ ...latest, market, outcome });
    const live = await readLiveOrderbook(market.venueMarketId);
    if (live) {
      tick = {
        ...tick,
        bestBid: asNumber(live.bestBid) ?? tick.bestBid,
        bestAsk: asNumber(live.bestAsk) ?? tick.bestAsk,
      };
    }

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
      rollingWindow,
    });
    const signals = hypotheticalSignals(ctx, strategies);
    signalCount += signals.length;

    rows.push({
      sessionId,
      observedAt: now,
      marketId: market.id,
      marketTitle: marketHeadline(market),
      venueMarketId: market.venueMarketId,
      symbol: tick.symbol,
      bestBid: tick.bestBid,
      bestAsk: tick.bestAsk,
      chance: ctx.marketProbability || null,
      lastPrice: tick.lastPrice,
      liquidity: tick.liquidity,
      spread: tick.spread,
      timeToExpirySec: ctx.timeToExpirySec,
      liveBook: Boolean(live),
      underlyingPrice: ctx.underlyingPrice,
      underlyingReturn1m: ctx.features.underlyingReturn1m,
      underlyingReturn5m: ctx.features.underlyingReturn5m,
      underlyingReturn15m: ctx.features.underlyingReturn15m,
      probabilityMean: ctx.features.probabilityMean,
      probabilityStd: ctx.features.probabilityStd,
      probabilityZ: ctx.features.probabilityZ,
      signals: signals as Prisma.InputJsonValue,
    });
  }

  if (rows.length === 0) {
    for (const [symbol, ticks] of underlyingsBySymbol) {
      const latest = ticks[ticks.length - 1];
      if (!latest) continue;
      rows.push({
        sessionId,
        observedAt: now,
        marketId: `underlying:${symbol}`,
        marketTitle: symbol,
        venueMarketId: symbol,
        symbol,
        bestBid: latest.bid,
        bestAsk: latest.ask,
        chance: null,
        lastPrice: latest.price,
        liquidity: null,
        spread: null,
        timeToExpirySec: null,
        liveBook: false,
        underlyingPrice: latest.price,
        underlyingReturn1m: returnOver(ticks, now, 60_000),
        underlyingReturn5m: returnOver(ticks, now, 5 * 60_000),
        underlyingReturn15m: returnOver(ticks, now, 15 * 60_000),
        probabilityMean: null,
        probabilityStd: null,
        probabilityZ: null,
        signals: [],
      });
    }
  }

  if (rows.length > 0) {
    await prisma.recordTick.createMany({ data: rows });
  }

  await touchRecordSample({
    sessionId,
    tickCount: rows.length,
    signalCount,
    marketCount: rows.length,
  });
  inc("record.sample", { ticks: String(rows.length) });
  log.info({ sessionId, ticks: rows.length, signals: signalCount }, "record sample (no trading)");
  return { ticks: rows.length, signals: signalCount, markets: rows.length };
}
