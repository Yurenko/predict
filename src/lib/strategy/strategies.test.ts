import { describe, expect, it } from "vitest";
import type { StrategyContext } from "@/lib/types/domain";
import {
  createMomentumLagStrategy,
  shouldIgnoreTape,
  spotWindowSide,
  tapeHorizon,
  tapeLookbackSec,
} from "./momentum-lag";
import { createMeanReversionStrategy } from "./mean-reversion";
import { createFairValueStrategy } from "./fair-value";
import { evaluateStrategies, loadResearchStrategies } from "./evaluate";
import { liveStrategyParams } from "@/lib/live/binary-mode";
import { estimateCosts } from "./common";
import "./index";

function ctx(over: Partial<StrategyContext> = {}): StrategyContext {
  return {
    now: new Date("2026-01-01T00:00:00.000Z"),
    marketId: "m1",
    tokenId: "yes-1",
    marketProbability: 0.45,
    executableProbability: 0.46,
    lastPrice: 0.99,
    bestBid: 0.40,
    bestAsk: 0.42,
    liquidity: 5000,
    spread: 0.02,
    timeToExpirySec: 240,
    windowDurationSec: 300,
    underlyingSymbol: "BTCUSDT",
    underlyingPrice: 100,
    startPrice: 100,
    outcomeName: "Up",
    volume: 1,
    features: {
      underlyingReturn1m: null,
      underlyingReturn2m: null,
      underlyingReturn5m: null,
      underlyingReturn15m: null,
      probabilityMean: null,
      probabilityStd: null,
      probabilityZ: null,
    },
    quote: null,
    ...over,
    features: {
      underlyingReturn1m: null,
      underlyingReturn2m: null,
      underlyingReturn5m: null,
      underlyingReturn15m: null,
      probabilityMean: null,
      probabilityStd: null,
      probabilityZ: null,
      ...over.features,
    },
  };
}

describe("estimateCosts", () => {
  it("does not invent 200 bps when the quote has no fee", () => {
    const costs = estimateCosts(ctx(), 0.005);
    expect(costs.feeKnown).toBe(false);
    expect(costs.fee).toBe(0);
    expect(costs.total).toBe(0.005);
  });

  it("uses quote feeRateBps when present", () => {
    const costs = estimateCosts(
      ctx({
        quote: {
          averagePrice: 0.46,
          lastPrice: 0.99,
          chance: 0.46,
          feeAmount: null,
          feeRateBps: 100,
          slippageBps: 50,
          priceImpact: 0.01,
          minReceive: null,
          expireAt: null,
        },
      }),
      0,
    );
    expect(costs.feeKnown).toBe(true);
    expect(costs.fee).toBeCloseTo(0.01);
    expect(costs.slippage).toBeCloseTo(0.005);
    expect(costs.impact).toBeCloseTo(0.01);
  });
});

