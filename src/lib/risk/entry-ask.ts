/** Same cap as underlying-momentum-lag maxBuyAsk. pending_flip must not bypass it. */
export const DEFAULT_MAX_ENTRY_ASK = 0.75;

export function entryAskAllowed(
  ask: number | null | undefined,
  maxAsk: number = DEFAULT_MAX_ENTRY_ASK,
): boolean {
  if (ask == null || !Number.isFinite(ask) || !Number.isFinite(maxAsk)) return false;
  return ask <= maxAsk + 1e-12;
}

export function shouldClearPendingFlipOnBlockedEnter(blockedNames: string[]): boolean {
  return blockedNames.some((name) => name === "min_time_to_expiry" || name === "max_entry_ask");
}
