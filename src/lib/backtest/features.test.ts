import { describe, expect, it } from "vitest";
import { appendTick, returnOver, rollingStats } from "./features";

describe("features", () => {
  it("rejects out-of-order ticks", () => {
    const rows = [{ observedAt: new Date("2026-01-01T00:01:00.000Z"), price: 1 }];
    expect(() =>
      appendTick(rows, { observedAt: new Date("2026-01-01T00:00:00.000Z"), price: 2 }),
    ).toThrow(/look-ahead/);
  });

  it("computes returns only from prices at or before now", () => {
    const ticks = [
      { observedAt: new Date("2026-01-01T00:00:00.000Z"), price: 100 },
      { observedAt: new Date("2026-01-01T00:01:00.000Z"), price: 110 },
      { observedAt: new Date("2026-01-01T00:02:00.000Z"), price: 200 },
    ];
    const atOne = new Date("2026-01-01T00:01:00.000Z");
    expect(returnOver(ticks, atOne, 60_000)).toBeCloseTo(0.1);
  });

  it("rolling z-score ignores values after now", () => {
    const values = [
      { observedAt: new Date("2026-01-01T00:00:00.000Z"), value: 0.4 },
      { observedAt: new Date("2026-01-01T00:01:00.000Z"), value: 0.5 },
      { observedAt: new Date("2026-01-01T00:02:00.000Z"), value: 0.9 },
    ];
    const stats = rollingStats(values, new Date("2026-01-01T00:01:00.000Z"), 10);
    expect(stats).not.toBeNull();
    expect(stats?.mean).toBeCloseTo(0.45);
  });
});
