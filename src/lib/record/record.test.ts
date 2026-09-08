import { describe, expect, it } from "vitest";
import { buildStrategyContext } from "@/lib/backtest/context";
import type { MarketTick, UnderlyingTick } from "@/lib/backtest/types";
import { createMomentumLagStrategy } from "@/lib/strategy";
import { tickFromSnapshot, selectPrimarySnapshot } from "@/lib/normalize/tick";
import { hypotheticalSignals, toHypothetical } from "@/lib/record/sample";
import {
  emptyRecordControl,
  isPidAlive,
  parseRecordControl,
  shouldKillExternalPid,
  walletPreview,
} from "@/lib/record/types";

describe("walletPreview", () => {
  it("truncates a long address and keeps short ones", () => {
    expect(walletPreview("")).toBeNull();
    expect(walletPreview("  0xabc  ")).toBe("0xabc");
    expect(walletPreview("0x1234567890abcdef")).toBe("0x1234…cdef");
  });
});

describe("record control parse", () => {
  it("defaults to stopped with no secrets-shaped fields", () => {
    expect(parseRecordControl(null)).toEqual(emptyRecordControl());
    expect(parseRecordControl("{not json")).toEqual(emptyRecordControl());
    const parsed = parseRecordControl(
      JSON.stringify({ desired: "running", sessionId: "s1", pid: 12, extra: "x" }),
    );
    expect(parsed.desired).toBe("running");
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.pid).toBe(12);
    expect(parsed.paper).toBeNull();
    expect(JSON.stringify(parsed)).not.toMatch(/apiKey|apiSecret/i);
  });

  it("keeps the latest paper cycle snapshot", () => {
    const parsed = parseRecordControl(
      JSON.stringify({
        desired: "running",
        paper: { at: "2026-09-01T12:00:00Z", enabled: 3, considered: 0, filled: 0, skip: "no books" },
      }),
    );
    expect(parsed.paper).toEqual({
      at: "2026-09-01T12:00:00Z",
      enabled: 3,
      considered: 0,
      filled: 0,
      skip: "no books",
    });
  });
});

describe("isPidAlive", () => {
  it("treats the current process as alive and 0 as dead", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(null)).toBe(false);
  });
});

describe("shouldKillExternalPid", () => {
  it("never treats the dashboard process as an external worker to kill", () => {
    expect(shouldKillExternalPid(process.pid, process.pid)).toBe(false);
    expect(shouldKillExternalPid(null, process.pid)).toBe(false);
    expect(shouldKillExternalPid(0, process.pid)).toBe(false);
  });
});

