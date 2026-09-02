import { NextRequest } from "next/server";
import { childLogger } from "@/lib/logger";
import { assertNoSecrets, redactCredentialMentions } from "@/lib/dashboard/sanitize";
import { loadDashboard } from "@/lib/dashboard/load";
import {
  applyRecordedWindow,
  BACKTEST_PRESETS,
  loadMarketSnapshotWindow,
  loadPresetConfig,
  presetById,
} from "@/lib/backtest/catalog";
import { runBacktestFromConfig } from "@/lib/backtest/run";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const log = childLogger({ component: "dashboard-backtest" });

export async function GET() {
  const window = await loadMarketSnapshotWindow().catch(() => null);
  const payload = {
    presets: BACKTEST_PRESETS.map((row) => ({
      id: row.id,
      label: row.label,
      strategy: row.strategy,
    })),
    snapshots: window
      ? { count: window.count, from: window.from.toISOString(), to: window.to.toISOString() }
      : { count: 0, from: null, to: null },
  };
  assertNoSecrets(payload);
  return Response.json(payload);
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const id =
    body && typeof body === "object" && "id" in body ? String((body as { id: unknown }).id) : "";
  const useRecorded =
    body && typeof body === "object" && "useRecorded" in body
      ? Boolean((body as { useRecorded: unknown }).useRecorded)
      : true;
  if (!presetById(id)) {
    return Response.json({ error: "unknown preset" }, { status: 400 });
  }

  try {
    let config = await loadPresetConfig(id);
    if (useRecorded) {
      const window = await loadMarketSnapshotWindow();
      if (!window) {
        return Response.json(
          {
            error:
              "Немає prediction знімків у базі. Бектест читає історію книги, не BTC/ETH/SOL. Натисніть Старт на Огляді й зачекайте, поки у Ринках з’являться bid/ask.",
          },
          { status: 422 },
        );
      }
      config = applyRecordedWindow(config, window);
    }
    const result = await runBacktestFromConfig(config);
    const dashboard = await loadDashboard();
    const payload = {
      ok: true,
      name: config.name,
      strategy: config.strategy,
      trades: result.trades.length,
      netPnl: result.metrics.netPnl,
      eventsHint:
        result.trades.length === 0
          ? "Прогін завершено, угод 0 — у вікні не було входу по правилах стратегії або книга порожня."
          : null,
      dashboard,
    };
    assertNoSecrets(payload);
    return Response.json(payload);
  } catch (error) {
    const message = redactCredentialMentions(error instanceof Error ? error.message : String(error));
    log.warn({ err: message, id }, "dashboard backtest failed");
    return Response.json({ error: message }, { status: 500 });
  }
}
