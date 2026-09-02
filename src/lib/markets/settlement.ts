export function isExpiredAt(
  now: Date,
  endDate: Date | null | undefined,
  timeToExpirySec: number | null = null,
): boolean {
  if (timeToExpirySec !== null) return timeToExpirySec <= 0;
  if (endDate) return now.getTime() >= endDate.getTime();
  return false;
}

export function settlementPayoff(
  tick: { startPrice: number | null; outcomeName?: string | null },
  underlyingPrice: number | null,
): number | null {
  if (tick.startPrice === null || underlyingPrice === null) return null;
  const up = underlyingPrice >= tick.startPrice;
  const name = (tick.outcomeName ?? "").trim().toLowerCase();
  if (name === "yes" || name === "up") return up ? 1 : 0;
  if (name === "no" || name === "down") return up ? 0 : 1;
  return null;
}
