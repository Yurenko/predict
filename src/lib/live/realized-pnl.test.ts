import { describe, expect, it } from "vitest";
import { calculateLiveRealizedPnl, liveSettlementReady } from "./realized-pnl";

function execution(side: "BUY" | "SELL", shares: number, notional: number, fee = 0) {
  return {
    price: shares > 0 ? notional / shares : 0,
    shares,
    usdtAmount: notional,
    order: { side, fees: fee ? [{ amount: fee }] : [] },
  };
}

describe("calculateLiveRealizedPnl", () => {
  it("calculates a normal fully exited position from executions", () => {
    const pnl = calculateLiveRealizedPnl({
      executions: [
        execution("BUY", 2, 1.0),
        execution("SELL", 2, 1.4),
      ],
      rawPayload: {},
      closedAt: new Date("2026-09-14T10:05:00Z"),
      endDate: new Date("2026-09-14T10:10:00Z"),
    });
    expect(pnl).toBeCloseTo(0.4);
  });


  it("does not erase a profitable EXIT just because the market has expired", () => {
    const row = {
      executions: [
        execution("BUY", 2, 1.0),
        execution("SELL", 2, 1.4),
      ],
      rawPayload: { expired: true, settlementReadyAt: "2026-09-14T10:11:00Z" },
      closedAt: new Date("2026-09-14T10:11:00Z"),
      endDate: new Date("2026-09-14T10:10:00Z"),
    };
    expect(liveSettlementReady({ ...row, now: new Date("2026-09-14T10:12:00Z") })).toBe(false);
    expect(calculateLiveRealizedPnl(row, { includeSettlement: false })).toBeCloseTo(0.4);
  });

  it("adds settlement exactly once to the remaining cost", () => {
    const row = {
      executions: [execution("BUY", 2, 1.0)],
      rawPayload: { venueSettlementValue: 0 },
      closedAt: new Date("2026-09-14T10:11:00Z"),
      endDate: new Date("2026-09-14T10:10:00Z"),
    };
    const pnl = calculateLiveRealizedPnl(row, { includeSettlement: true });
    expect(pnl).toBeCloseTo(-1.0);
    expect(pnl).toBeCloseTo(calculateLiveRealizedPnl(row, { includeSettlement: true }));
  });

  it("handles partial exit plus losing settlement without double counting", () => {
    const pnl = calculateLiveRealizedPnl({
      executions: [
        execution("BUY", 2, 1.0),
        execution("SELL", 1.5, 0.9),
      ],
      rawPayload: { venueSettlementValue: 0 },
      closedAt: new Date("2026-09-14T10:11:00Z"),
      endDate: new Date("2026-09-14T10:10:00Z"),
    }, { includeSettlement: true });
    expect(pnl).toBeCloseTo(-0.1 - 0.25);
  });
});

describe("liveSettlementReady", () => {
  it("does not treat expiry time alone as settlement data", () => {
    const end = new Date("2026-09-14T12:00:00.000Z");
    const closed = new Date("2026-09-14T12:00:01.000Z");
    const now = new Date("2026-09-14T12:02:00.000Z");

    expect(
      liveSettlementReady({
        rawPayload: { expired: true, settlementReadyAt: "2026-09-14T12:01:01.000Z" },
        closedAt: closed,
        endDate: end,
        now,
      }),
    ).toBe(false);
  });

  it("accepts a zero settlement value as real Binance settlement data", () => {
    const end = new Date("2026-09-14T12:00:00.000Z");
    const closed = new Date("2026-09-14T12:00:01.000Z");
    const now = new Date("2026-09-14T12:02:00.000Z");

    expect(
      liveSettlementReady({
        rawPayload: {
          expired: true,
          settlementReadyAt: "2026-09-14T12:01:01.000Z",
          venueSettlementValue: 0,
        },
        closedAt: closed,
        endDate: end,
        now,
      }),
    ).toBe(true);
  });
});
