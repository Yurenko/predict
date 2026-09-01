import { loadBacktestConfigFile } from "@/lib/backtest/config";
import { runBacktest } from "@/lib/backtest/engine";
import { loadReplayEvents } from "@/lib/backtest/load";
import { persistBacktestResult } from "@/lib/backtest/persist";
import { createStrategy, registeredStrategySlugs } from "@/lib/strategy";
import { childLogger } from "@/lib/logger";
import type { BacktestResult } from "@/lib/backtest/types";

const log = childLogger({ component: "backtest-run" });

export async function runBacktestFromFile(configPath: string): Promise<BacktestResult> {
  const config = await loadBacktestConfigFile(configPath);
  const strategy = createStrategy(config.strategy, config.parameters);
  if (!strategy) {
    throw new Error(
      `Strategy "${config.strategy}" is not registered. Available: ${registeredStrategySlugs().join(", ") || "(none)"}.`,
    );
  }

  const { events, quotes } = await loadReplayEvents(config);
  log.info(
    { events: events.length, quotes: quotes.length, strategy: config.strategy },
    "starting backtest replay",
  );

  const result = runBacktest({ events, quotes, strategy, config });
  const saved = await persistBacktestResult(config, result);
  log.info(
    { ...result.metrics, runId: saved.runId, filePath: saved.filePath },
    "backtest complete",
  );
  return result;
}
