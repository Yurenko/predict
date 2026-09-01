import type { BacktestCosts, HistoricalQuote } from "@/lib/backtest/types";

export interface FillIntent {
  side: "BUY" | "SELL";
  requestedNotional: number;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  bidDepth: number | null;
  askDepth: number | null;
  liquidity: number | null;
  quote: HistoricalQuote | null;
  costs: BacktestCosts;
  maxPriceImpact: number;
}

export type FillOk = {
  ok: true;
  price: number;
  shares: number;
  notional: number;
  fee: number;
  slippage: number;
  priceImpact: number;
  networkCost: number;
  partial: boolean;
};

export type FillSkip = { ok: false; reason: string };

export type FillResult = FillOk | FillSkip;

function feeFromQuoteOrFallback(
  notional: number,
  intent: FillIntent,
): { fee: number } | FillSkip {
  const quote = intent.costs.useQuoteFees ? intent.quote : null;
  if (quote && typeof quote.feeAmount === "number") {
    return { fee: Math.max(0, quote.feeAmount) };
  }
  const bps =
    quote && typeof quote.feeRateBps === "number"
      ? quote.feeRateBps
      : intent.costs.fallbackFeeRateBps;
  if (bps === null || bps === undefined) {
    return { ok: false, reason: "missing_fee_data" };
  }
  return { fee: notional * (bps / 10_000) };
}

/**
 * Executable fill against the book. lastPrice is ignored on purpose.
 */
export function simulateFill(intent: FillIntent): FillResult {
  if (!(intent.requestedNotional > 0)) {
    return { ok: false, reason: "zero_size" };
  }

  const top = intent.side === "BUY" ? intent.bestAsk : intent.bestBid;
  if (top === null || !(top > 0)) {
    return { ok: false, reason: "no_executable_book" };
  }

  let impactFrac = 0;
  if (intent.costs.simulatePriceImpact) {
    if (intent.quote && typeof intent.quote.priceImpact === "number") {
      impactFrac = Math.max(0, intent.quote.priceImpact);
    } else if (intent.liquidity && intent.liquidity > 0) {
      impactFrac = intent.requestedNotional / intent.liquidity;
    }
    impactFrac = Math.min(impactFrac, intent.maxPriceImpact);
  }

  const price =
    intent.side === "BUY" ? top * (1 + impactFrac) : top * Math.max(0, 1 - impactFrac);
  if (!(price > 0)) {
    return { ok: false, reason: "invalid_fill_price" };
  }

  let shares = intent.requestedNotional / price;
  const depth = intent.side === "BUY" ? intent.askDepth : intent.bidDepth;
  let partial = false;
  if (typeof depth === "number" && depth >= 0) {
    if (depth <= 0) {
      return { ok: false, reason: "no_depth" };
    }
    if (shares > depth) {
      if (!intent.costs.allowPartialFills) {
        return { ok: false, reason: "insufficient_depth" };
      }
      shares = depth;
      partial = true;
    }
  }

  const notional = shares * price;
  const feeResult = feeFromQuoteOrFallback(notional, intent);
  if ("ok" in feeResult) return feeResult;

  let slippage = 0;
  if (intent.costs.simulateSlippage && intent.quote && typeof intent.quote.slippageBps === "number") {
    slippage = notional * (intent.quote.slippageBps / 10_000);
  }

  const priceImpact = Math.abs(price - top) * shares;
  return {
    ok: true,
    price,
    shares,
    notional,
    fee: feeResult.fee,
    slippage,
    priceImpact,
    networkCost: intent.costs.networkCostUsdt,
    partial,
  };
}
