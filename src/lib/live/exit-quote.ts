import { fetchOfficialPaperQuoteResult } from "@/lib/paper/fetch-quote";
import type { PaperQuote } from "@/lib/paper/quote-validate";
import { liveExitCoverNotional, liveFlattenExitPrice } from "@/lib/live/notional";

export type LiveExitQuoteResult =
  | { quote: PaperQuote; notional: number; priceLimit: number | null; belowMin: false }
  | { quote: null; notional: number; belowMin: boolean; exceeded: boolean };

/**
 * MARKET FOK SELL for the full leftover stack (same size as the Binance Max button).
 * getQuote SELL amountIn is shares, not USDT.
 */
export async function quoteLiveExitSell(options: {
  tokenId: string;
  shares: number;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  avgPrice: number;
  slippageBps: number;
  urgent?: boolean;
}): Promise<LiveExitQuoteResult> {
  const shares = Number.isFinite(options.shares) ? Math.max(0, options.shares) : 0;
  if (!(shares > 0)) {
    return { quote: null, notional: 0, belowMin: true, exceeded: false };
  }

  const fillPrice = liveFlattenExitPrice({
    positionSide: "BUY",
    bestBid: options.bestBid,
    bestAsk: options.bestAsk,
    lastPrice: options.lastPrice,
    avgPrice: options.avgPrice,
    aggressive: false,
  });
  const notional = liveExitCoverNotional(
    shares,
    fillPrice > 0 ? fillPrice : options.avgPrice,
  );
  if (!(notional > 0)) {
    return { quote: null, notional: 0, belowMin: true, exceeded: false };
  }

  const first = await fetchOfficialPaperQuoteResult({
    tokenId: options.tokenId,
    side: "SELL",
    amountShares: shares,
    amountUsdt: notional,
    slippageBps: options.slippageBps,
    orderType: "MARKET",
    urgent: options.urgent === true,
  });

  if (first.quote) {
    return { quote: first.quote, notional, priceLimit: null, belowMin: false };
  }

  return {
    quote: null,
    notional,
    belowMin: false,
    exceeded: first.exceededShares,
  };
}