describe("tickFromSnapshot", () => {
  it("maps executable bid/ask and ignores missing lastPrice as executable", () => {
    const tick = tickFromSnapshot({
      observedAt: new Date("2026-01-01T00:00:00Z"),
      marketId: "m1",
      outcomeId: "o1",
      lastPrice: 0.99,
      chance: 0.44,
      bestBid: 0.43,
      bestAsk: 0.45,
      midPrice: 0.44,
      spread: 0.02,
      liquidity: 1000,
      bidDepth: 10,
      askDepth: 10,
      timeToExpirySec: 120,
      market: {
        venueMarketId: "99",
        topic: { symbol: "BTCUSDT", endDate: new Date("2026-01-01T01:00:00Z"), startPrice: 100 },
        outcomes: [{ tokenId: "tok", name: "Yes", outcomeIndex: 0 }],
      },
      outcome: { tokenId: "tok", name: "Yes" },
    });
    expect(tick.bestBid).toBe(0.43);
    expect(tick.bestAsk).toBe(0.45);
    expect(tick.lastPrice).toBe(0.99);
    expect(tick.tokenId).toBe("tok");
    expect(tick.outcomeName).toBe("Yes");
  });

  it("pins a Down snapshot to the Up token and inverts the book", () => {
    const tick = tickFromSnapshot({
      observedAt: new Date("2026-01-01T00:00:00Z"),
      marketId: "m1",
      outcomeId: "down-row",
      lastPrice: 0.2,
      chance: 0.2,
      bestBid: 0.19,
      bestAsk: 0.21,
      midPrice: 0.2,
      spread: 0.02,
      liquidity: 1000,
      bidDepth: 10,
      askDepth: 10,
      timeToExpirySec: 120,
      market: {
        venueMarketId: "99",
        topic: { symbol: "BTCUSDT", endDate: new Date("2026-01-01T01:00:00Z"), startPrice: 100 },
        outcomes: [
          { id: "up-row", tokenId: "up-1", name: "Up", outcomeIndex: 0 },
          { id: "down-row", tokenId: "down-1", name: "Down", outcomeIndex: 1 },
        ],
      },
      outcome: { id: "down-row", tokenId: "down-1", name: "Down" },
    });
    expect(tick.tokenId).toBe("up-1");
    expect(tick.outcomeId).toBe("up-row");
    expect(tick.outcomeName).toBe("Up");
    expect(tick.bestBid).toBeCloseTo(0.79);
    expect(tick.bestAsk).toBeCloseTo(0.81);
    expect(tick.chance).toBeCloseTo(0.8);
  });

  it("prefers the Up snapshot when the latest row is Down", () => {
    const up = { outcomeId: "up-row", bid: 1 };
    const down = { outcomeId: "down-row", bid: 2 };
    const picked = selectPrimarySnapshot(
      [down, up],
      [
        { id: "up-row", tokenId: "up-1", name: "Up", outcomeIndex: 0 },
        { id: "down-row", tokenId: "down-1", name: "Down", outcomeIndex: 1 },
      ],
    );
    expect(picked?.snapshot).toBe(up);
    expect(picked?.outcome?.tokenId).toBe("up-1");
  });
});

describe("hypotheticalSignals", () => {
  it("records a would-be signal without requiring a quote or order", () => {
    const now = new Date("2026-01-01T00:10:00Z");
    const underlyings: UnderlyingTick[] = [
      { observedAt: new Date("2026-01-01T00:00:00Z"), symbol: "BTCUSDT", price: 100, bid: null, ask: null, volume: null },
      { observedAt: now, symbol: "BTCUSDT", price: 102, bid: null, ask: null, volume: null },
    ];
    const tick: MarketTick = {
      observedAt: now,
      marketId: "m1",
      venueMarketId: "1",
      outcomeId: "o1",
      tokenId: "tok",
      outcomeName: "Yes",
      symbol: "BTCUSDT",
      endDate: new Date("2026-01-01T01:00:00Z"),
      startPrice: 100,
      bestBid: 0.4,
      bestAsk: 0.42,
      midPrice: 0.41,
      chance: 0.41,
      lastPrice: 0.9,
      spread: 0.02,
      liquidity: 500,
      bidDepth: 10,
      askDepth: 10,
      timeToExpirySec: 3000,
    };
    const context = buildStrategyContext({
      now,
      tick,
      underlyings,
      probability: [{ observedAt: now, value: 0.41 }],
      quotes: [],
      rollingWindow: 60,
    });
    const signals = hypotheticalSignals(context, [
      { slug: "underlying-momentum-lag", strategy: createMomentumLagStrategy({ minUnderlyingMove: 0.001, minNetEdge: 0.01 }) },
    ]);
    expect(context.features.underlyingReturn1m).not.toBeNull();
    expect(context.quote).toBeNull();
    for (const signal of signals) {
      expect(signal.strategySlug).toBe("underlying-momentum-lag");
      expect(["BUY", "SELL", "EXIT", "FLAT"]).toContain(signal.direction);
    }
    const mapped = toHypothetical("x", {
      strategyId: "x",
      marketId: "m1",
      timestamp: now,
      direction: "BUY",
      marketProbability: 0.4,
      fairProbability: 0.6,
      grossEdge: 0.2,
      estimatedFees: 0,
      estimatedSlippage: 0,
      estimatedPriceImpact: 0,
      netEdge: 0.2,
      confidence: 0.1,
      reason: "test",
      riskChecks: [],
    });
    expect(mapped.netEdge).toBe(0.2);
  });
});
