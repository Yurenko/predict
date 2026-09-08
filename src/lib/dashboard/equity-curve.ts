export interface EquityCurvePoint {
  t: string;
  equity: number;
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
