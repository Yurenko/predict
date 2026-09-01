import { startUnderlyingWsCollector } from "./underlying-ws";
import { startPredictionWsCollector } from "./prediction-ws";
import { runRestSyncOnce } from "./rest-sync";
import { env } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";

const log = childLogger({ component: "collector-live" });

/**
 * Realtime path: prediction orderbook WSS + spot ticker WSS.
 * REST is metadata discovery only, on a slow interval — never order-book polling.
 */
export async function startLiveCollectors(): Promise<void> {
  log.info("starting websocket collectors (prediction aggregated orderbook + spot tickers)");

  try {
    await runRestSyncOnce();
  } catch (error) {
    log.warn({ err: String(error) }, "initial REST metadata discovery skipped");
  }

  await startPredictionWsCollector();
  await startUnderlyingWsCollector();

  setInterval(() => {
    void runRestSyncOnce().catch((error: unknown) => {
      log.warn({ err: String(error) }, "periodic REST metadata discovery failed");
    });
  }, env.COLLECTOR_REST_DISCOVERY_INTERVAL_MS);
}
