import { describe, expect, it } from "vitest";
import { applyRecordedWindow, presetById } from "./catalog";
import { parseBacktestConfig } from "./config";
import { readFileSync } from "node:fs";

describe("backtest catalog", () => {
  it("resolves only known preset ids", () => {
    expect(presetById("momentum-lag")?.file).toBe("configs/backtest.momentum-lag.json");
    expect(presetById("../secret")).toBeNull();
    expect(presetById("configs/backtest.momentum-lag.json")).toBeNull();
  });

  it("replays against a recorded window without walk-forward", () => {
    const raw = JSON.parse(readFileSync("configs/backtest.momentum-lag.json", "utf8")) as unknown;
    const config = applyRecordedWindow(parseBacktestConfig(raw), {
      from: new Date("2026-09-01T12:00:00Z"),
      to: new Date("2026-09-01T13:00:00Z"),
      count: 12,
    });
    expect(config.walkForward).toBe(false);
    expect(config.name).toContain("recorded");
    expect(config.testFrom.toISOString()).toBe("2026-09-01T12:00:00.000Z");
    expect(config.testTo.toISOString()).toBe("2026-09-01T13:00:00.000Z");
    expect(config.trainFrom).toBeNull();
  });
});
