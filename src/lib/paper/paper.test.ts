import { describe, expect, it, beforeEach } from "vitest";
import { OrderStatus, TradingMode } from "@prisma/client";
import type { StrategySignal } from "@/lib/types/domain";
import { emptyRiskSnapshot } from "@/lib/risk/limits";
import type { RiskLimits } from "@/lib/risk/types";
import { executePaperTrade, resetPaperIdempotencyCache } from "./engine";
import { canTransition, transitionOrder } from "./state-machine";
import { validateQuoteForFill, type PaperQuote } from "./quote-validate";
import { paperIdempotencyKey, timeBucket } from "./idempotency";
import { decidePaperAction, paperOrderSide } from "./action";
import { usdtToWei } from "./amounts";

function limits(): RiskLimits {
  return {
    bankrollUsdt: 1000,
    maxPositionPct: 5,
    maxSimultaneousPositions: 5,
    maxDailyLossPct: 3,
    maxDrawdownPct: 10,
    maxSlippageBps: 1000,
    maxPriceImpact: 0.05,
    minLiquidityUsdt: 100,
    minTimeToExpirySec: 60,
    staleMs: 15_000,
    cooldownMs: 900_000,
    consecutiveLossesForCooldown: 5,
    liveTradingEnabled: false,
  };
}

function quote(over: Partial<PaperQuote> = {}): PaperQuote {
  return {
    quoteId: "q-1",
    tokenId: "yes-1",
    averagePrice: 0.46,
    lastPrice: 0.99,
    chance: 0.46,
    feeAmount: null,
    feeRateBps: 100,
    slippageBps: 50,
    priceImpact: 0.01,
    minReceive: null,
    expireAt: new Date("2026-01-01T00:05:00.000Z"),
    ...over,
  };
}

function signal(): StrategySignal {
  return {
    strategyId: "underlying-momentum-lag",
    marketId: "m1",
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    direction: "BUY",
    marketProbability: 0.45,
    fairProbability: 0.6,
    grossEdge: 0.1,
    estimatedFees: 0.01,
    estimatedSlippage: 0.005,
    estimatedPriceImpact: 0.01,
    netEdge: 0.07,
    confidence: 0.4,
    reason: "test",
    riskChecks: [],
  };
}

function request(over: Record<string, unknown> = {}) {
  return {
    mode: TradingMode.PAPER,
    action: "ENTER" as const,
    strategyId: "underlying-momentum-lag",
    marketId: "m1",
    tokenId: "yes-1",
    signal: signal(),
    book: {
      bestBid: 0.44,
      bestAsk: 0.46,
      lastPrice: 0.99,
      liquidity: 500,
      bidDepth: 10_000,
      askDepth: 10_000,
      timeToExpirySec: 600,
      dataAgeMs: 200,
    },
    quote: quote(),
    now: new Date("2026-01-01T00:00:00.000Z"),
    requestedNotional: 50,
    maxPriceImpact: 0.05,
    ...over,
  };
}

describe("order state machine", () => {
  it("allows pending → submitted → filled and rejects filled → pending", () => {
    expect(canTransition(OrderStatus.PENDING, OrderStatus.SUBMITTED)).toBe(true);
    expect(transitionOrder(OrderStatus.SUBMITTED, OrderStatus.FILLED)).toBe(OrderStatus.FILLED);
    expect(() => transitionOrder(OrderStatus.FILLED, OrderStatus.PENDING)).toThrow(/illegal/);
  });
});

describe("validateQuoteForFill", () => {
  it("refuses lastPrice as the fill when it differs from the book", () => {
    const result = validateQuoteForFill({
      quote: quote({ averagePrice: 0.99, lastPrice: 0.99 }),
      side: "BUY",
      bestBid: 0.44,
      bestAsk: 0.46,
      lastPrice: 0.99,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("fill_is_last_price");
  });

  it("refuses missing fees instead of inventing 200 bps", () => {
    const result = validateQuoteForFill({
      quote: quote({ feeRateBps: null, feeAmount: null, averagePrice: 0.46 }),
      side: "BUY",
      bestBid: 0.44,
      bestAsk: 0.46,
      lastPrice: 0.99,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result).toEqual({ ok: false, reason: "missing_fee_data" });
  });

  it("refuses an expired quote", () => {
    const result = validateQuoteForFill({
      quote: quote({ expireAt: new Date("2025-01-01T00:00:00.000Z") }),
      side: "BUY",
      bestBid: 0.44,
      bestAsk: 0.46,
      lastPrice: 0.99,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("quote_expired");
  });
});

describe("executePaperTrade", () => {
  const lim = limits();

  beforeEach(() => {
    resetPaperIdempotencyCache();
  });

  it("fills at the quote average, not lastPrice", () => {
    const result = executePaperTrade(request(), emptyRiskSnapshot(lim), lim);
    expect(result.status).toBe(OrderStatus.FILLED);
    expect(result.fill?.price).toBeCloseTo(0.46);
    expect(result.fill?.price).not.toBe(0.99);
  });

  it("is idempotent within the same time bucket", () => {
    const first = executePaperTrade(request(), emptyRiskSnapshot(lim), lim);
    const second = executePaperTrade(request(), emptyRiskSnapshot(lim), lim);
    expect(second.duplicate).toBe(true);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(paperIdempotencyKey({
      mode: TradingMode.PAPER,
      strategyId: "underlying-momentum-lag",
      marketId: "m1",
      tokenId: "yes-1",
      side: "BUY",
      action: "ENTER",
      bucketMs: timeBucket(new Date("2026-01-01T00:00:00.000Z"), 5_000),
    })).toBe(first.idempotencyKey);
  });

  it("refuses LIVE mode in the paper worker", () => {
    expect(() =>
      executePaperTrade(request({ mode: TradingMode.LIVE }), emptyRiskSnapshot(lim), lim),
    ).toThrow(/paper worker/);
  });

  it("blocks ENTER when the kill switch is armed", () => {
    const armed = emptyRiskSnapshot(lim);
    armed.killSwitch = true;
    const result = executePaperTrade(request(), armed, lim);
    expect(result.status).toBe(OrderStatus.FAILED);
    expect(result.reason).toBe("kill_switch");
  });

  it("refuses a fill without an official quote", () => {
    const result = executePaperTrade(request({ quote: null }), emptyRiskSnapshot(lim), lim);
    expect(result.status).toBe(OrderStatus.FAILED);
    expect(result.reason).toBe("missing_quote");
    expect(result.fill).toBeNull();
  });
});

describe("paper helpers", () => {
  it("enters, holds, and exits from signal vs open side", () => {
    expect(decidePaperAction("BUY", null)).toBe("ENTER");
    expect(decidePaperAction("BUY", "BUY")).toBe("HOLD");
    expect(decidePaperAction("SELL", "BUY")).toBe("EXIT");
    expect(decidePaperAction("EXIT", "BUY")).toBe("EXIT");
    expect(decidePaperAction("EXIT", null)).toBe("HOLD");
    expect(decidePaperAction("FLAT", null)).toBe("HOLD");
    expect(paperOrderSide("EXIT", "BUY", "BUY")).toBe("SELL");
  });

  it("encodes USDT notional as wei for getQuote amountIn", () => {
    expect(usdtToWei(1.5)).toBe("1500000000000000000");
    expect(usdtToWei(50)).toBe("50000000000000000000");
    expect(() => usdtToWei(0)).toThrow(/positive/);
  });
});
