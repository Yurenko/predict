import type { BacktestMetrics, BacktestTradeResult, EquityPoint } from "@/lib/backtest/types";

export function equityCurveFromTrades(
  bankroll: number,
  trades: BacktestTradeResult[],
): EquityPoint[] {
  const sorted = [...trades].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
  let equity = bankroll;
  const curve: EquityPoint[] = [{ t: new Date(0).toISOString(), equity: bankroll }];
  if (sorted[0]) {
    curve[0] = { t: sorted[0].openedAt.toISOString(), equity: bankroll };
  }
  for (const trade of sorted) {
    equity += trade.netPnl;
    curve.push({ t: trade.closedAt.toISOString(), equity });
  }
  return curve;
}

export function maxDrawdown(curve: EquityPoint[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      dd = Math.max(dd, (peak - point.equity) / peak);
    }
  }
  return dd;
}

function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const s = Math.sqrt(variance);
  return s > 0 ? s : null;
}

export function computeMetrics(
  trades: BacktestTradeResult[],
  curve: EquityPoint[],
  skippedFills: number,
): BacktestMetrics {
  const grossPnl = trades.reduce((sum, trade) => sum + trade.grossPnl, 0);
  const fees = trades.reduce(
    (sum, trade) => sum + trade.fees + trade.slippage + trade.priceImpact,
    0,
  );
  const netPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const winSum = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const lossAbs = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const returns = trades.map((trade) => trade.netPnl);
  const mean = returns.length ? netPnl / returns.length : null;
  const sigma = stdev(returns);
  const downside = stdev(returns.filter((value) => value < 0));

  return {
    netPnl,
    grossPnl,
    fees,
    maxDrawdown: maxDrawdown(curve),
    winRate: trades.length ? wins.length / trades.length : null,
    profitFactor: lossAbs > 0 ? winSum / lossAbs : wins.length ? Infinity : null,
    expectancy: mean,
    sharpe: sigma && mean !== null ? mean / sigma : null,
    sortino: downside && mean !== null ? mean / downside : null,
    tradeCount: trades.length,
    skippedFills,
  };
}
