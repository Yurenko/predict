import { asNumber } from "@/lib/normalize/numbers";
import { prisma } from "@/lib/db/prisma";
import { cryptoWindowDurationSec } from "@/lib/markets/horizon";
import type {
  BacktestConfig,
  HistoricalQuote,
  MarketTick,
  ReplayEvent,
} from "@/lib/backtest/types";
import { historyStart } from "@/lib/backtest/windows";

function decimal(value: unknown): number | null {
  return asNumber(value);
}

export async function loadReplayEvents(config: BacktestConfig): Promise<{
  events: ReplayEvent[];
  quotes: HistoricalQuote[];
}> {
  const from = config.walkForward
    ? config.testFrom
    : historyStart({
        trainFrom: config.trainFrom,
        testFrom: config.testFrom,
        lookbackMinutes: config.lookbackMinutes,
      });
  const to = config.testTo;

  const [snapshots, underlyings, quotes] = await Promise.all([
    prisma.marketSnapshot.findMany({
      where: { observedAt: { gte: from, lte: to } },
      include: {
        market: { include: { topic: true, outcomes: true } },
        outcome: true,
      },
      orderBy: { observedAt: "asc" },
    }),
    prisma.underlyingSnapshot.findMany({
      where: { observedAt: { gte: from, lte: to } },
      orderBy: { observedAt: "asc" },
    }),
    prisma.predictionQuote.findMany({
      where: { quotedAt: { gte: from, lte: to } },
      orderBy: { quotedAt: "asc" },
    }),
  ]);

  const marketEvents: ReplayEvent[] = snapshots.map((row) => {
    const tick: MarketTick = {
      observedAt: row.observedAt,
      marketId: row.marketId,
      venueMarketId: row.market.venueMarketId,
      outcomeId: row.outcomeId,
      tokenId: row.outcome?.tokenId ?? null,
      outcomeName: row.outcome?.name ?? null,
      symbol: row.market.topic.symbol,
      endDate: row.market.topic.endDate,
      startDate: row.market.topic.startDate,
      windowDurationSec: cryptoWindowDurationSec({
        startDate: row.market.topic.startDate,
        endDate: row.market.topic.endDate,
        title: row.market.topic.title,
      }),
      startPrice: decimal(row.market.topic.startPrice),
      bestBid: decimal(row.bestBid),
      bestAsk: decimal(row.bestAsk),
      midPrice: decimal(row.midPrice),
      chance: decimal(row.chance),
      lastPrice: decimal(row.lastPrice),
      spread: decimal(row.spread),
      liquidity: decimal(row.liquidity),
      bidDepth: decimal(row.bidDepth),
      askDepth: decimal(row.askDepth),
      timeToExpirySec: row.timeToExpirySec,
    };
    return { kind: "market", at: row.observedAt, tick };
  });

  const underlyingEvents: ReplayEvent[] = underlyings.map((row) => ({
    kind: "underlying" as const,
    at: row.observedAt,
    tick: {
      observedAt: row.observedAt,
      symbol: row.symbol,
      price: decimal(row.price) ?? 0,
      bid: decimal(row.bid),
      ask: decimal(row.ask),
      volume: decimal(row.volume),
    },
  }));

  const historicalQuotes: HistoricalQuote[] = quotes.map((row) => ({
    tokenId: row.tokenId,
    quotedAt: row.quotedAt,
    averagePrice: decimal(row.averagePrice),
    lastPrice: decimal(row.lastPrice),
    chance: decimal(row.chance),
    feeAmount: decimal(row.feeAmount),
    feeRateBps: row.feeRateBps,
    slippageBps: row.slippageBps,
    priceImpact: decimal(row.priceImpact),
    minReceive: decimal(row.minReceive),
    expireAt: row.expireAt,
  }));

  return {
    events: [...marketEvents, ...underlyingEvents],
    quotes: historicalQuotes,
  };
}
