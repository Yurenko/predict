import { describe, expect, it } from "vitest";
import { collectorsAreFresh, isLiveCollectorChannel, parseHeartbeat, spotStreamIsLive } from "./health";

describe("collector freshness", () => {
  const now = Date.parse("2026-09-01T12:00:00.000Z");

  it("treats a live spot ticker as already collected", () => {
    const spot = parseHeartbeat(
      "spot.ws.ticker.BTCUSDT",
      JSON.stringify({ at: "2026-09-01T11:59:59.000Z" }),
      now,
      5_000,
    );
    expect(spot.stale).toBe(false);
    expect(spotStreamIsLive([spot])).toBe(true);
    expect(collectorsAreFresh([spot])).toBe(false);
  });

  it("requires a fresh prediction book for collectorsAreFresh", () => {
    const prediction = parseHeartbeat(
      "prediction.ws.orderbook",
      JSON.stringify({ at: "2026-09-01T11:59:59.000Z" }),
      now,
      5_000,
    );
    expect(collectorsAreFresh([prediction])).toBe(true);
  });

  it("treats REST market.detail as a one-shot, not a live stream", () => {
    expect(isLiveCollectorChannel("prediction.market.detail.3982196")).toBe(false);
    expect(isLiveCollectorChannel("prediction.ws.orderbook")).toBe(true);
    expect(isLiveCollectorChannel("spot.ws.ticker.BTCUSDT")).toBe(true);
  });
});
