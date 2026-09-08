import { describe, expect, it } from "vitest";
import {
  canLiveEnterNotional,
  clipLiveOrderNotional,
  isFreshLiveBook,
  liveExitMark,
  liveFlattenExitPrice,
  liveFlattenNotional,
  liveExitSellNotionals,
  liveExitCoverNotional,
  maxLiveEnterNotional,
  maxLiveOrderNotional,
} from "./notional";

const bank = { bankrollUsdt: 40, maxPositionPct: 5 };

describe("live notional cap", () => {
  it("sizes enter at bankroll × maxPositionPct ($2 on a $40 / 5% book)", () => {
    expect(maxLiveEnterNotional(bank)).toBeCloseTo(2);
  });

  it("does not cap an exit so a stacked book can flatten in one ticket", () => {
    expect(maxLiveOrderNotional({ action: "EXIT", ...bank })).toBe(Number.POSITIVE_INFINITY);
  });

  it("clips only enters; exits keep the full shares × mark request", () => {
    expect(
      clipLiveOrderNotional({ action: "EXIT", requested: 20.58, ...bank }),
    ).toBeCloseTo(20.58);
    expect(
      clipLiveOrderNotional({ action: "ENTER", requested: 16.36, ...bank }),
    ).toBeCloseTo(2);
  });
});

describe("liveFlattenNotional", () => {
  it("sizes a long flatten from leftover shares × bid, not a chip of the stack", () => {
    const flat = liveFlattenNotional({
      localShares: 14.03,
      exitPrice: 0.17,
      avgPrice: 0.1426,
    });
    expect(flat.shares).toBeCloseTo(14.03);
    expect(flat.notional).toBeCloseTo(2.3851);
  });

  it("does not quote original cost after a partial — that exceeds wallet shares", () => {
    const flat = liveFlattenNotional({
      localShares: 0.96,
      exitPrice: 0.44,
      avgPrice: 0.6465,
      totalCost: 1.66,
    });
    expect(flat.notional).toBeCloseTo(0.4224);
    expect(flat.notional).toBeLessThan(1.5);
  });

  it("uses ONGOING venue shares when present", () => {
    const flat = liveFlattenNotional({
      localShares: 2.25,
      venueTradableShares: 11.64,
      exitPrice: 0.17,
      avgPrice: 0.14,
    });
    expect(flat.shares).toBeCloseTo(11.64);
    expect(flat.notional).toBeGreaterThan(1.5);
  });

  it("does not sell when venue ONGOING shares are 0", () => {
    const flat = liveFlattenNotional({
      localShares: 11.64,
      venueTradableShares: 0,
      exitPrice: 0.17,
      avgPrice: 0.14,
    });
    expect(flat.shares).toBe(0);
    expect(flat.notional).toBe(0);
  });
});

describe("liveExitMark", () => {
  it("sells a long on the bid and buys back a short on the ask", () => {
    expect(liveExitMark({ positionSide: "BUY", bestBid: 0.17, bestAsk: 0.19, avgPrice: 0.14 })).toBe(
      0.17,
    );
    expect(liveExitMark({ positionSide: "SELL", bestBid: 0.17, bestAsk: 0.19, avgPrice: 0.14 })).toBe(
      0.19,
    );
  });
});

describe("liveFlattenExitPrice", () => {
  it("does not size a long SELL off a stale low bid when ask is higher", () => {
    const shares = 2 / 0.74;
    const aggressive = liveFlattenExitPrice({
      positionSide: "BUY",
      bestBid: 0.63,
      bestAsk: 0.87,
      lastPrice: 0.87,
      avgPrice: 0.74,
      aggressive: true,
    });
    const conservative = liveFlattenExitPrice({
      positionSide: "BUY",
      bestBid: 0.63,
      bestAsk: 0.87,
      lastPrice: 0.87,
      avgPrice: 0.74,
      aggressive: false,
    });
    expect(conservative).toBe(0.63);
    expect(aggressive).toBe(0.87);
    expect(liveFlattenNotional({ localShares: shares, exitPrice: aggressive, avgPrice: 0.74 }).notional).toBeCloseTo(
      shares * 0.87,
    );
  });
});

describe("liveExitSellNotionals", () => {
  it("sizes a cheap Down token from the book, not shares × $1", () => {
    const shares = 2 / 0.15;
    const amounts = liveExitSellNotionals({
      shares,
      bestBid: 0.03,
      bestAsk: 0.04,
      lastPrice: 0.03,
      avgPrice: 0.15,
    });
    expect(Math.min(...amounts)).toBeCloseTo(shares * 0.03);
    expect(Math.max(...amounts)).toBeCloseTo(shares * 0.15);
    expect(Math.max(...amounts)).toBeLessThan(shares * 0.5);
  });

  it("covers leftover shares at the quoted fill instead of oversizing", () => {
    expect(liveExitCoverNotional(13.33, 0.03)).toBeCloseTo(0.3999);
    expect(liveExitCoverNotional(2.7, 0.87)).toBeCloseTo(2.349);
  });
});

describe("canLiveEnterNotional", () => {
  it("skips ENTER when the wallet is unknown or short of ticket plus buffer", () => {
    expect(canLiveEnterNotional(null, 2)).toBe(false);
    expect(canLiveEnterNotional(2, 2)).toBe(false);
    expect(canLiveEnterNotional(2.05, 2)).toBe(true);
    expect(canLiveEnterNotional(1.4, 2)).toBe(false);
  });
});

describe("isFreshLiveBook", () => {
  it("rejects the ~20s stale websocket book that undersizes EXIT", () => {
    expect(isFreshLiveBook(2_000)).toBe(true);
    expect(isFreshLiveBook(19_795)).toBe(false);
  });
});
