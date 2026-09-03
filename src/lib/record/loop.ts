import { env, isLiveTradingEnabled } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";
import { runRestSyncOnce } from "../../../workers/src/collectors/rest-sync";
import { startPredictionWsCollector } from "../../../workers/src/collectors/prediction-ws";
import { startUnderlyingWsCollector } from "../../../workers/src/collectors/underlying-ws";
import { runPaperOnce } from "../../../workers/src/execution/service";
import { runLiveOnce } from "../../../workers/src/execution/live";
import {
  closeRunningSessions,
  readRecordControl,
  writeRecordControl,
} from "@/lib/record/control";
import { cycleFromLiveResult } from "@/lib/record/execution-mode";
import { ensureLiveRuntime } from "@/lib/record/live-runtime";
import { sampleRecordOnce } from "@/lib/record/sample";
import { writePaperCycle } from "@/lib/paper/cycle";
import { isPidAlive } from "@/lib/record/types";
import { sleep } from "@/lib/binance/rate-limit";

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

async function runSessionCycle(): Promise<void> {
  if (!isLiveTradingEnabled()) {
    const paper = await runPaperOnce();
    await writeRecordControl({
      paper: {
        at: paper.at,
        enabled: paper.enabled,
        considered: paper.considered,
        filled: paper.filled,
        skip: paper.skip,
      },
    });
    return;
  }

  const runtime = await ensureLiveRuntime();
  if (!runtime.ok) {
    const cycle = cycleFromLiveResult({
      enabled: 0,
      considered: 0,
      submitted: 0,
      skip: runtime.skip,
    });
    await writePaperCycle(cycle);
    await writeRecordControl({ paper: cycle });
    return;
  }

  const result = await runLiveOnce(runtime.ctx, runtime.venue);
  const cycle = cycleFromLiveResult(result);
  await writePaperCycle(cycle);
  await writeRecordControl({ paper: cycle });
}

/**
 * Collect + paper or live cycle, gated by dashboard Start/Stop.
 * Live placeOrder runs only while the session is running and both live flags are on.
 * Never opens a second Node window. CLI may install process signals; the dashboard must not.
 */
export async function runRecordLoop(options: { exitOnSignal?: boolean } = {}): Promise<void> {
  const exitOnSignal = options.exitOnSignal !== false;
  const live = isLiveTradingEnabled();
  log.info(
    { pid: process.pid, liveTradingEnabled: live, exitOnSignal },
    live
      ? "starting record loop (collect + live placeOrder only after Start)"
      : "starting record loop (spot+prediction collect, paper fills, never placeOrder)",
  );

  const existing = await readRecordControl();
  if (existing.pid && existing.pid !== process.pid && isPidAlive(existing.pid)) {
    if (exitOnSignal) {
      log.warn({ existingPid: existing.pid }, "another record loop is already running; exit");
      return;
    }
  }

  await writeRecordControl({ pid: process.pid, lastError: null });
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
        await runSessionCycle();
      } catch (error) {
        await rememberError(error, live ? "live cycle failed" : "paper cycle failed");
      }
    }
    await sleep(env.RECORD_LOOP_INTERVAL_MS);
  }
}
