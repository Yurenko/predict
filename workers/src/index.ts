/**
 * Worker dispatcher.
 * Trading workers stay out of the Next.js UI process on purpose.
 */
import "dotenv/config";
import { isLiveTradingEnabled } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";
import { CURRENT_PHASE } from "@/lib/types/domain";

const log = childLogger({ component: "worker" });

function printUsage(): void {
  console.log("bot-pol workers");
  console.log("");
  console.log("Usage: npm run worker -- <command>");
  console.log("");
  console.log("Commands:");
  console.log("  collector:live          Prediction + spot WebSockets (recommended)");
  console.log("  collector:prediction    Prediction orderbook WebSocket");
  console.log("  collector:underlying    Spot underlying WebSocket");
  console.log("  collector:rest          Slow REST metadata discovery only");
  console.log("  normalize               Replay data/raw jsonl into snapshots");
  console.log("  backtest [config.json]  Event-driven replay (Phase 4)");
  console.log("  strategy                List research strategies (Phase 5)");
  console.log("  risk                    Risk gates / kill switch status");
  console.log("  paper | execution       Paper trader (Phase 7; never placeOrder)");
  console.log("  record                  Start/stop data recorder (no trading)");
  console.log("  live                    Same Start/Stop loop as the dashboard (placeOrder only after Start)");
  console.log("  observe                 Health / metrics dump (Phase 9)");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "help") {
    printUsage();
    process.exit(0);
  }

  log.info({ command, liveTradingEnabled: isLiveTradingEnabled(), phase: CURRENT_PHASE }, "worker start");

  switch (command) {
    case "collector:live":
      await (await import("./collectors/live")).startLiveCollectors();
      return;
    case "collector:rest":
      await (await import("./collectors/rest-sync")).startRestSynchronizer();
      return;
    case "collector:underlying":
      await (await import("./collectors/underlying-ws")).startUnderlyingWsCollector();
      return;
    case "collector:prediction":
      await (await import("./collectors/prediction-ws")).startPredictionWsCollector();
      return;
    case "normalize":
      await (await import("./normalize")).runNormalizeReplay();
      return;
    case "backtest":
      await (await import("./backtest/engine")).runBacktest(process.argv[3]);
      return;
    case "strategy":
      await (await import("./strategy/engine")).describeStrategies();
      return;
    case "risk":
      await (await import("./risk/engine")).reportRisk();
      return;
    case "paper":
    case "execution":
      await (await import("./execution/service")).startPaperTrader();
      return;
    case "record":
      await (await import("./record")).startRecordWorker();
      return;
    case "live":
      await (await import("./execution/live")).startLiveTrader();
      return;
    case "observe":
      await (await import("./observe")).reportObservability();
      return;
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

void main().catch((error: unknown) => {
  log.error({ err: String(error) }, "worker crashed");
  process.exit(1);
});
