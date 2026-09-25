/**
 * Lock in the kind of winner from the operator screenshot:
 * cheap entry (~0.13–0.15) marked ~0.45–0.47. Do not wait for 0.98.
 */
export function shouldTakeProfit(options: {
  entryPrice: number;
  currentPrice: number;
  timeToExpirySec?: number | null;
  takeProfitMark?: number;
  takeProfitMinDelta?: number;
  minTteSec?: number;
}): boolean {
  const mark = options.takeProfitMark ?? 0.45;
  const minDelta = options.takeProfitMinDelta ?? 0.2;
  const minTte = options.minTteSec ?? 30;
  const entry = options.entryPrice;
  const current = options.currentPrice;
  if (!(entry >= 0 && entry <= 1) || !(current >= 0 && current <= 1)) return false;
  if (options.timeToExpirySec != null && options.timeToExpirySec < minTte) return false;
  return current >= mark && current - entry >= minDelta;
}

export function takeProfitReason(entryPrice: number, currentPrice: number): string {
  return `take-profit: mark ${currentPrice.toFixed(3)} vs entry ${entryPrice.toFixed(3)} (lock-in ≥0.45 with +0.20)`;
}

/** Mark dropped 15¢ from entry, or an expensive entry fell through 0.25. Cheap 0.13 entries are not stopped at 0.25. */
export function shouldStopLoss(options: {
  entryPrice: number;
  currentPrice: number;
  stopLossDelta?: number;
  stopLossMark?: number;
}): boolean {
  const entry = options.entryPrice;
  const current = options.currentPrice;
  if (!(entry >= 0 && entry <= 1) || !(current >= 0 && current <= 1)) return false;
  const delta = options.stopLossDelta ?? 0.15;
  const floor = options.stopLossMark ?? 0.25;
  if (current <= entry - delta) return true;
  return entry > floor && current <= floor;
}

export function stopLossReason(entryPrice: number, currentPrice: number): string {
  return `stop-loss: mark ${currentPrice.toFixed(3)} vs entry ${entryPrice.toFixed(3)}`;
}
