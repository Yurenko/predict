import { describe, expect, it } from "vitest";
import { expiryExitPrice, settlementFill } from "./expiry";
import { paperExitPnl } from "./action";
import {
  paperFillReady,
  paperSettleAt,
  paperSettlementReady,
  PAPER_FILL_DELAY_MS,
  PAPER_SETTLEMENT_DELAY_MS,
} from "./delays";
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

describe("delayed paper fill", () => {
  it("waits one paper cycle before the virtual fill lands", () => {
    const submittedAt = new Date("2026-01-01T00:00:00.000Z");
    expect(paperFillReady(submittedAt, submittedAt)).toBe(false);
    expect(
      paperFillReady(submittedAt, new Date(submittedAt.getTime() + PAPER_FILL_DELAY_MS - 1)),
    ).toBe(false);
    expect(
      paperFillReady(submittedAt, new Date(submittedAt.getTime() + PAPER_FILL_DELAY_MS)),
    ).toBe(true);
  });
});

describe("delayed paper settlement", () => {
  it("does not pay 0/1 until settleAt", () => {
    const closedAt = new Date("2026-01-01T00:00:00.000Z");
    const raw = { expired: true, settleAt: paperSettleAt(closedAt).toISOString() };
    expect(paperSettlementReady(raw, closedAt)).toBe(false);
    expect(
      paperSettlementReady(raw, new Date(closedAt.getTime() + PAPER_SETTLEMENT_DELAY_MS - 1)),
    ).toBe(false);
    expect(
      paperSettlementReady(raw, new Date(closedAt.getTime() + PAPER_SETTLEMENT_DELAY_MS)),
    ).toBe(true);
    expect(paperSettlementReady({ ...raw, closePrice: 1 }, new Date(closedAt.getTime() + 60_000))).toBe(
      false,
    );
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