describe("spotWindowSide", () => {
  it("follows the candle vs window open", () => {
    expect(
      spotWindowSide({
        startPrice: 100,
        spot: 99.8,
        return1m: -0.001,
        minVsStart: 0.0005,
        minReturn1m: 0.0003,
      })?.side,
    ).toBe("down");
    expect(
      spotWindowSide({
        startPrice: 100,
        spot: 100.2,
        return1m: 0.001,
        minVsStart: 0.0005,
        minReturn1m: 0.0003,
      })?.side,
    ).toBe("up");
  });

  it("skips a tape reversal that disagrees with the candle vs window open", () => {
    expect(
      spotWindowSide({
        startPrice: 100,
        spot: 100.3,
        return2m: -0.002,
        minVsStart: 0.0005,
        minReturn1m: 0.0003,
        timeToExpirySec: 240,
        windowDurationSec: 300,
      }),
    ).toBeNull();
    expect(
      spotWindowSide({
        startPrice: 100,
        spot: 99.7,
        return2m: 0.002,
        minVsStart: 0.0005,
        minReturn1m: 0.0003,
        timeToExpirySec: 240,
        windowDurationSec: 300,
      }),
    ).toBeNull();
  });

  it("does not let a 1m wick override a 5m candle; 2m tape can", () => {
    const oneMinuteNoise = spotWindowSide({
      startPrice: 100,
      spot: 100.3,
      return2m: 0.001,
      minVsStart: 0.0005,
      minReturn1m: 0.0003,
      timeToExpirySec: 240,
      windowDurationSec: 300,
    });
    expect(oneMinuteNoise?.side).toBe("up");
    expect(oneMinuteNoise?.reason).not.toMatch(/розворот/);
    const twoMinuteReversal = spotWindowSide({
      startPrice: 100,
      spot: 100.3,
      return2m: -0.002,
      minVsStart: 0.0005,
      minReturn1m: 0.0003,
      timeToExpirySec: 240,
      windowDurationSec: 300,
    });
    expect(twoMinuteReversal).toBeNull();
  });

  it("does not let a 1m wick override a 15m candle; 5m tape can", () => {
    const oneMinuteNoise = spotWindowSide({
      startPrice: 100,
      spot: 100.3,
      return1m: -0.002,
      return5m: 0.001,
      minVsStart: 0.0005,
      minReturn1m: 0.0003,
      timeToExpirySec: 600,
      windowDurationSec: 900,
    });
    expect(oneMinuteNoise?.side).toBe("up");
    expect(oneMinuteNoise?.reason).not.toMatch(/розворот 1м/);
    const fiveMinuteReversal = spotWindowSide({
      startPrice: 100,
      spot: 100.3,
      return1m: -0.002,
      return5m: -0.002,
      minVsStart: 0.0005,
      minReturn1m: 0.0003,
      timeToExpirySec: 600,
      windowDurationSec: 900,
    });
    expect(fiveMinuteReversal).toBeNull();
    const hourReversal = spotWindowSide({
      startPrice: 100,
      spot: 100.3,
      return5m: -0.002,
      return15m: -0.003,
      minVsStart: 0.0005,
      minReturn1m: 0.0003,
      timeToExpirySec: 2_000,
      windowDurationSec: 3_600,
    });
    expect(hourReversal).toBeNull();
    expect(
      spotWindowSide({
        startPrice: 100,
        spot: 100,
        return1m: 0.002,
        return5m: null,
        minVsStart: 0.0005,
        minReturn1m: 0.0003,
        windowDurationSec: 900,
      }),
    ).toBeNull();
    expect(tapeHorizon(300)).toBe("2m");
    expect(tapeHorizon(900)).toBe("5m");
    expect(tapeHorizon(3600)).toBe("15m");
    expect(tapeHorizon(86_400)).toBe("15m");
    expect(tapeLookbackSec("2m")).toBe(120);
    expect(tapeLookbackSec("5m")).toBe(300);
    expect(tapeLookbackSec("15m")).toBe(900);
  });

  it("ignores tape in the last block (2m on 5m markets, 5m on 15m) and stays on the candle", () => {
    const late = spotWindowSide({
      startPrice: 100,
      spot: 100.3,
      return2m: -0.002,
      minVsStart: 0.0005,
      minReturn1m: 0.0003,
      timeToExpirySec: 90,
      windowDurationSec: 300,
    });
    expect(late?.side).toBe("up");
    expect(late?.reason).toMatch(/2м розворот ігнор/);
    expect(
      spotWindowSide({
        startPrice: 100,
        spot: 99.7,
        return2m: 0.002,
        minVsStart: 0.0005,
        minReturn1m: 0.0003,
        timeToExpirySec: 0,
        windowDurationSec: 300,
      })?.side,
    ).toBe("down");
    expect(
      spotWindowSide({
        startPrice: 100,
        spot: 100.3,
        return5m: -0.002,
        minVsStart: 0.0005,
        minReturn1m: 0.0003,
        timeToExpirySec: 240,
        windowDurationSec: 900,
      })?.side,
    ).toBe("up");
    expect(
      shouldIgnoreTape({ timeToExpirySec: 120, ignoreWithinSec: 120 }),
    ).toBe(true);
    expect(
      shouldIgnoreTape({ timeToExpirySec: 121, ignoreWithinSec: 120 }),
    ).toBe(false);
    expect(
      shouldIgnoreTape({ timeToExpirySec: 300, ignoreWithinSec: 300 }),
    ).toBe(true);
    expect(
      shouldIgnoreTape({ timeToExpirySec: 301, ignoreWithinSec: 300 }),
    ).toBe(false);
  });

  it("stays out when the candle is still at the open", () => {
    expect(
      spotWindowSide({
        startPrice: 100,
        spot: 100,
        return1m: 0,
        minVsStart: 0.0005,
        minReturn1m: 0.0003,
      }),
    ).toBeNull();
  });

  it("does not take a near-start 2m tape in the last 2m of a 5m window", () => {
    expect(
      spotWindowSide({
        startPrice: 749.25,
        spot: 749.4,
        return2m: -0.00047,
        minVsStart: 0.0005,
        minReturn1m: 0.0003,
        timeToExpirySec: 24,
        windowDurationSec: 300,
      }),
    ).toBeNull();
    const withTime = spotWindowSide({
      startPrice: 749.25,
      spot: 749.4,
      return2m: -0.00047,
      minVsStart: 0.0005,
      minReturn1m: 0.0003,
      timeToExpirySec: 180,
      windowDurationSec: 300,
    });
    expect(withTime).toBeNull();
  });
});

