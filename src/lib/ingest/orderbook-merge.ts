import { asNumber } from "@/lib/normalize/numbers";

function positivePrice(value: unknown): boolean {
  const n = asNumber(value);
  return n !== null && n > 0;
}

export function hasExecutableSide(book: { bestBid?: unknown; bestAsk?: unknown }): boolean {
  return positivePrice(book.bestBid) || positivePrice(book.bestAsk);
}

/** Keep the last executable bid/ask when a WS/REST snapshot arrives with an empty side. */
export function keepLastExecutablePrices<T extends { bestBid?: unknown; bestAsk?: unknown }>(
  previous: T | null | undefined,
  incoming: T,
): T {
  return {
    ...incoming,
    bestBid: positivePrice(incoming.bestBid) ? incoming.bestBid : (previous?.bestBid ?? incoming.bestBid),
    bestAsk: positivePrice(incoming.bestAsk) ? incoming.bestAsk : (previous?.bestAsk ?? incoming.bestAsk),
  };
}

export function lastExecutableSides(
  snapshots: Array<{ bestBid?: unknown; bestAsk?: unknown; lastPrice?: unknown }>,
): { bestBid: number | null; bestAsk: number | null; lastPrice: number | null } {
  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  let lastPrice: number | null = null;
  for (const snap of snapshots) {
    if (lastPrice === null) lastPrice = asNumber(snap.lastPrice);
    const bid = asNumber(snap.bestBid);
    const ask = asNumber(snap.bestAsk);
    if (bestBid === null && bid !== null && bid > 0) bestBid = bid;
    if (bestAsk === null && ask !== null && ask > 0) bestAsk = ask;
    if (bestBid !== null && bestAsk !== null) break;
  }
  return { bestBid, bestAsk, lastPrice };
}
