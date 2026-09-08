/** Next cycle, same as the paper loop — SUBMITTED then FILLED like LIVE. */
export const PAPER_FILL_DELAY_MS = 5_000;

/**
 * After the window ends Paper closes locally (slot frees) without the 0/1 lottery.
 * Binance-style settlement numbers land after this delay.
 */
export const PAPER_SETTLEMENT_DELAY_MS = 15_000;

export function paperFillReady(submittedAt: Date | string | null | undefined, now: Date): boolean {
  if (!submittedAt) return false;
  const at = typeof submittedAt === "string" ? Date.parse(submittedAt) : submittedAt.getTime();
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at >= PAPER_FILL_DELAY_MS;
}

export function paperSettleAt(closedAt: Date): Date {
  return new Date(closedAt.getTime() + PAPER_SETTLEMENT_DELAY_MS);
}

export function paperSettlementReady(raw: unknown, now: Date): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const row = raw as Record<string, unknown>;
  if (row.expired !== true) return false;
  if (row.settled === true) return false;
  if (row.closePrice != null) return false;
  const settleAt = typeof row.settleAt === "string" ? Date.parse(row.settleAt) : Number.NaN;
  if (!Number.isFinite(settleAt)) return false;
  return now.getTime() >= settleAt;
}
