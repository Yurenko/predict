import { describe, expect, it, beforeEach } from "vitest";
import { OrderStatus, TradingMode } from "@prisma/client";
import type { StrategySignal } from "@/lib/types/domain";
import { emptyRiskSnapshot } from "@/lib/risk/limits";
import type { RiskLimits } from "@/lib/risk/types";
import { executePaperTrade, resetPaperIdempotencyCache, skippedPaperTrade } from "./engine";
import { canTransition, transitionOrder } from "./state-machine";
import { validateQuoteForFill, type PaperQuote } from "./quote-validate";
import { paperIdempotencyKey, timeBucket } from "./idempotency";
import { decidePaperAction, isDuplicatePaperEnter, paperOrderSide } from "./action";
import { quoteAmountInWei, usdtToWei } from "./amounts";

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
    maxTimeToExpirySec: 86_400,
    staleMs: 15_000,
    cooldownMs: 900_000,
    consecutiveLossesForCooldown: 5,
    liveTradingEnabled: false,
    maxEntryAsk: 0.75,
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

  it("can submit now and fill on a later pass like LIVE", () => {
    const submitted = executePaperTrade(request(), emptyRiskSnapshot(lim), lim, { stage: "submit" });
    expect(submitted.status).toBe(OrderStatus.SUBMITTED);
    expect(submitted.fill).toBeNull();
    const filledLater = executePaperTrade(request(), emptyRiskSnapshot(lim), lim, {
      stage: "fill",
      idempotencyKey: submitted.idempotencyKey,
    });
    expect(filledLater.status).toBe(OrderStatus.FILLED);
    expect(filledLater.fill?.price).toBeCloseTo(0.46);
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

  it("fills PAPER ENTER even when the kill switch is armed", () => {
    const armed = emptyRiskSnapshot(lim);
    armed.killSwitch = true;
    armed.killSwitchReason = "max_drawdown";
    const result = executePaperTrade(request(), armed, lim);
    expect(result.status).toBe(OrderStatus.FILLED);
    expect(result.riskDecision?.allowed).toBe(true);
  });

  it("fills a demo account from the last book when getQuote is missing", () => {
    const result = executePaperTrade(request({ quote: null }), emptyRiskSnapshot(lim), lim);
    expect(result.status).toBe(OrderStatus.FILLED);
    expect(result.reason).toBe("filled_demo_book");
    expect(result.fill?.price).toBeCloseTo(0.46);
    expect(result.fill?.notional).toBeGreaterThan(0);
  });

  it("uses the book when the quote is lastPrice or above the entry cap", () => {
    const tight: RiskLimits = { ...lim, maxEntryAsk: 0.55 };
    const fromLast = executePaperTrade(
      request({ quote: quote({ averagePrice: 0.99 }) }),
      emptyRiskSnapshot(tight),
      tight,
    );
    expect(fromLast.status).toBe(OrderStatus.FILLED);
    expect(fromLast.fill?.price).toBeCloseTo(0.46);
    const fromHigh = executePaperTrade(
      request({
        quote: quote({ averagePrice: 0.7, lastPrice: 0.99 }),
        now: new Date("2026-01-01T00:00:06.000Z"),
      }),
      emptyRiskSnapshot(tight),
      tight,
    );
    expect(fromHigh.status).toBe(OrderStatus.FILLED);
    expect(fromHigh.fill?.price).toBeCloseTo(0.46);
  });

  it("still fills PAPER when the book is older than staleMs", () => {
    const result = executePaperTrade(
      request({ book: { ...request().book, dataAgeMs: 20_000 } }),
      emptyRiskSnapshot(lim),
      lim,
    );
    expect(result.status).toBe(OrderStatus.FILLED);
  });

  it("records a skipped paper attempt without filling", () => {
    const result = skippedPaperTrade(request(), "no_executable_book");
    expect(result.status).toBe(OrderStatus.FAILED);
    expect(result.reason).toBe("no_executable_book");
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
    expect(paperOrderSide("ENTER", "SELL", null, "BUY")).toBe("BUY");
  });

  it("skips a second ENTER when another strategy already holds the same contract", () => {
    expect(isDuplicatePaperEnter("ENTER", true)).toBe(true);
    expect(isDuplicatePaperEnter("ENTER", false)).toBe(false);
    expect(isDuplicatePaperEnter("EXIT", true)).toBe(false);
    expect(isDuplicatePaperEnter("HOLD", true)).toBe(false);
  });

  it("encodes USDT notional as wei for getQuote amountIn", () => {
    expect(usdtToWei(1.5)).toBe("1500000000000000000");
    expect(usdtToWei(50)).toBe("50000000000000000000");
    expect(() => usdtToWei(0)).toThrow(/positive/);
  });

  it("encodes SELL getQuote amountIn as shares, not USDT notional", () => {
    expect(quoteAmountInWei({ side: "BUY", amountUsdt: 2 })).toBe("2000000000000000000");
    expect(quoteAmountInWei({ side: "SELL", amountShares: 5 })).toBe("5000000000000000000");
    expect(() => quoteAmountInWei({ side: "SELL", amountUsdt: 1.18 })).toThrow(/shares/);
  });
});

describe("paper cycle snapshot", () => {
  it("parses a cycle and prefers the newer timestamp", async () => {
    const { newerPaperCycle, parsePaperCycle } = await import("./cycle");
    expect(parsePaperCycle(null)).toBeNull();
    expect(parsePaperCycle("{")).toBeNull();
    const older = parsePaperCycle(
      JSON.stringify({ at: "2026-09-01T12:00:00Z", enabled: 3, considered: 0, filled: 0, skip: "a" }),
    );
    const newer = parsePaperCycle(
      JSON.stringify({ at: "2026-09-01T12:01:00Z", enabled: 3, considered: 2, filled: 1, skip: null }),
    );
    expect(newerPaperCycle(older, newer)?.filled).toBe(1);
    expect(newerPaperCycle(newer, older)?.considered).toBe(2);
  });

  it("maps ASCII skip codes to Ukrainian for the dashboard", async () => {
    const { paperSkipLabel, PAPER_SKIP } = await import("./skip");
    expect(paperSkipLabel(PAPER_SKIP.noPredictionBook)).toMatch(/prediction/);
    expect(paperSkipLabel(PAPER_SKIP.noPredictionBook)).toMatch(/книгою|книзі|книги/i);
    expect(paperSkipLabel(PAPER_SKIP.waitingNextHorizon)).toMatch(/відкриті позиції/i);
    expect(paperSkipLabel(null)).toBeNull();
    expect(paperSkipLabel("already ukrainian")).toBe("already ukrainian");
  });
});
