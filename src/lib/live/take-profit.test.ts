import { describe, expect, it } from "vitest";
import { shouldStopLoss, shouldTakeProfit, stopLossReason, takeProfitReason } from "./take-profit";

describe("shouldTakeProfit", () => {
  it("locks the screenshot-style winner (0.13 → 0.47)", () => {
    expect(
      shouldTakeProfit({ entryPrice: 0.13, currentPrice: 0.47, timeToExpirySec: 1_440 }),
    ).toBe(true);
    expect(
      shouldTakeProfit({ entryPrice: 0.145, currentPrice: 0.45, timeToExpirySec: 1_440 }),
    ).toBe(true);
  });

  it("does not close a tiny move or a still-cheap mark", () => {
    expect(shouldTakeProfit({ entryPrice: 0.13, currentPrice: 0.22, timeToExpirySec: 1_000 })).toBe(
      false,
    );
    expect(shouldTakeProfit({ entryPrice: 0.5, currentPrice: 0.52, timeToExpirySec: 1_000 })).toBe(
      false,
    );
  });

  it("does not close in the last seconds when the book is dying", () => {
    expect(shouldTakeProfit({ entryPrice: 0.13, currentPrice: 0.47, timeToExpirySec: 10 })).toBe(
      false,
    );
  });

  it("names the lock-in", () => {
    expect(takeProfitReason(0.13, 0.47)).toMatch(/0.470/);
  });
});

describe("shouldStopLoss", () => {
  it("cuts an expensive 1h Up that dropped 15¢", () => {
    expect(shouldStopLoss({ entryPrice: 0.5, currentPrice: 0.35 })).toBe(true);
    expect(shouldStopLoss({ entryPrice: 0.65, currentPrice: 0.25 })).toBe(true);
  });

  it("does not stop a cheap 0.13 entry at 0.25", () => {
    expect(shouldStopLoss({ entryPrice: 0.13, currentPrice: 0.12 })).toBe(false);
    expect(shouldStopLoss({ entryPrice: 0.4, currentPrice: 0.32 })).toBe(false);
  });

  it("names the cut", () => {
    expect(stopLossReason(0.5, 0.35)).toMatch(/0.350/);
  });
});
