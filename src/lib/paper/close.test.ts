import { describe, expect, it } from "vitest";
import { manualExitPrice } from "./close";

describe("manualExitPrice", () => {
  it("sells a long at the bid", () => {
    expect(manualExitPrice({ side: "BUY", bestBid: 0.41, bestAsk: 0.43, chance: 0.99 })).toBe(0.41);
  });

  it("covers a short at the ask", () => {
    expect(manualExitPrice({ side: "SELL", bestBid: 0.41, bestAsk: 0.43, chance: 0.99 })).toBe(0.43);
  });

  it("allows a zero bid as settlement-like book", () => {
    expect(manualExitPrice({ side: "BUY", bestBid: 0, bestAsk: 0.02, chance: 0.01 })).toBe(0);
  });

  it("falls back to chance when the exit side is missing", () => {
    expect(manualExitPrice({ side: "BUY", bestBid: null, bestAsk: 0.4, chance: 0.38 })).toBe(0.38);
  });

  it("returns null when there is no executable side", () => {
    expect(manualExitPrice({ side: "BUY", bestBid: null, bestAsk: 0.4, chance: null })).toBeNull();
  });
});
