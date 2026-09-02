import { describe, expect, it } from "vitest";
import { expiryExitPrice, settlementFill } from "./expiry";
import { paperExitPnl } from "./action";
import { OrderSide } from "@prisma/client";

describe("expiryExitPrice", () => {
  it("settles an Up token at 1 when the underlying finished higher", () => {
    expect(
      expiryExitPrice({
        startPrice: 77500,
        outcomeName: "Up",
        underlyingPrice: 77600,
        side: "BUY",
        bestBid: 0.05,
        bestAsk: 0.06,
        chance: 0.05,
        avgPrice: 0.25,
      }),
    ).toBe(1);
  });

  it("falls back to the last bid when settlement is unknown", () => {
    expect(
      expiryExitPrice({
        startPrice: null,
        outcomeName: "Up",
        underlyingPrice: null,
        side: "BUY",
        bestBid: 0.05,
        bestAsk: 0.06,
        chance: 0.04,
        avgPrice: 0.25,
      }),
    ).toBe(0.05);
  });
});

describe("settlementFill", () => {
  it("allows a $0 binary settlement so a losing long can close", () => {
    const fill = settlementFill(200, 0);
    expect(fill.ok).toBe(true);
    expect(fill.price).toBe(0);
    expect(fill.notional).toBe(0);
    expect(paperExitPnl({ side: OrderSide.BUY, avgPrice: 0.25, shares: 200 }, fill)).toBeCloseTo(-50);
  });
});
