import { describe, expect, it, beforeEach, vi } from "vitest";
import { OrderStatus, TradingMode } from "@prisma/client";
import type { StrategySignal } from "@/lib/types/domain";
import { emptyRiskSnapshot } from "@/lib/risk/limits";
import type { RiskLimits } from "@/lib/risk/types";
import { OfficialPredictionAdapter } from "@/lib/binance/prediction-adapter";
import { MinIntervalLimiter } from "@/lib/binance/rate-limit";
import type { W3WPrediction } from "@binance/w3w-prediction";
import { buildLimitPlaceOrder, buildMarketPlaceOrder } from "./place";
import { mapOfficialOrderStatus } from "./status";
import { resolveWalletId } from "./wallet";
import { executeLiveTrade, resetLiveIdempotencyCache } from "./engine";
import type { PaperQuote } from "@/lib/paper/quote-validate";

vi.mock("@/lib/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/env")>();
  return {
    ...actual,
    isLiveTradingEnabled: () => true,
  };
});

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
    liveTradingEnabled: true,
  };
}

function quote(over: Partial<PaperQuote> = {}): PaperQuote {
  return {
    quoteId: "q-live-1",
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
    mode: TradingMode.LIVE,
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

describe("official live helpers", () => {
  it("builds MARKET+FOK placeOrder without feeRateBps", () => {
    const body = buildMarketPlaceOrder({
      walletAddress: "0xabc",
      walletId: "w-1",
      quoteId: "q-1",
      slippageBps: 50,
      accountType: "SPOT",
    });
    expect(body).toEqual({
      walletAddress: "0xabc",
      walletId: "w-1",
      quoteId: "q-1",
      timeInForce: "FOK",
      accountType: "SPOT",
      fundingSource: "MPC",
      orderType: "MARKET",
      slippageBps: 50,
    });
    expect(body).not.toHaveProperty("feeRateBps");
  });

  it("builds LIMIT+GTC flatten so leftover shares stay working on the book", () => {
    const body = buildLimitPlaceOrder({
      walletAddress: "0xabc",
      walletId: "w-1",
      quoteId: "q-1",
      slippageBps: 50,
      accountType: "SPOT",
      priceLimit: 0.4,
    });
    expect(body).toMatchObject({
      timeInForce: "GTC",
      orderType: "LIMIT",
      priceLimit: "0.40000000",
    });
  });

  it("maps only known official status strings", () => {
    expect(mapOfficialOrderStatus("OPEN")).toBe(OrderStatus.SUBMITTED);
    expect(mapOfficialOrderStatus("FILLED")).toBe(OrderStatus.FILLED);
    expect(mapOfficialOrderStatus("CANCELLED")).toBe(OrderStatus.CANCELLED);
    expect(mapOfficialOrderStatus("mystery")).toBeNull();
  });

  it("resolves walletId from listPredictionWallets when env is empty", async () => {
    const id = await resolveWalletId({
      walletAddress: "0xAbC",
      configuredWalletId: "",
      listWallets: async () => ({
        wallets: [{ walletAddress: "0xabc", walletId: "wid-9" }],
      }),
    });
    expect(id).toBe("wid-9");
  });
});

describe("executeLiveTrade", () => {
  const lim = limits();

  beforeEach(() => {
    resetLiveIdempotencyCache();
  });

  it("submits via placeOrder and does not invent a fill from lastPrice", async () => {
    const placeOrder = vi.fn().mockResolvedValue({ orderId: "ord-1" });
    const result = await executeLiveTrade(
      request(),
      emptyRiskSnapshot(lim, TradingMode.LIVE),
      lim,
      { placeOrder },
      { walletAddress: "0xabc", walletId: "w-1", accountType: "SPOT" },
    );
    expect(result.status).toBe(OrderStatus.SUBMITTED);
    expect(result.placed).toBe(true);
    expect(result.venueOrderId).toBe("ord-1");
    expect(result.fill).toBeNull();
    expect(placeOrder).toHaveBeenCalledTimes(1);
    const body = placeOrder.mock.calls[0]?.[0];
    expect(body.orderType).toBe("MARKET");
    expect(body.timeInForce).toBe("FOK");
    expect(body.quoteId).toBe("q-live-1");
    expect(body).not.toHaveProperty("feeRateBps");
  });

  it("refuses a live submit without an official quote", async () => {
    const placeOrder = vi.fn();
    const result = await executeLiveTrade(
      request({ quote: null }),
      emptyRiskSnapshot(lim, TradingMode.LIVE),
      lim,
      { placeOrder },
      { walletAddress: "0xabc", walletId: "w-1", accountType: "SPOT" },
    );
    expect(result.status).toBe(OrderStatus.FAILED);
    expect(result.reason).toBe("missing_quote");
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("refuses an ENTER bigger than bankroll × maxPositionPct", async () => {
    const placeOrder = vi.fn();
    const result = await executeLiveTrade(
      request({ requestedNotional: 100, action: "ENTER" }),
      emptyRiskSnapshot(lim, TradingMode.LIVE),
      lim,
      { placeOrder },
      { walletAddress: "0xabc", walletId: "w-1", accountType: "SPOT" },
    );
    expect(result.status).toBe(OrderStatus.FAILED);
    expect(result.reason).toBe("above_max_position");
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("lets an EXIT flatten the full shares × mark even above the enter cap", async () => {
    const placeOrder = vi.fn().mockResolvedValue({ orderId: "ord-exit" });
    const result = await executeLiveTrade(
      request({ requestedNotional: 100, action: "EXIT", positionSide: "BUY" }),
      emptyRiskSnapshot(lim, TradingMode.LIVE),
      lim,
      { placeOrder },
      { walletAddress: "0xabc", walletId: "w-1", accountType: "SPOT" },
    );
    expect(result.status).toBe(OrderStatus.SUBMITTED);
    expect(result.placed).toBe(true);
    expect(result.venueOrderId).toBe("ord-exit");
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("places EXIT as LIMIT GTC labeled EXIT BUY", async () => {
    const placeOrder = vi.fn().mockResolvedValue({ orderId: "ord-exit-limit" });
    const result = await executeLiveTrade(
      request({
        requestedNotional: 1.84,
        action: "EXIT",
        positionSide: "BUY",
        orderSide: "SELL",
        orderType: "LIMIT",
        priceLimit: 0.4,
        exitIntent: "EXIT BUY",
      }),
      emptyRiskSnapshot(lim, TradingMode.LIVE),
      lim,
      { placeOrder },
      { walletAddress: "0xabc", walletId: "w-1", accountType: "SPOT" },
    );
    expect(result.placed).toBe(true);
    expect(result.reason).toBe("EXIT BUY");
    expect(result.orderType).toBe("LIMIT");
    expect(placeOrder.mock.calls[0]?.[0]).toMatchObject({
      orderType: "LIMIT",
      timeInForce: "GTC",
      priceLimit: "0.40000000",
    });
  });

  it("allows an EXIT leftover under the $1.5 enter min", async () => {
    const placeOrder = vi.fn().mockResolvedValue({ orderId: "ord-dust" });
    const result = await executeLiveTrade(
      request({ requestedNotional: 0.38, action: "EXIT", positionSide: "BUY", orderSide: "SELL" }),
      emptyRiskSnapshot(lim, TradingMode.LIVE),
      lim,
      { placeOrder },
      { walletAddress: "0xabc", walletId: "w-1", accountType: "SPOT" },
    );
    expect(result.status).toBe(OrderStatus.SUBMITTED);
    expect(result.placed).toBe(true);
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("still blocks an ENTER under the configured $1 venue min", async () => {
    const placeOrder = vi.fn();
    const result = await executeLiveTrade(
      request({ requestedNotional: 0.38, action: "ENTER" }),
      emptyRiskSnapshot(lim, TradingMode.LIVE),
      lim,
      { placeOrder },
      { walletAddress: "0xabc", walletId: "w-1", accountType: "SPOT" },
    );
    expect(result.status).toBe(OrderStatus.FAILED);
    expect(result.reason).toBe("below_market_min_amount");
    expect(placeOrder).not.toHaveBeenCalled();
  });
});

describe("OfficialPredictionAdapter.placeOrder gate", () => {
  it("still documents the live-flag requirement on the adapter", async () => {
    // This file mocks isLiveTradingEnabled=true, so the adapter will call SDK.
    const placeOrder = vi.fn().mockResolvedValue({
      data: async () => ({ orderId: "ord-sdk" }),
    });
    const adapter = new OfficialPredictionAdapter(
      { restAPI: { placeOrder } } as unknown as W3WPrediction,
      new MinIntervalLimiter(0),
    );
    const placed = await adapter.placeOrder(
      buildMarketPlaceOrder({
        walletAddress: "0xabc",
        walletId: "w-1",
        quoteId: "q-1",
        slippageBps: 50,
        accountType: "SPOT",
      }),
    );
    expect(placed.orderId).toBe("ord-sdk");
  });
});
