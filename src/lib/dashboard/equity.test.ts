import { describe, expect, it } from "vitest";
import { mtmEquity, sumClosedRealized, sumOpenUnrealized } from "./equity";

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
