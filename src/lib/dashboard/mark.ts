export type BookMark = {
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
};

/**
 * Flatten price for an open position: sell a long at bid, buy back a short at ask.
 * lastPrice is historical and is never the mark.
 */
export function markPrice(
  side: "BUY" | "SELL",
  book: BookMark,
): { mark: number | null; source: "bid" | "ask" | "none" } {
  if (side === "BUY") {
    return book.bestBid !== null && book.bestBid > 0
      ? { mark: book.bestBid, source: "bid" }
      : { mark: null, source: "none" };
  }
  return book.bestAsk !== null && book.bestAsk > 0
    ? { mark: book.bestAsk, source: "ask" }
    : { mark: null, source: "none" };
}

export function unrealizedPnl(
  side: "BUY" | "SELL",
  avgPrice: number,
  shares: number,
  mark: number | null,
): number | null {
  if (mark === null || !(shares > 0)) return null;
  return side === "BUY" ? (mark - avgPrice) * shares : (avgPrice - mark) * shares;
}
