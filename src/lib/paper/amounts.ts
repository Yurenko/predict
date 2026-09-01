/** Convert a USDT notional to wei (18 decimals) for official getQuote amountIn. */
export function usdtToWei(usdt: number): string {
  if (!Number.isFinite(usdt) || usdt <= 0) {
    throw new Error("amountIn must be a positive USDT amount");
  }
  const [whole, frac = ""] = usdt.toFixed(18).split(".");
  return BigInt(`${whole}${frac.padEnd(18, "0").slice(0, 18)}`).toString();
}
