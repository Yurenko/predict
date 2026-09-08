import { describe, expect, it } from "vitest";
import { mtmEquity, sumClosedRealized, sumOpenUnrealized } from "./equity";
import { equityCurveFromClosed } from "./equity-curve";

describe("position ledger totals", () => {
  it("does not merge three strategy rows into one PnL", () => {
    const rows = [
      { status: "CLOSED", realizedPnl: 53.13, unrealizedPnl: 0 },
      { status: "CLOSED", realizedPnl: 53.13, unrealizedPnl: 0 },
      { status: "CLOSED", realizedPnl: 53.13, unrealizedPnl: 0 },
    ];
    expect(sumClosedRealized(rows)).toBeCloseTo(159.39);
  });

  it("adds open mark-to-market on top of realized equity", () => {
    const open = sumOpenUnrealized([
      { status: "OPEN", unrealizedPnl: -10 },
      { status: "OPEN", unrealizedPnl: null },
      { status: "CLOSED", unrealizedPnl: 99 },
    ]);
    expect(open.pnl).toBe(-10);
    expect(open.missingMark).toBe(1);
    expect(mtmEquity(1308.44, open.pnl)).toBeCloseTo(1298.44);
  });
});

describe("equityCurveFromClosed", () => {
  it("starts at bankroll and steps up or down after each close", () => {
    const curve = equityCurveFromClosed({
      bankroll: 40,
      now: new Date("2026-09-07T10:00:00.000Z"),
      mtmEquity: 41.5,
      closed: [
        { at: "2026-09-07T08:00:00.000Z", pnl: -2 },
        { at: "2026-09-07T09:00:00.000Z", pnl: 3 },
      ],
    });
    expect(curve[0]?.equity).toBe(40);
    expect(curve[1]?.equity).toBe(38);
    expect(curve[2]?.equity).toBe(41);
    expect(curve[curve.length - 1]?.equity).toBe(41.5);
  });
});
