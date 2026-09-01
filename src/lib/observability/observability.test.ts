import { describe, expect, it, beforeEach } from "vitest";
import { deriveAlerts } from "./alerts";
import {
  inc,
  prometheusText,
  resetMetrics,
  seriesKey,
  setGauge,
  snapshotMetrics,
} from "./metrics";

describe("metrics", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("counts labeled series and renders prometheus text", () => {
    inc("ws.reconnect", { stream: "prediction" });
    inc("ws.reconnect", { stream: "prediction" });
    setGauge("kill_switch", 1);
    const snap = snapshotMetrics();
    expect(snap.counters[seriesKey("ws.reconnect", { stream: "prediction" })]).toBe(2);
    expect(snap.gauges.kill_switch).toBe(1);
    const text = prometheusText(snap);
    expect(text).toContain("botpol_ws_reconnect{stream=\"prediction\"} 2");
    expect(text).toContain("botpol_kill_switch 1");
    expect(text).not.toMatch(/API_SECRET|apiKey/);
  });
});

describe("deriveAlerts", () => {
  const base = {
    database: "ok" as const,
    redis: "ok" as const,
    liveTradingEnabled: false,
    hasWallet: true,
    hasPaperKeys: true,
    hasLiveKeys: false,
    killSwitch: false,
    killSwitchReason: null,
    staleData: false,
    apiErrorBreaker: false,
    collectors: [] as Array<{ channel: string; ageMs: number | null; stale: boolean }>,
  };

  it("raises kill switch and stale collector alerts", () => {
    const alerts = deriveAlerts({
      ...base,
      killSwitch: true,
      killSwitchReason: "max_daily_loss",
      collectors: [{ channel: "prediction.ws.orderbook", ageMs: 60_000, stale: true }],
    });
    expect(alerts.map((item) => item.code)).toEqual(
      expect.arrayContaining(["kill_switch", "collector_stale"]),
    );
  });

  it("is quiet when dependencies are healthy", () => {
    expect(deriveAlerts(base)).toEqual([]);
  });
});
