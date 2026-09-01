function lastAtOrBefore<T extends { observedAt: Date }>(
  rows: T[],
  at: Date,
): T | null {
  if (rows.length === 0) return null;
  const target = at.getTime();
  let lo = 0;
  let hi = rows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = rows[mid]!.observedAt.getTime();
    if (t <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 ? (rows[found] ?? null) : null;
}

export function appendTick<T extends { observedAt: Date }>(rows: T[], tick: T): void {
  const last = rows[rows.length - 1];
  if (last && tick.observedAt.getTime() < last.observedAt.getTime()) {
    throw new Error("look-ahead blocked: tick arrived out of order");
  }
  rows.push(tick);
}

export function returnOver(
  ticks: Array<{ observedAt: Date; price: number }>,
  now: Date,
  lookbackMs: number,
): number | null {
  const current = lastAtOrBefore(ticks, now);
  const past = lastAtOrBefore(ticks, new Date(now.getTime() - lookbackMs));
  if (!current || !past || past.price === 0) return null;
  if (current.observedAt.getTime() > now.getTime()) return null;
  return (current.price - past.price) / past.price;
}

export function rollingStats(
  values: Array<{ observedAt: Date; value: number }>,
  now: Date,
  window: number,
): { mean: number; std: number; z: number } | null {
  const eligible = values.filter((row) => row.observedAt.getTime() <= now.getTime());
  if (eligible.length === 0) return null;
  const slice = eligible.slice(-Math.max(1, window));
  const current = slice[slice.length - 1];
  if (!current) return null;
  const mean = slice.reduce((sum, row) => sum + row.value, 0) / slice.length;
  const variance =
    slice.reduce((sum, row) => sum + (row.value - mean) ** 2, 0) / slice.length;
  const std = Math.sqrt(variance);
  const z = std > 0 ? (current.value - mean) / std : 0;
  return { mean, std, z };
}

export { lastAtOrBefore };
