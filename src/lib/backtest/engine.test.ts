import { describe, expect, it } from "vitest";
import { runBacktest } from "./engine";
import { createCallbackStrategy } from "@/lib/strategy/registry";
import type { BacktestConfig, MarketTick, ReplayEvent } from "./types";
import type { StrategyContext } from "@/lib/types/domain";

function config(over: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    name: "test",
    strategy: "engine-smoke",
    trainFrom: null,
    trainTo: null,
    validationFrom: null,
    validationTo: null,
    testFrom: new Date("2026-01-01T00:00:00.000Z"),
    testTo: new Date("2026-01-01T01:00:00.000Z"),
    walkForward: false,
    walkForwardTrainDays: 14,
    walkForwardTestDays: 7,
    walkForwardStepDays: 7,
    lookbackMinutes: 15,
    rollingWindow: 60,
    parameters: {},
    costs: {
      useQuoteFees: true,
      fallbackFeeRateBps: 0,
      simulateSlippage: true,
      simulatePriceImpact: true,
      allowPartialFills: true,
      networkCostUsdt: 0,
    },
    bankrollUsdt: 1000,
    maxPositionPct: 5,
    maxSimultaneousPositions: 5,
    minTimeToExpirySec: 0,
    minLiquidityUsdt: 0,
    maxPriceImpact: 0.05,
    safetyMargin: 0.005,
    ...over,
  };
}

function market(
  at: string,
  over: Partial<MarketTick> = {},
): ReplayEvent {
  const observedAt = new Date(at);
  return {
    kind: "market",
    at: observedAt,
    tick: {
      observedAt,
      marketId: "m1",
      venueMarketId: "42",
      outcomeId: "o1",
      tokenId: "yes-1",
      outcomeName: "Yes",
      symbol: "BTCUSDT",
      endDate: new Date("2026-01-01T02:00:00.000Z"),
      startDate: null,
      windowDurationSec: null,
      startPrice: 100,
      bestBid: 0.39,
      bestAsk: 0.4,
      midPrice: 0.395,
      chance: 0.395,
      lastPrice: 0.99,
      spread: 0.01,
      liquidity: 5000,
      bidDepth: 100,
      askDepth: 100,
      timeToExpirySec: 3600,
      ...over,
    },
  };
}

function underlying(at: string, price: number): ReplayEvent {
  const observedAt = new Date(at);
  return {
    kind: "underlying",
    at: observedAt,
    tick: {
      observedAt,
      symbol: "BTCUSDT",
      price,
      bid: price - 1,
      ask: price + 1,
      volume: 1,
    },
  };
}

