import { pickPrimaryOutcome } from "@/lib/normalize/markets";
import { asNumber } from "@/lib/normalize/numbers";
import type { MarketTick } from "@/lib/backtest/types";

export interface SnapshotTickRow {
  observedAt: Date;
  marketId: string;
  outcomeId: string | null;
  lastPrice: unknown;
  chance: unknown;
  bestBid: unknown;
  bestAsk: unknown;
  midPrice: unknown;
  spread: unknown;
  liquidity: unknown;
  bidDepth: unknown;
  askDepth: unknown;
  timeToExpirySec: number | null;
  market: {
    venueMarketId: string;
    topic: {
      symbol: string | null;
      endDate: Date | null;
      startPrice: unknown;
    };
    outcomes: Array<{ tokenId: string; name: string; outcomeIndex: number | null }>;
  };
  outcome: { tokenId: string; name: string } | null;
}

export function tickFromSnapshot(row: SnapshotTickRow): MarketTick {
  const primary = pickPrimaryOutcome(
    row.market.outcomes.map((outcome) => ({
      tokenId: outcome.tokenId,
      name: outcome.name,
      outcomeIndex: outcome.outcomeIndex,
      lastChance: null,
      lastPrice: null,
    })),
  );
  return {
    observedAt: row.observedAt,
    marketId: row.marketId,
    venueMarketId: row.market.venueMarketId,
    outcomeId: row.outcomeId,
    tokenId: row.outcome?.tokenId ?? primary?.tokenId ?? null,
    outcomeName: row.outcome?.name ?? primary?.name ?? null,
    symbol: row.market.topic.symbol,
    endDate: row.market.topic.endDate,
    startPrice: asNumber(row.market.topic.startPrice),
    bestBid: asNumber(row.bestBid),
    bestAsk: asNumber(row.bestAsk),
    midPrice: asNumber(row.midPrice),
    chance: asNumber(row.chance),
    lastPrice: asNumber(row.lastPrice),
    spread: asNumber(row.spread),
    liquidity: asNumber(row.liquidity),
    bidDepth: asNumber(row.bidDepth),
    askDepth: asNumber(row.askDepth),
    timeToExpirySec: row.timeToExpirySec,
  };
}
