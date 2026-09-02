import { describe, expect, it } from "vitest";
import { keepLastExecutablePrices, lastExecutableSides } from "./orderbook-merge";

describe("keepLastExecutablePrices", () => {
  it("does not let an empty snapshot wipe a live bid/ask", () => {
    const merged = keepLastExecutablePrices(
      { bestBid: "0.16", bestAsk: "0.17", ts: 1 },
      { bestBid: null, bestAsk: null, ts: 2 },
    );
    expect(merged).toEqual({ bestBid: "0.16", bestAsk: "0.17", ts: 2 });
  });

  it("updates when the new side is executable", () => {
    const merged = keepLastExecutablePrices(
      { bestBid: "0.16", bestAsk: "0.17" },
      { bestBid: "0.12", bestAsk: null },
    );
    expect(merged.bestBid).toBe("0.12");
    expect(merged.bestAsk).toBe("0.17");
  });
});

describe("lastExecutableSides", () => {
  it("walks past empty newest snapshots", () => {
    const sides = lastExecutableSides([
      { bestBid: null, bestAsk: null, lastPrice: null },
      { bestBid: "0.16", bestAsk: "0.18", lastPrice: "0.99" },
    ]);
    expect(sides).toEqual({ bestBid: 0.16, bestAsk: 0.18, lastPrice: 0.99 });
  });
});
