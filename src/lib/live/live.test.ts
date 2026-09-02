import { describe, expect, it, beforeEach, vi } from "vitest";
import { OrderStatus, TradingMode } from "@prisma/client";
import type { StrategySignal } from "@/lib/types/domain";
import { emptyRiskSnapshot } from "@/lib/risk/limits";
import type { RiskLimits } from "@/lib/risk/types";
import { OfficialPredictionAdapter } from "@/lib/binance/prediction-adapter";
import { MinIntervalLimiter } from "@/lib/binance/rate-limit";
import type { W3WPrediction } from "@binance/w3w-prediction";
import { buildMarketPlaceOrder } from "./place";
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
      orderType: "MARKET",
      slippageBps: 50,
    });
    expect(body).not.toHaveProperty("feeRateBps");
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
