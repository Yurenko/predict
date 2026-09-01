import { describe, expect, it } from "vitest";
import { simulateFill } from "./fills";
import type { FillIntent } from "./fills";
import type { BacktestCosts } from "./types";

const costs = (over: Partial<BacktestCosts> = {}): BacktestCosts => ({
  useQuoteFees: true,
  fallbackFeeRateBps: 0,
  simulateSlippage: true,
  simulatePriceImpact: true,
  allowPartialFills: true,
  networkCostUsdt: 0,
  ...over,
});

const buy = (over: Partial<FillIntent> = {}): FillIntent => ({
  side: "BUY",
  requestedNotional: 100,
  bestBid: 0.39,
  bestAsk: 0.4,
  lastPrice: 0.99,
  bidDepth: 50,
  askDepth: 50,
  liquidity: 10_000,
  quote: null,
  costs: costs(),
  maxPriceImpact: 0.05,
  ...over,
});

describe("simulateFill", () => {
  it("fills at the ask and ignores lastPrice", () => {
    const fill = simulateFill(buy());
    expect(fill.ok).toBe(true);
    if (!fill.ok) return;
    expect(fill.price).toBeGreaterThanOrEqual(0.4);
    expect(fill.price).toBeLessThan(0.5);
    expect(fill.price).not.toBe(0.99);
  });

  it("refuses to assume a fee when fallback is null and quote has none", () => {
    const fill = simulateFill(buy({ costs: costs({ fallbackFeeRateBps: null }) }));
    expect(fill).toEqual({ ok: false, reason: "missing_fee_data" });
  });

  it("uses quote feeRateBps when present", () => {
    const fill = simulateFill(
      buy({
        costs: costs({ fallbackFeeRateBps: null }),
        quote: {
          tokenId: "t",
          quotedAt: new Date(),
          averagePrice: 0.4,
          lastPrice: 0.99,
          chance: 0.4,
          feeAmount: null,
          feeRateBps: 100,
          slippageBps: 0,
          priceImpact: 0,
          minReceive: null,
          expireAt: null,
        },
      }),
    );
    expect(fill.ok).toBe(true);
    if (!fill.ok) return;
    expect(fill.fee).toBeCloseTo(fill.notional * 0.01);
  });

  it("partially fills when depth is below requested size", () => {
    const fill = simulateFill(buy({ askDepth: 1, requestedNotional: 100 }));
    expect(fill.ok).toBe(true);
    if (!fill.ok) return;
    expect(fill.partial).toBe(true);
    expect(fill.shares).toBe(1);
  });

  it("skips when partial fills are disabled and depth is insufficient", () => {
    const fill = simulateFill(
      buy({
        askDepth: 1,
        requestedNotional: 100,
        costs: costs({ allowPartialFills: false }),
      }),
    );
    expect(fill).toEqual({ ok: false, reason: "insufficient_depth" });
  });
});
