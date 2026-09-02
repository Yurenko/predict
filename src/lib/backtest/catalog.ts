import { loadBacktestConfigFile } from "@/lib/backtest/config";
import { prisma } from "@/lib/db/prisma";
import type { BacktestConfig } from "@/lib/backtest/types";

export const BACKTEST_PRESETS = [
  {
    id: "momentum-lag",
    file: "configs/backtest.momentum-lag.json",
    label: "Underlying Momentum Lag",
    strategy: "underlying-momentum-lag",
  },
  {
    id: "mean-reversion",
    file: "configs/backtest.example.json",
    label: "Mean Reversion",
    strategy: "mean-reversion",
  },
  {
    id: "fair-value",
    file: "configs/backtest.fair-value.json",
    label: "Fair Value",
    strategy: "fair-value",
  },
] as const;

export type BacktestPresetId = (typeof BACKTEST_PRESETS)[number]["id"];

export function presetById(id: string): (typeof BACKTEST_PRESETS)[number] | null {
  return BACKTEST_PRESETS.find((row) => row.id === id) ?? null;
}

export interface SnapshotWindow {
  from: Date;
  to: Date;
  count: number;
}

export async function loadMarketSnapshotWindow(): Promise<SnapshotWindow | null> {
  const count = await prisma.marketSnapshot.count();
  if (count === 0) return null;
  const [first, last] = await Promise.all([
    prisma.marketSnapshot.findFirst({
      orderBy: { observedAt: "asc" },
      select: { observedAt: true },
    }),
    prisma.marketSnapshot.findFirst({
      orderBy: { observedAt: "desc" },
      select: { observedAt: true },
    }),
  ]);
  if (!first || !last) return null;
  return { from: first.observedAt, to: last.observedAt, count };
}

export function applyRecordedWindow(config: BacktestConfig, window: SnapshotWindow): BacktestConfig {
  const to =
    window.to.getTime() > window.from.getTime()
      ? window.to
      : new Date(window.from.getTime() + 1000);
  return {
    ...config,
    name: `${config.name}-recorded`,
    trainFrom: null,
    trainTo: null,
    validationFrom: null,
    validationTo: null,
    testFrom: window.from,
    testTo: to,
    walkForward: false,
  };
}

export async function loadPresetConfig(id: string): Promise<BacktestConfig> {
  const preset = presetById(id);
  if (!preset) {
    throw new Error("unknown_preset");
  }
  return loadBacktestConfigFile(preset.file);
}