describe("underlying-momentum-lag", () => {
  const strategy = createMomentumLagStrategy({ safetyMargin: 0, minNetEdge: 0, maxNetEdge: 1 });

  it("buys Up when spot is above this window start and 2m agrees", () => {
    const signal = strategy.evaluate(
      ctx({
        startPrice: 100,
        underlyingPrice: 100.4,
        bestAsk: 0.42,
        bestBid: 0.40,
        lastPrice: 0.99,
        outcomeName: "Up",
        features: { underlyingReturn2m: 0.002 } as StrategyContext["features"],
      }),
    );
    expect(signal?.direction).toBe("BUY");
    expect(signal?.reason).toMatch(/старт|спот/i);
    expect(signal?.reason).not.toMatch(/0\.99/);
  });

  it("does not flip to a 2m reversal near expiry, including live flip TTE=0", () => {
    const late = strategy.evaluate(
      ctx({
        startPrice: 100,
        underlyingPrice: 100.3,
        timeToExpirySec: 90,
        bestAsk: 0.42,
        bestBid: 0.40,
        outcomeName: "Up",
        features: { underlyingReturn2m: -0.002 } as StrategyContext["features"],
      }),
    );
    expect(late?.direction).toBe("BUY");
    expect(late?.reason).toMatch(/2м розворот ігнор/);

    const flipNearEnd = createMomentumLagStrategy({
      safetyMargin: 0,
      minTimeToExpirySec: 0,
      minNetEdge: 0,
      maxNetEdge: 1,
    }).evaluate(
      ctx({
        startPrice: 100,
        underlyingPrice: 100.3,
        timeToExpirySec: 30,
        bestAsk: 0.42,
        bestBid: 0.40,
        outcomeName: "Up",
        features: { underlyingReturn2m: -0.002 } as StrategyContext["features"],
      }),
    );
    expect(flipNearEnd?.direction).toBe("BUY");

    const liveFlip = createMomentumLagStrategy(
      liveStrategyParams({
        parameters: { safetyMargin: 0, minTimeToExpirySec: 60, minNetEdge: 0, maxNetEdge: 1 },
        keepSignallingNearExpiry: true,
      }),
    ).evaluate(
      ctx({
        startPrice: 100,
        underlyingPrice: 99.7,
        timeToExpirySec: 15,
        bestAsk: 0.62,
        bestBid: 0.60,
        outcomeName: "Up",
        features: { underlyingReturn2m: 0.002 } as StrategyContext["features"],
      }),
    );
    expect(liveFlip?.direction).toBe("SELL");
    expect(liveFlip?.reason).toMatch(/2м розворот ігнор/);
  });

  it("does not emit a 2m reversal against the candle", () => {
    const signal = strategy.evaluate(
      ctx({
        startPrice: 100,
        underlyingPrice: 100.3,
        timeToExpirySec: 180,
        bestAsk: 0.42,
        bestBid: 0.40,
        outcomeName: "Up",
        features: { underlyingReturn2m: -0.002 } as StrategyContext["features"],
      }),
    );
    expect(signal).toBeNull();
  });

  it("stays on the 15m candle when only the 1m has reversed", () => {
    const signal = strategy.evaluate(
      ctx({
        startPrice: 100,
        underlyingPrice: 100.3,
        timeToExpirySec: 600,
        windowDurationSec: 900,
        bestAsk: 0.42,
        bestBid: 0.40,
        outcomeName: "Up",
        features: {
          underlyingReturn1m: -0.002,
          underlyingReturn5m: 0.001,
        } as StrategyContext["features"],
      }),
    );
    expect(signal?.direction).toBe("BUY");
    expect(signal?.reason).not.toMatch(/розворот 1м/);
  });

  it("does not emit a 5m reversal against a 15m candle", () => {
    const signal = strategy.evaluate(
      ctx({
        startPrice: 100,
        underlyingPrice: 100.3,
        timeToExpirySec: 600,
        windowDurationSec: 900,
        bestAsk: 0.42,
        bestBid: 0.40,
        outcomeName: "Up",
        features: {
          underlyingReturn1m: -0.002,
          underlyingReturn5m: -0.002,
        } as StrategyContext["features"],
      }),
    );
    expect(signal).toBeNull();
  });

  it("sells Up (bets Down) when spot is below this window start and Down is cheap", () => {
    const signal = strategy.evaluate(
      ctx({
        startPrice: 100,
        underlyingPrice: 99.6,
        bestAsk: 0.62,
        bestBid: 0.60,
        outcomeName: "Up",
        features: { underlyingReturn2m: -0.002 } as StrategyContext["features"],
      }),
    );
    expect(signal?.direction).toBe("SELL");
  });

  it("rejects a buy ask above 0.45", () => {
    const expensive = createMomentumLagStrategy({ safetyMargin: 0, minNetEdge: 0, maxNetEdge: 1 });
    const signal = expensive.evaluate(
      ctx({
        startPrice: 100,
        underlyingPrice: 100.4,
        bestAsk: 0.65,
        bestBid: 0.63,
        outcomeName: "Up",
        features: { underlyingReturn2m: 0.002 } as StrategyContext["features"],
      }),
    );
    expect(signal).toBeNull();
  });

  it("only signals when net edge is at least 8%", () => {
    const gated = createMomentumLagStrategy({ safetyMargin: 0, minNetEdge: 0.3 });
    const loose = createMomentumLagStrategy({ safetyMargin: 0 });
    const base = {
      startPrice: 100,
      underlyingPrice: 100.4,
      outcomeName: "Up",
      features: { underlyingReturn2m: 0.002 } as StrategyContext["features"],
    };
    expect(gated.evaluate(ctx({ ...base, bestAsk: 0.42, bestBid: 0.4 }))).toBeNull();
    expect(loose.evaluate(ctx({ ...base, bestAsk: 0.42, bestBid: 0.4 }))?.direction).toBe("BUY");
  });

  it("needs a clearer 1h move vs open than a 5m wick", () => {
    const hour = {
      startPrice: 100,
      windowDurationSec: 3_600,
      timeToExpirySec: 2_000,
      bestAsk: 0.42,
      bestBid: 0.4,
      outcomeName: "Up" as const,
      features: { underlyingReturn15m: 0.002 } as StrategyContext["features"],
    };
    expect(
      strategy.evaluate(ctx({ ...hour, underlyingPrice: 100.05 })),
    ).toBeNull();
    expect(
      strategy.evaluate(ctx({ ...hour, underlyingPrice: 100.12 }))?.direction,
    ).toBe("BUY");
  });

  it("stays flat when the underlying has not left the window open", () => {
    const signal = strategy.evaluate(
      ctx({
        startPrice: 100,
        underlyingPrice: 100,
        bestAsk: 0.3,
        features: { underlyingReturn2m: 0, underlyingReturn5m: 0 } as StrategyContext["features"],
      }),
    );
    expect(signal).toBeNull();
  });
});

