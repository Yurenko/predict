import { describe, expect, it } from "vitest";
import { walkForwardWindows, historyStart } from "./windows";

describe("walkForwardWindows", () => {
  it("emits contiguous train/test folds without overlapping test into train", () => {
    const windows = walkForwardWindows({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-29T00:00:00.000Z"),
      trainDays: 14,
      testDays: 7,
      stepDays: 7,
    });
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) {
      expect(window.trainTo.getTime()).toBe(window.testFrom.getTime());
      expect(window.testTo.getTime()).toBeGreaterThan(window.testFrom.getTime());
      expect(window.testTo.getTime()).toBeLessThanOrEqual(new Date("2026-01-29T00:00:00.000Z").getTime());
    }
  });
});

describe("historyStart", () => {
  it("uses the earlier of trainFrom and lookback", () => {
    const testFrom = new Date("2026-02-01T00:00:00.000Z");
    const trainFrom = new Date("2026-01-01T00:00:00.000Z");
    const start = historyStart({ trainFrom, testFrom, lookbackMinutes: 15 });
    expect(start.toISOString()).toBe(trainFrom.toISOString());
  });
});
