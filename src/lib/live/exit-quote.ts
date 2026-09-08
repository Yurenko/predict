import { fetchOfficialPaperQuoteResult } from "@/lib/paper/fetch-quote";
import type { PaperQuote } from "@/lib/paper/quote-validate";
import { liveExitCoverNotional, liveFlattenExitPrice } from "@/lib/live/notional";

export type LiveExitQuoteResult =
  | { quote: PaperQuote; notional: number; priceLimit: number; belowMin: false }
  | { quote: null; notional: number; belowMin: boolean; exceeded: boolean };

/**
 * One LIMIT GTC SELL for the full leftover stack.
 * getQuote SELL amountIn is shares (same as the Binance Max button), not USDT.
 * MARKET FOK only takes the top of the book and leaves shares.
 */
export async function quoteLiveExitSell(options: {
  tokenId: string;
  shares: number;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  avgPrice: number;
  slippageBps: number;
}): Promise<LiveExitQuoteResult> {
  const shares = Number.isFinite(options.shares) ? Math.max(0, options.shares) : 0;
  if (!(shares > 0)) {
    return { quote: null, notional: 0, belowMin: true, exceeded: false };
  }

  const priceLimit = liveFlattenExitPrice({
    positionSide: "BUY",
    bestBid: options.bestBid,
    bestAsk: options.bestAsk,
    lastPrice: options.lastPrice,
    avgPrice: options.avgPrice,
    aggressive: false,
  });
  if (!(priceLimit > 0)) {
    return { quote: null, notional: 0, belowMin: true, exceeded: false };
  }

  const notional = liveExitCoverNotional(shares, priceLimit);
  if (!(notional > 0)) {
    return { quote: null, notional: 0, belowMin: true, exceeded: false };
  }

  const first = await fetchOfficialPaperQuoteResult({
    tokenId: options.tokenId,
    side: "SELL",
    amountShares: shares,
    amountUsdt: notional,
    slippageBps: options.slippageBps,
    orderType: "LIMIT",
    priceLimit,
  });

  if (first.quote) {
    return { quote: first.quote, notional, priceLimit, belowMin: false };
  }

  return {
    quote: null,
    notional,
    belowMin: false,
    exceeded: first.exceededShares,
  };
}