describe("mean-reversion", () => {
  const strategy = createMeanReversionStrategy({
    entryZ: 2,
    exitZ: 0.5,
    minNetEdge: 0.015,
    safetyMargin: 0,
  });

  it("does not trade a raw cheap/rich book without a z-score", () => {
    const signal = strategy.evaluate(
      ctx({
        bestAsk: 0.2,
        bestBid: 0.19,
        marketProbability: 0.2,
      }),
    );
    expect(signal).toBeNull();
  });

  it("buys only when z is stretched below the mean and the ask is below that mean", () => {
    const signal = strategy.evaluate(
      ctx({
        bestAsk: 0.4,
        bestBid: 0.39,
        marketProbability: 0.4,
        features: {
          probabilityMean: 0.5,
          probabilityStd: 0.04,
          probabilityZ: -2.5,
        } as StrategyContext["features"],
      }),
    );
    expect(signal?.direction).toBe("BUY");
    expect(signal?.fairProbability).toBe(0.5);
  });

  it("sells when z is stretched above the mean and the bid is above that mean", () => {
    const signal = strategy.evaluate(
      ctx({
        bestAsk: 0.61,
        bestBid: 0.6,
        marketProbability: 0.6,
        features: {
          probabilityMean: 0.5,
          probabilityStd: 0.04,
          probabilityZ: 2.5,
        } as StrategyContext["features"],
      }),
    );
    expect(signal?.direction).toBe("SELL");
  });

  it("exits when |z| is inside the exit band", () => {
    const signal = strategy.evaluate(
      ctx({
        features: {
          probabilityMean: 0.5,
          probabilityStd: 0.04,
          probabilityZ: 0.2,
        } as StrategyContext["features"],
      }),
    );
    expect(signal?.direction).toBe("EXIT");
  });
});

