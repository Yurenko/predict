import { describe, expect, it } from "vitest";
import { mtmEquity, sumClosedRealized, sumOpenUnrealized } from "./equity";
import { equityCurveFromClosed, sliceEquityCurve, equityWindowForRange, zoomEquityWindow, equityYDomain } from "./equity-curve";

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

describe("equity chart window", () => {
  const curve = [
    { t: "2026-09-18T08:00:00.000Z", equity: 40 },
    { t: "2026-09-18T10:00:00.000Z", equity: 80 },
    { t: "2026-09-18T12:00:00.000Z", equity: 29 },
    { t: "2026-09-18T13:00:00.000Z", equity: 30 },
  ];

  it("carries the last value into the left edge of a zoomed window", () => {
    const sliced = sliceEquityCurve(
      curve,
      Date.parse("2026-09-18T11:00:00.000Z"),
      Date.parse("2026-09-18T13:00:00.000Z"),
    );
    expect(sliced[0]?.equity).toBe(80);
    expect(sliced[0]?.t).toBe("2026-09-18T11:00:00.000Z");
    expect(sliced.map((row) => row.equity)).toEqual([80, 29, 30]);
  });

  it("pins a 24h preset to the latest point, not the all-time spike", () => {
    const window = equityWindowForRange({ curve, range: "24h" });
    expect(window?.toMs).toBe(Date.parse("2026-09-18T13:00:00.000Z"));
    expect(window?.fromMs).toBe(Date.parse("2026-09-18T08:00:00.000Z"));
  });

  it("zooms toward the cursor", () => {
    const zoomed = zoomEquityWindow({
      fromMs: Date.parse("2026-09-18T08:00:00.000Z"),
      toMs: Date.parse("2026-09-18T13:00:00.000Z"),
      factor: 0.5,
      anchorMs: Date.parse("2026-09-18T12:30:00.000Z"),
      minMs: Date.parse("2026-09-18T08:00:00.000Z"),
      maxMs: Date.parse("2026-09-18T13:00:00.000Z"),
    });
    expect(zoomed.toMs - zoomed.fromMs).toBeLessThan(5 * 60 * 60_000);
  });

  it("scales Y to the visible window so an old spike does not flatten today", () => {
    const visible = sliceEquityCurve(
      curve,
      Date.parse("2026-09-18T12:00:00.000Z"),
      Date.parse("2026-09-18T13:00:00.000Z"),
    );
    const domain = equityYDomain(visible.map((row) => row.equity));
    expect(Math.max(...visible.map((row) => row.equity))).toBeLessThan(50);
    expect(domain.yMax).toBeLessThan(50);
  });
});
