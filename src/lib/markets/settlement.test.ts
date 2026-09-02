import { describe, expect, it } from "vitest";
import { isExpiredAt, settlementPayoff } from "./settlement";

describe("isExpiredAt", () => {
  const now = new Date("2026-09-01T18:52:00.000Z");

  it("prefers a live countdown when the tick carries one", () => {
    expect(isExpiredAt(now, new Date("2026-09-01T19:00:00.000Z"), 0)).toBe(true);
    expect(isExpiredAt(now, new Date("2026-09-01T18:30:00.000Z"))).toBe(true);
    expect(isExpiredAt(now, new Date("2026-09-01T19:00:00.000Z"))).toBe(false);
  });
});

describe("settlementPayoff", () => {
  it("pays 1 on an Up token when the underlying finished higher", () => {
    expect(settlementPayoff({ startPrice: 100, outcomeName: "Up" }, 101)).toBe(1);
    expect(settlementPayoff({ startPrice: 100, outcomeName: "Down" }, 101)).toBe(0);
  });

  it("returns null without a start or underlying print", () => {
    expect(settlementPayoff({ startPrice: null, outcomeName: "Up" }, 101)).toBeNull();
  });
});
