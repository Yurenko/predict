/** 18-decimal wei string. BUY getQuote uses USDT; SELL uses share quantity. */
export function toWei(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("amountIn must be a positive quantity");
  }
  const [whole, frac = ""] = amount.toFixed(18).split(".");
  return BigInt(`${whole}${frac.padEnd(18, "0").slice(0, 18)}`).toString();
}

/** @deprecated Prefer quoteAmountInWei — BUY is USDT, SELL is shares. */
export function usdtToWei(usdt: number): string {
  return toWei(usdt);
}

/**
 * Official getQuote amountIn.
 * BUY = USDT spent. SELL = shares sold (what the Binance Max button fills).
 * There is no max=true flag on the endpoint.
 */
export function quoteAmountInWei(options: {
  side: "BUY" | "SELL";
  amountUsdt?: number;
  amountShares?: number;
}): string {
  if (options.side === "SELL") {
    const shares = options.amountShares;
    if (shares == null || !Number.isFinite(shares) || !(shares > 0)) {
      throw new Error("SELL getQuote amountIn is shares (inventory), not USDT");
    }
    return toWei(shares);
  }
  const usdt = options.amountUsdt;
  if (usdt == null || !Number.isFinite(usdt) || !(usdt > 0)) {
    throw new Error("BUY getQuote amountIn must be a positive USDT amount");
  }
  return toWei(usdt);
}
