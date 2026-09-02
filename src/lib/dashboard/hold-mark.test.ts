import { describe, expect, it } from "vitest";
import { stabilizePositionMarks } from "./hold-mark";
import type { DashboardPosition } from "./types";

function pos(partial: Partial<DashboardPosition> & Pick<DashboardPosition, "id" | "status">): DashboardPosition {
  return {
    mode: "PAPER",
    side: "BUY",
    tokenId: "t",
    marketId: "m",
    marketTitle: "Bitcoin",
    marketQuestion: null,
    venueMarketId: "1",
    strategySlug: "fair-value",
    shares: 100,
    avgPrice: 0.4,
    totalCost: 40,
    realizedPnl: 0,
    mark: null,
    markSource: "none",
    unrealizedPnl: null,
    lastPriceHistorical: null,
    exitPrice: null,
    openedAt: "2026-09-01T00:00:00.000Z",
    closedAt: null,
    endDate: null,
    markHeld: false,
    ...partial,
  };
}

describe("stabilizePositionMarks", () => {
  it("never shows uPnL on closed rows even if a book is present", () => {
    const next = [
      pos({
        id: "c1",
        status: "CLOSED",
        mark: 0.17,
        markSource: "ask",
        unrealizedPnl: 36.92,
        realizedPnl: 11.54,
      }),
    ];
    expect(stabilizePositionMarks(undefined, next)[0]).toMatchObject({
      mark: null,
      markSource: "none",
      unrealizedPnl: null,
      realizedPnl: 11.54,
    });
  });

  it("holds the last open mark instead of flashing to no book", () => {
    const prev = [pos({ id: "o1", status: "OPEN", mark: 0.16, markSource: "bid", unrealizedPnl: -24 })];
    const next = [pos({ id: "o1", status: "OPEN", mark: null, markSource: "none", unrealizedPnl: null })];
    const held = stabilizePositionMarks(prev, next)[0];
    expect(held?.mark).toBe(0.16);
    expect(held?.markHeld).toBe(true);
    expect(held?.unrealizedPnl).toBeCloseTo(-24);
  });
});
