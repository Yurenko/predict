import { childLogger } from "@/lib/logger";
import { collectHealth } from "@/lib/observability/health";
import { prometheusText, snapshotMetrics } from "@/lib/observability/metrics";

const log = childLogger({ component: "observe-worker" });

export async function reportObservability(): Promise<void> {
  const health = await collectHealth();
  log.info(
    {
      ready: health.ready,
      database: health.database,
      redis: health.redis,
      alerts: health.alerts,
      collectors: health.collectors,
      counters: snapshotMetrics().counters,
    },
    "observability snapshot (no secrets)",
  );
  if (process.env.LOG_METRICS_PROM === "true") {
    log.info({ prom: prometheusText() }, "prometheus text");
  }
}
