import { invertBinaryBook, invertBinaryPrice } from "@/lib/live/binary";
import { outcomeIsDownToken, pickPrimaryOutcome } from "@/lib/normalize/markets";
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
    outcomes: Array<{
      id?: string;
      tokenId: string;
      name: string;
      outcomeIndex: number | null;
    }>;
  };
  outcome: { id?: string; tokenId: string; name: string } | null;
}

export function selectPrimarySnapshot<
  TSnap extends { outcomeId: string | null },
  TOut extends { id: string; tokenId: string; name: string; outcomeIndex: number | null },
>(
  snapshots: TSnap[],
  outcomes: TOut[],
): { snapshot: TSnap; outcome: TOut | null } | null {
  const latest = snapshots[0];
  if (!latest) return null;
  const primary = pickPrimaryOutcome(
    outcomes.map((outcome) => ({
      tokenId: outcome.tokenId,
      name: outcome.name,
      outcomeIndex: outcome.outcomeIndex,
      lastChance: null,
      lastPrice: null,
    })),
  );
  const outcome =
    outcomes.find((item) => item.tokenId === primary?.tokenId) ??
    outcomes.find((item) => item.id === latest.outcomeId) ??
    outcomes[0] ??
    null;
  const snapshot =
    (outcome ? snapshots.find((row) => row.outcomeId === outcome.id) : undefined) ?? latest;
  return { snapshot, outcome };
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
  const snapDown = outcomeIsDownToken(row.outcome?.name);
  const rawBid = asNumber(row.bestBid);
  const rawAsk = asNumber(row.bestAsk);
  const rawLast = asNumber(row.lastPrice);
  const book = snapDown
    ? invertBinaryBook({ bestBid: rawBid, bestAsk: rawAsk, lastPrice: rawLast })
    : { bestBid: rawBid, bestAsk: rawAsk, lastPrice: rawLast };
  const chance = asNumber(row.chance);
  const mid = asNumber(row.midPrice);
  const primaryRow = row.market.outcomes.find((item) => item.tokenId === primary?.tokenId);
  return {
    observedAt: row.observedAt,
    marketId: row.marketId,
    venueMarketId: row.market.venueMarketId,
    outcomeId: primaryRow?.id ?? (snapDown ? null : row.outcomeId),
    tokenId: primary?.tokenId ?? row.outcome?.tokenId ?? null,
    outcomeName: primary?.name ?? row.outcome?.name ?? null,
    symbol: row.market.topic.symbol,
    endDate: row.market.topic.endDate,
    startPrice: asNumber(row.market.topic.startPrice),
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    lastPrice: book.lastPrice,
    midPrice: snapDown ? invertBinaryPrice(mid) : mid,
    chance: snapDown ? invertBinaryPrice(chance) : chance,
    spread: asNumber(row.spread),
    liquidity: asNumber(row.liquidity),
    bidDepth: asNumber(row.bidDepth),
    askDepth: asNumber(row.askDepth),
    timeToExpirySec: row.timeToExpirySec,
  };
}
