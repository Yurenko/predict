import type { PredictionOrderbookPayload } from "@/lib/binance/sapi-wss";
import { asDecimalString, asNumber, sumLevels } from "@/lib/normalize/numbers";

export interface NormalizedOrderbookSnapshot {
  venueMarketId: string;
  observedAt: Date;
  bestBid: string | null;
  bestAsk: string | null;
  midPrice: string | null;
  spread: string | null;
  chance: string | null;
  bidDepth: string | null;
  askDepth: string | null;
  liquidity: string | null;
  sequence: bigint;
  lastPrice: null;
  executableFromBook: true;
}

/**
 * WS orderbook is a full top-N snapshot, not a last-trade price.
 * mid/chance are implied from the book. lastPrice stays null on purpose.
 */
export function normalizeOrderbook(
  book: PredictionOrderbookPayload,
): NormalizedOrderbookSnapshot {
  const bestBid = asNumber(book.bids[0]?.[0]);
  const bestAsk = asNumber(book.asks[0]?.[0]);
  const mid =
    bestBid !== null && bestAsk !== null
      ? (bestBid + bestAsk) / 2
      : (bestBid ?? bestAsk);
  const spread =
    bestBid !== null && bestAsk !== null ? Math.max(0, bestAsk - bestBid) : null;
  const bids = sumLevels(book.bids);
  const asks = sumLevels(book.asks);

  return {
    venueMarketId: String(book.marketId),
    observedAt: new Date(book.updateTimestampMs),
    bestBid: asDecimalString(bestBid),
    bestAsk: asDecimalString(bestAsk),
    midPrice: asDecimalString(mid),
    spread: asDecimalString(spread),
    chance: mid !== null && mid > 0 && mid < 1 ? asDecimalString(mid) : null,
    bidDepth: asDecimalString(bids.size),
    askDepth: asDecimalString(asks.size),
    liquidity: asDecimalString(bids.notional + asks.notional),
    sequence: BigInt(book.updateTimestampMs),
    lastPrice: null,
    executableFromBook: true,
  };
}

export function timeToExpirySec(endDate: Date | null, observedAt: Date): number | null {
  if (!endDate) return null;
  return Math.floor((endDate.getTime() - observedAt.getTime()) / 1000);
}
