import { describe, expect, it } from "vitest";
import { calculateLiveRealizedPnl } from "./realized-pnl";

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
