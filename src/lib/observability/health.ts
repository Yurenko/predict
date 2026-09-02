import { env, isLiveTradingEnabled } from "@/lib/config/env";
import { prisma } from "@/lib/db/prisma";
import { redis } from "@/lib/db/redis";
import { childLogger } from "@/lib/logger";
import { loadRiskState } from "@/lib/risk/persist";
import { assertNoSecrets } from "@/lib/dashboard/sanitize";
import { deriveAlerts, type ObservabilityAlert } from "@/lib/observability/alerts";
import { snapshotMetrics, type MetricsSnapshot } from "@/lib/observability/metrics";
import { withTimeout } from "@/lib/observability/timeout";
import { CURRENT_PHASE } from "@/lib/types/domain";

const log = childLogger({ component: "health" });

export interface CollectorHeartbeat {
  channel: string;
  lastAt: string | null;
  ageMs: number | null;
  stale: boolean;
}

export interface HealthSnapshot {
  ok: boolean;
  ready: boolean;
  alive: true;
  phase: typeof CURRENT_PHASE;
  service: "bot-pol";
  tradingMode: "PAPER" | "LIVE";
  liveTradingEnabled: boolean;
  hasWallet: boolean;
  hasPaperKeys: boolean;
  hasLiveKeys: boolean;
  database: "ok" | "error";
  redis: "ok" | "error";
  collectors: CollectorHeartbeat[];
  risk: {
    killSwitch: boolean;
    killSwitchReason: string | null;
    staleData: boolean;
    apiErrorBreaker: boolean;
  } | null;
  alerts: ObservabilityAlert[];
  metrics: MetricsSnapshot;
}

export function parseHeartbeat(
  channel: string,
  raw: string | null,
  now: number,
  staleMs: number,
): CollectorHeartbeat {
  if (!raw) {
    return { channel, lastAt: null, ageMs: null, stale: true };
  }
  try {
    const parsed = JSON.parse(raw) as { at?: string };
    const at = parsed.at ? Date.parse(parsed.at) : Number.NaN;
    if (!Number.isFinite(at)) {
      return { channel, lastAt: null, ageMs: null, stale: true };
    }
    const ageMs = now - at;
    return { channel, lastAt: new Date(at).toISOString(), ageMs, stale: ageMs > staleMs };
  } catch {
    return { channel, lastAt: null, ageMs: null, stale: true };
  }
}

export async function loadCollectorHeartbeats(timeoutMs = 1_500): Promise<CollectorHeartbeat[]> {
  try {
    const now = Date.now();
    const keys = await withTimeout(redis.keys("ingest:health:*"), timeoutMs, "redis-keys");
    return Promise.all(
      keys.sort().flatMap((key) => {
        const channel = key.replace(/^ingest:health:/, "");
        if (!isLiveCollectorChannel(channel)) return [];
        return [
          withTimeout(redis.get(key), timeoutMs, "redis-get").then((raw) =>
            parseHeartbeat(channel, raw, now, env.WS_STALE_MS),
          ),
        ];
      }),
    );
  } catch (error) {
    log.warn({ err: String(error) }, "collector heartbeat read failed");
    return [];
  }
}

export function collectorsAreFresh(collectors: CollectorHeartbeat[]): boolean {
  const prediction = collectors.find((row) => row.channel === "prediction.ws.orderbook");
  return Boolean(prediction && !prediction.stale);
}

/** Spot ticker and prediction orderbook streams — not one-shot REST detail calls. */
export function isLiveCollectorChannel(channel: string): boolean {
  return channel === "prediction.ws.orderbook" || channel.startsWith("spot.ws.ticker.");
}

/** Spot ticker WS is up — another process already owns live collection. */
export function spotStreamIsLive(collectors: CollectorHeartbeat[]): boolean {
  return collectors.some((row) => row.channel.startsWith("spot.ws.ticker.") && !row.stale);
}

export async function collectHealth(timeoutMs = 1_500): Promise<HealthSnapshot> {
  const now = Date.now();
  let database: "ok" | "error" = "error";
  let cache: "ok" | "error" = "error";
  let collectors: CollectorHeartbeat[] = [];
  let risk: HealthSnapshot["risk"] = null;

  try {
    const pong = await withTimeout(redis.ping(), timeoutMs, "redis");
    cache = pong === "PONG" ? "ok" : "error";
  } catch (error) {
    log.warn({ err: String(error) }, "redis health failed");
  }

  if (cache === "ok") {
    collectors = await loadCollectorHeartbeats(timeoutMs);
  }

  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, timeoutMs, "postgres");
    database = "ok";
    const state = await withTimeout(loadRiskState(), timeoutMs, "risk-state");
    risk = {
      killSwitch: state.killSwitch,
      killSwitchReason: state.killSwitchReason,
      staleData: state.staleData,
      apiErrorBreaker: state.apiErrorBreaker,
    };
  } catch (error) {
    log.warn({ err: String(error) }, "postgres health failed");
  }

  const hasWallet = env.BINANCE_PREDICTION_WALLET_ADDRESS.trim().length > 0;
  const hasPaperKeys = Boolean(env.BINANCE_PAPER_API_KEY && env.BINANCE_PAPER_API_SECRET);
  const hasLiveKeys = Boolean(env.BINANCE_LIVE_API_KEY && env.BINANCE_LIVE_API_SECRET);
  const alerts = deriveAlerts({
    database,
    redis: cache,
    liveTradingEnabled: isLiveTradingEnabled(),
    hasWallet,
    hasPaperKeys,
    hasLiveKeys,
    killSwitch: risk?.killSwitch ?? false,
    killSwitchReason: risk?.killSwitchReason ?? null,
    staleData: risk?.staleData ?? false,
    apiErrorBreaker: risk?.apiErrorBreaker ?? false,
    collectors,
  });

  const snapshot: HealthSnapshot = {
    ok: database === "ok",
    ready: database === "ok" && cache === "ok",
    alive: true,
    phase: CURRENT_PHASE,
    service: "bot-pol",
    tradingMode: isLiveTradingEnabled() ? "LIVE" : "PAPER",
    liveTradingEnabled: isLiveTradingEnabled(),
    hasWallet,
    hasPaperKeys,
    hasLiveKeys,
    database,
    redis: cache,
    collectors,
    risk,
    alerts,
    metrics: snapshotMetrics(),
  };
  assertNoSecrets(snapshot);
  return snapshot;
}
