export interface EquityCurvePoint {
  t: string;
  equity: number;
}

export type EquityRangeId = "1h" | "6h" | "24h" | "3d" | "all" | "custom";

export const EQUITY_RANGE_PRESETS = [
  { id: "1h" as const, label: "1 год", ms: 60 * 60_000 },
  { id: "6h" as const, label: "6 год", ms: 6 * 60 * 60_000 },
  { id: "24h" as const, label: "24 год", ms: 24 * 60 * 60_000 },
  { id: "3d" as const, label: "3 дні", ms: 3 * 24 * 60 * 60_000 },
  { id: "all" as const, label: "все", ms: null },
];

export const EQUITY_MIN_WINDOW_MS = 5 * 60_000;

export function equityCurveExtent(curve: Array<{ t: string }>): { minMs: number; maxMs: number } | null {
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  for (const point of curve) {
    const ms = Date.parse(point.t);
    if (!Number.isFinite(ms)) continue;
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null;
  return { minMs, maxMs };
}

export function clampEquityWindow(options: {
  fromMs: number;
  toMs: number;
  minMs: number;
  maxMs: number;
  minSpanMs?: number;
}): { fromMs: number; toMs: number } {
  const minSpan = options.minSpanMs ?? EQUITY_MIN_WINDOW_MS;
  const spanMax = Math.max(minSpan, options.maxMs - options.minMs);
  let from = Math.min(options.fromMs, options.toMs);
  let to = Math.max(options.fromMs, options.toMs);
  from = Math.max(options.minMs, Math.min(from, options.maxMs));
  to = Math.max(options.minMs, Math.min(to, options.maxMs));
  if (to - from < minSpan) {
    const mid = (from + to) / 2;
    from = mid - minSpan / 2;
    to = mid + minSpan / 2;
    if (from < options.minMs) {
      from = options.minMs;
      to = Math.min(options.maxMs, from + minSpan);
    }
    if (to > options.maxMs) {
      to = options.maxMs;
      from = Math.max(options.minMs, to - minSpan);
    }
  }
  if (to - from > spanMax) to = from + spanMax;
  return { fromMs: from, toMs: to };
}

export function equityWindowForRange(options: {
  curve: Array<{ t: string }>;
  range: EquityRangeId;
  customFromMs?: number;
  customToMs?: number;
}): { fromMs: number; toMs: number } | null {
  const extent = equityCurveExtent(options.curve);
  if (!extent) return null;
  if (options.range === "all") return extent;
  if (options.range === "custom" && options.customFromMs != null && options.customToMs != null) {
    return clampEquityWindow({
      fromMs: options.customFromMs,
      toMs: options.customToMs,
      minMs: extent.minMs,
      maxMs: extent.maxMs,
    });
  }
  const preset = EQUITY_RANGE_PRESETS.find((row) => row.id === options.range);
  const ms = preset?.ms;
  if (ms == null) return extent;
  return clampEquityWindow({
    fromMs: extent.maxMs - ms,
    toMs: extent.maxMs,
    minMs: extent.minMs,
    maxMs: extent.maxMs,
    minSpanMs: Math.min(ms, EQUITY_MIN_WINDOW_MS),
  });
}

export function zoomEquityWindow(options: {
  fromMs: number;
  toMs: number;
  factor: number;
  anchorMs: number;
  minMs: number;
  maxMs: number;
}): { fromMs: number; toMs: number } {
  const span = Math.max(1, options.toMs - options.fromMs);
  const next = Math.max(EQUITY_MIN_WINDOW_MS, span * options.factor);
  const frac =
    span > 0 ? (options.anchorMs - options.fromMs) / span : 0.5;
  const from = options.anchorMs - next * frac;
  return clampEquityWindow({
    fromMs: from,
    toMs: from + next,
    minMs: options.minMs,
    maxMs: options.maxMs,
  });
}

/** Keep a carry-forward point at the left edge so the line does not start mid-window. */
export function sliceEquityCurve<T extends EquityCurvePoint>(
  curve: T[],
  fromMs: number,
  toMs: number,
): T[] {
  if (curve.length === 0) return [];
  const from = Math.min(fromMs, toMs);
  const to = Math.max(fromMs, toMs);
  let carry: T | null = null;
  const inside: T[] = [];
  for (const point of curve) {
    const ms = Date.parse(point.t);
    if (!Number.isFinite(ms)) continue;
    if (ms <= from) carry = point;
    else if (ms <= to) inside.push(point);
  }
  const start = carry
    ? ({ ...carry, t: new Date(from).toISOString() } as T)
    : inside[0];
  if (!start) return [];
  const rest = inside.filter((point) => Date.parse(point.t) > from);
  return [start, ...rest];
}

export function equityYDomain(equities: number[]): { yMin: number; yMax: number } {
  const finite = equities.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { yMin: 0, yMax: 1 };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || Math.max(1, Math.abs(min) * 0.05);
  return { yMin: min - span * 0.08, yMax: max + span * 0.08 };
}

export function equityCurveFromClosed(options: {
  bankroll: number;
  now: Date;
  mtmEquity: number;
  closed: Array<{ at: Date | string | null; pnl: number }>;
}): EquityCurvePoint[] {
  const nowIso = options.now.toISOString();
  const sorted = options.closed
    .map((row) => {
      const at =
        row.at instanceof Date
          ? row.at
          : typeof row.at === "string"
            ? new Date(row.at)
            : null;
      if (!at || Number.isNaN(at.getTime())) return null;
      return { at, pnl: Number.isFinite(row.pnl) ? row.pnl : 0 };
    })
    .filter((row): row is { at: Date; pnl: number } => row !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const startAt = sorted[0]?.at ?? options.now;
  const curve: EquityCurvePoint[] = [{ t: startAt.toISOString(), equity: options.bankroll }];
  let equity = options.bankroll;
  for (const row of sorted) {
    equity += row.pnl;
    curve.push({ t: row.at.toISOString(), equity });
  }
  const last = curve[curve.length - 1];
  if (!last || last.t !== nowIso || Math.abs(last.equity - options.mtmEquity) > 1e-9) {
    curve.push({ t: nowIso, equity: options.mtmEquity });
  }
  return curve;
}