describe("runBacktest", () => {
  it("never fills lastPrice and records net pnl after costs", () => {
    const strategy = createCallbackStrategy("s", (ctx) => {
      if (ctx.now.toISOString() === "2026-01-01T00:00:00.000Z") {
        return {
          strategyId: "s",
          marketId: ctx.marketId,
          timestamp: ctx.now,
          direction: "BUY",
          marketProbability: ctx.marketProbability,
          fairProbability: 0.5,
          grossEdge: 0.1,
          estimatedFees: 0,
          estimatedSlippage: 0,
          estimatedPriceImpact: 0,
          netEdge: 0.1,
          confidence: 1,
          reason: "buy",
          riskChecks: [],
        };
      }
      if (ctx.now.toISOString() === "2026-01-01T00:10:00.000Z") {
        return {
          strategyId: "s",
          marketId: ctx.marketId,
          timestamp: ctx.now,
          direction: "EXIT",
          marketProbability: ctx.marketProbability,
          fairProbability: 0.5,
          grossEdge: 0,
          estimatedFees: 0,
          estimatedSlippage: 0,
          estimatedPriceImpact: 0,
          netEdge: 0,
          confidence: 1,
          reason: "exit",
          riskChecks: [],
        };
      }
      return null;
    });

    const result = runBacktest({
      strategy,
      config: config(),
      events: [
        market("2026-01-01T00:00:00.000Z"),
        market("2026-01-01T00:10:00.000Z", { bestBid: 0.5, bestAsk: 0.51, lastPrice: 0.99 }),
      ],
    });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.entryPrice).toBeLessThan(0.5);
    expect(trade.entryPrice).not.toBe(0.99);
    expect(trade.netPnl).toBe(trade.grossPnl - trade.fees - trade.slippage - trade.priceImpact);
  });

  it("does not expose future underlying prices in features", () => {
    const seen: StrategyContext[] = [];
    const strategy = createCallbackStrategy("s", (ctx) => {
      seen.push(ctx);
      return null;
    });

    runBacktest({
      strategy,
      config: config(),
      events: [
        underlying("2026-01-01T00:00:00.000Z", 100),
        market("2026-01-01T00:01:00.000Z"),
        underlying("2026-01-01T00:02:00.000Z", 200),
      ],
    });

    const atOne = seen.find((ctx) => ctx.now.toISOString() === "2026-01-01T00:01:00.000Z");
    expect(atOne?.underlyingPrice).toBe(100);
    expect(atOne?.features.underlyingReturn1m).toBeCloseTo(0);
  });

  it("skips entries outside the test window in walk-forward folds", () => {
    const strategy = createCallbackStrategy("s", (ctx) => ({
      strategyId: "s",
      marketId: ctx.marketId,
      timestamp: ctx.now,
      direction: ctx.now.toISOString().startsWith("2026-01-20") ? "BUY" : "BUY",
      marketProbability: ctx.marketProbability,
      fairProbability: 0.5,
      grossEdge: 0.1,
      estimatedFees: 0,
      estimatedSlippage: 0,
      estimatedPriceImpact: 0,
      netEdge: 0.1,
      confidence: 1,
      reason: "buy",
      riskChecks: [],
    }));

    const result = runBacktest({
      strategy,
      config: config({
        testFrom: new Date("2026-01-01T00:00:00.000Z"),
        testTo: new Date("2026-01-29T00:00:00.000Z"),
        walkForward: true,
        walkForwardTrainDays: 14,
        walkForwardTestDays: 7,
        walkForwardStepDays: 7,
        minTimeToExpirySec: 0,
      }),
      events: [
        market("2026-01-05T00:00:00.000Z", {
          endDate: new Date("2026-03-01T00:00:00.000Z"),
          timeToExpirySec: 1_000_000,
        }),
        market("2026-01-05T00:05:00.000Z", {
          bestBid: 0.5,
          bestAsk: 0.51,
          endDate: new Date("2026-03-01T00:00:00.000Z"),
          timeToExpirySec: 1_000_000,
        }),
        market("2026-01-20T00:00:00.000Z", {
          endDate: new Date("2026-03-01T00:00:00.000Z"),
          timeToExpirySec: 1_000_000,
        }),
        market("2026-01-20T00:05:00.000Z", {
          bestBid: 0.5,
          bestAsk: 0.51,
          endDate: new Date("2026-03-01T00:00:00.000Z"),
          timeToExpirySec: 1_000_000,
        }),
      ],
    });

    expect(result.trades.every((trade) => trade.openedAt.getUTCDate() !== 5)).toBe(true);
    expect(result.trades.some((trade) => trade.openedAt.getUTCDate() === 20)).toBe(true);
  });

  it("settles Yes with underlying at or before expiry, not after", () => {
    const strategy = createCallbackStrategy("s", (ctx) => {
      if (ctx.now.toISOString() === "2026-01-01T00:00:00.000Z") {
        return {
          strategyId: "s",
          marketId: ctx.marketId,
          timestamp: ctx.now,
          direction: "BUY",
          marketProbability: ctx.marketProbability,
          fairProbability: 0.5,
          grossEdge: 0.1,
          estimatedFees: 0,
          estimatedSlippage: 0,
          estimatedPriceImpact: 0,
          netEdge: 0.1,
          confidence: 1,
          reason: "buy",
          riskChecks: [],
        };
      }
      return null;
    });

    const expiry = new Date("2026-01-01T00:30:00.000Z");
    const result = runBacktest({
      strategy,
      config: config({ testTo: new Date("2026-01-01T01:00:00.000Z") }),
      events: [
        underlying("2026-01-01T00:00:00.000Z", 110),
        market("2026-01-01T00:00:00.000Z", { startPrice: 100, endDate: expiry, timeToExpirySec: 1800 }),
        underlying("2026-01-01T00:29:00.000Z", 110),
        market("2026-01-01T00:30:00.000Z", {
          startPrice: 100,
          endDate: expiry,
          timeToExpirySec: 0,
          bestBid: 0.01,
          bestAsk: 0.02,
        }),
        underlying("2026-01-01T00:45:00.000Z", 50),
      ],
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.exitPrice).toBe(1);
    expect(result.trades[0]?.reason).toBe("expired");
  });

  it("does not open when fee data is missing and fallback is null", () => {
    const strategy = createCallbackStrategy("s", (ctx) => ({
      strategyId: "s",
      marketId: ctx.marketId,
      timestamp: ctx.now,
      direction: "BUY",
      marketProbability: ctx.marketProbability,
      fairProbability: 0.5,
      grossEdge: 0.1,
      estimatedFees: 0,
      estimatedSlippage: 0,
      estimatedPriceImpact: 0,
      netEdge: 0.1,
      confidence: 1,
      reason: "buy",
      riskChecks: [],
    }));

    const result = runBacktest({
      strategy,
      config: config({
        costs: {
          useQuoteFees: true,
          fallbackFeeRateBps: null,
          simulateSlippage: true,
          simulatePriceImpact: true,
          allowPartialFills: true,
          networkCostUsdt: 0,
        },
      }),
      events: [market("2026-01-01T00:00:00.000Z")],
    });

    expect(result.trades).toHaveLength(0);
    expect(result.folds[0]?.skipped[0]?.reason).toBe("missing_fee_data");
  });
});
