import { runBacktestFromFile } from "@/lib/backtest/run";

/**
 * Event-driven replay engine.
 * Timestamp-ordered snapshots, no look-ahead, book fills (not lastPrice),
 * fees/slippage/impact/partial fills, optional walk-forward.
 */
export async function runBacktest(configPath?: string): Promise<void> {
  const path = configPath ?? "configs/backtest.engine-smoke.json";
  await runBacktestFromFile(path);
}
