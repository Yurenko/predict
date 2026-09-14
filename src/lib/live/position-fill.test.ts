import { describe, expect, it } from "vitest";
import { OrderSide, OrderStatus } from "@prisma/client";
import { mapOfficialOrderStatus } from "./status";
import {
  applyLiveFillToPosition,
  completeOfficialFill,
  isLiveDustPosition,
  LIVE_INFLIGHT_STATUSES,
  PAPER_INFLIGHT_STATUSES,
  reservedLivePositionCount,
  shouldDeferLiveEnter,
  type LivePositionSnapshot,
} from "./position-fill";

function open(over: Partial<LivePositionSnapshot> = {}): LivePositionSnapshot {
  return {
    side: OrderSide.BUY,
    shares: 4,
    avgPrice: 0.5,
    totalCost: 2,
    feesPaid: 0,
    networkCostPaid: 0,
    realizedPnl: 0,
    ...over,
  };
}

describe("completeOfficialFill", () => {
  it("derives shares from notional and price when qty is missing", () => {
    const fill = completeOfficialFill({
      notional: 2,
      shares: null,
      price: 0.5,
      fee: 0,
      network: 0,
      fillPct: 1,
      status: OrderStatus.FILLED,
    });
    expect(fill?.shares).toBeCloseTo(4);
    expect(fill?.notional).toBe(2);
  });

  it("returns null when the venue sent no fill quantities", () => {
    expect(
      completeOfficialFill({
        notional: 0,
        shares: 0,
        price: 0.5,
        fee: 0,
        network: 0,
        fillPct: 0,
        status: OrderStatus.FAILED,
      }),
    ).toBeNull();
  });
});

describe("shouldDeferLiveEnter", () => {
  it("blocks a second enter while a live order is still SUBMITTED", () => {
    expect(shouldDeferLiveEnter(false, true)).toBe(true);
    expect(shouldDeferLiveEnter(true, true)).toBe(false);
    expect(shouldDeferLiveEnter(false, false)).toBe(false);
  });
});

describe("reservedLivePositionCount", () => {
  it("counts OPEN rows plus SUBMITTED enters that have no position yet", () => {
    expect(reservedLivePositionCount(["a", "b"], ["c"])).toBe(3);
    expect(reservedLivePositionCount(["a", "a"], ["a"])).toBe(2);
    expect(reservedLivePositionCount([], ["x", "x"])).toBe(1);
    expect(reservedLivePositionCount(["a"], [], 1)).toBe(2);
  });
});

describe("applyLiveFillToPosition", () => {
  it("opens a new long from the first fill", () => {
    const next = applyLiveFillToPosition(
      null,
      { price: 0.5, shares: 4, notional: 2, fee: 0, networkCost: 0, partial: false },
      OrderSide.BUY,
    );
    expect(next.status).toBe("OPEN");
    expect(next.position.shares).toBe(4);
    expect(next.position.avgPrice).toBe(0.5);
  });

  it("averages same-side adds instead of keeping the first ticket size", () => {
    const next = applyLiveFillToPosition(
      open(),
      { price: 0.6, shares: 4, notional: 2.4, fee: 0, networkCost: 0, partial: false },
      OrderSide.BUY,
    );
    expect(next.status).toBe("OPEN");
    expect(next.position.shares).toBe(8);
    expect(next.position.avgPrice).toBeCloseTo(0.55);
    expect(next.position.totalCost).toBeCloseTo(4.4);
  });

  it("closes the book when an opposite fill covers the shares", () => {
    const next = applyLiveFillToPosition(
      open(),
      { price: 0.66, shares: 4, notional: 2.64, fee: 0, networkCost: 0, partial: false },
      OrderSide.SELL,
    );
    expect(next.status).toBe("CLOSED");
    expect(next.closePrice).toBe(0.66);
    expect(next.realizedDelta).toBeCloseTo(0.64);
  });

  it("reduces shares on a partial exit instead of flattening the whole stack", () => {
    const next = applyLiveFillToPosition(
      open({ shares: 8, totalCost: 4 }),
      { price: 0.41, shares: 2, notional: 0.82, fee: 0, networkCost: 0, partial: true },
      OrderSide.SELL,
    );
    expect(next.status).toBe("OPEN");
    expect(next.position.shares).toBe(6);
    expect(next.position.avgPrice).toBe(0.5);
    expect(next.realizedDelta).toBeCloseTo(-0.18);
  });
});


describe("LIVE partial order state", () => {
  it("does not use PARTIALLY_FILLED as a LIVE inflight status", () => {
    expect(LIVE_INFLIGHT_STATUSES.map(String)).not.toContain(OrderStatus.PARTIALLY_FILLED);
    expect(PAPER_INFLIGHT_STATUSES.map(String)).toContain(OrderStatus.PARTIALLY_FILLED);
  });

  it("treats a one-cent flatten residual as dust without closing the position", () => {
    expect(
      isLiveDustPosition({
        rawPayload: { liveFlatten: true },
        shares: 0.02,
        avgPrice: 0.5,
      }),
    ).toBe(true);
  });
});


describe("mapOfficialOrderStatus", () => {
  it("treats Binance CLOSED order history rows as FILLED", () => {
    expect(mapOfficialOrderStatus("CLOSED")).toBe(OrderStatus.FILLED);
  });
});
