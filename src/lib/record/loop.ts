import { env } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";
import { runRestSyncOnce } from "../../../workers/src/collectors/rest-sync";
import { startPredictionWsCollector } from "../../../workers/src/collectors/prediction-ws";
import { startUnderlyingWsCollector } from "../../../workers/src/collectors/underlying-ws";
import { runPaperOnce } from "../../../workers/src/execution/service";
import {
  closeRunningSessions,
  readRecordControl,
  writeRecordControl,
} from "@/lib/record/control";
import { sampleRecordOnce } from "@/lib/record/sample";
import { sleep } from "@/lib/binance/rate-limit";
import { assertPaperWorkerNotLive } from "@/lib/live/gate";

const log = childLogger({ component: "record-loop" });

const collectorsStarted = globalThis as unknown as {
  __botpolSpotCollector?: boolean;
  __botpolPredictionCollector?: boolean;
  __botpolRestInterval?: boolean;
};

async function rememberError(error: unknown, message: string): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  log.error({ err: detail }, message);
  await writeRecordControl({ lastError: detail });
}

async function startCollectorsIfNeeded(exitOnSignal: boolean): Promise<void> {
  if (!collectorsStarted.__botpolSpotCollector) {
    collectorsStarted.__botpolSpotCollector = true;
    try {
      await startUnderlyingWsCollector({ exitOnSignal });
    } catch (error) {
      collectorsStarted.__botpolSpotCollector = false;
      await rememberError(error, "underlying websocket failed to start");
    }
  }

  if (!collectorsStarted.__botpolPredictionCollector) {
    collectorsStarted.__botpolPredictionCollector = true;
    try {
      await startPredictionWsCollector({ exitOnSignal });
    } catch (error) {
      collectorsStarted.__botpolPredictionCollector = false;
      await rememberError(error, "prediction websocket failed to start");
    }
    log.info("REST market discovery running in background (does not block ticks)");
    void runRestSyncOnce().catch((error: unknown) => {
      void rememberError(error, "REST market discovery failed");
    });
  }

  if (!collectorsStarted.__botpolRestInterval) {
    collectorsStarted.__botpolRestInterval = true;
    setInterval(() => {
      void runRestSyncOnce().catch((error: unknown) => {
        log.warn({ err: String(error) }, "periodic REST metadata discovery failed");
      });
    }, env.COLLECTOR_REST_DISCOVERY_INTERVAL_MS);
  }
}

/**
 * Collect + paper cycle. Never opens a second Node window.
 * CLI worker may install process signals; the dashboard must not.
 */
export async function runRecordLoop(options: { exitOnSignal?: boolean } = {}): Promise<void> {
  const exitOnSignal = options.exitOnSignal !== false;
  log.info(
    { pid: process.pid, liveTradingEnabled: env.LIVE_TRADING_ENABLED, exitOnSignal },
    "starting record loop (spot+prediction collect, paper fills, never placeOrder)",
  );

  await writeRecordControl({ pid: process.pid, lastError: null });
  try {
    assertPaperWorkerNotLive();
  } catch (error) {
    await rememberError(error, "paper disabled while live flags are on");
  }
  void startCollectorsIfNeeded(exitOnSignal).catch((error: unknown) => {
    void rememberError(error, "collectors failed to start");
  });

  if (exitOnSignal) {
    const shutdown = async (signal: string) => {
      log.info({ signal }, "record loop stopping");
      await closeRunningSessions("worker_stop");
      await writeRecordControl({ desired: "stopped", sessionId: null, pid: null });
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  }

  while (true) {
    const control = await readRecordControl();
    if (control.desired === "running" && control.sessionId) {
      try {
        await sampleRecordOnce(control.sessionId);
      } catch (error) {
        await rememberError(error, "record sample failed");
      }
      try {
        const paper = await runPaperOnce();
        await writeRecordControl({
          paper: {
            at: new Date().toISOString(),
            enabled: paper.enabled,
            considered: paper.considered,
            filled: paper.filled,
            skip: paper.skip,
          },
        });
      } catch (error) {
        await rememberError(error, "paper cycle failed");
      }
    }
    await sleep(env.RECORD_LOOP_INTERVAL_MS);
  }
}