describe("fair-value", () => {
  const strategy = createFairValueStrategy({
    minNetEdge: 0.02,
    safetyMargin: 0,
    volPerSqrtHour: 0.015,
  });

  it("does not invent a model when startPrice is missing", () => {
    expect(strategy.evaluate(ctx({ startPrice: null, underlyingPrice: 110 }))).toBeNull();
  });

  it("uses the ask, not lastPrice, against the model", () => {
    const signal = strategy.evaluate(
      ctx({
        startPrice: 100,
        underlyingPrice: 110,
        timeToExpirySec: 600,
        bestAsk: 0.55,
        bestBid: 0.54,
        lastPrice: 0.99,
      }),
    );
    expect(signal?.direction).toBe("BUY");
    expect(signal?.fairProbability).toBeGreaterThan(0.7);
    expect(signal?.grossEdge).toBeCloseTo((signal?.fairProbability ?? 0) - 0.55);
  });
});

describe("evaluateStrategies", () => {
  it("returns the first non-null signal in research order", () => {
    const strategies = loadResearchStrategies();
    const signal = evaluateStrategies(
      strategies,
      ctx({
        bestAsk: 0.42,
        bestBid: 0.4,
        lastPrice: 0.99,
        startPrice: 100,
        underlyingPrice: 100.4,
        features: { underlyingReturn2m: 0.002 } as StrategyContext["features"],
      }),
    );
    expect(signal?.strategyId).toBe("underlying-momentum-lag");
  });
});
