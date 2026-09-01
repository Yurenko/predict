import { describe, expect, it } from "vitest";
import { markPrice, unrealizedPnl } from "./mark";
import { containsSecrets } from "./sanitize";
import { emptyDashboard } from "./load";

describe("markPrice", () => {
  it("marks a long at the bid, never lastPrice", () => {
    const marked = markPrice("BUY", { bestBid: 0.44, bestAsk: 0.46, lastPrice: 0.99 });
    expect(marked).toEqual({ mark: 0.44, source: "bid" });
    expect(marked.mark).not.toBe(0.99);
  });

  it("marks a short at the ask", () => {
    const marked = markPrice("SELL", { bestBid: 0.44, bestAsk: 0.46, lastPrice: 0.99 });
    expect(marked).toEqual({ mark: 0.46, source: "ask" });
  });

  it("returns none when the executable book is missing", () => {
    expect(markPrice("BUY", { bestBid: null, bestAsk: 0.46, lastPrice: 0.99 }).source).toBe("none");
  });
});

describe("unrealizedPnl", () => {
  it("computes long PnL against the mark", () => {
    expect(unrealizedPnl("BUY", 0.4, 10, 0.44)).toBeCloseTo(0.4);
  });
});

describe("dashboard secrets", () => {
  it("empty payload does not leak credential field names", () => {
    const payload = emptyDashboard();
    expect(containsSecrets(payload)).toBe(false);
    expect(payload.hasPaperKeys).toBeTypeOf("boolean");
    expect(payload.hasLiveKeys).toBeTypeOf("boolean");
    expect(payload.hasLiveKeys).toBe(false);
    expect(payload.hasWallet).toBeTypeOf("boolean");
    expect(JSON.stringify(payload)).not.toMatch(/BINANCE_.*API_/);
  });

  it("flags objects that embed API keys", () => {
    expect(containsSecrets({ BINANCE_PAPER_API_KEY: "abc" })).toBe(true);
    expect(containsSecrets({ apiSecret: "x" })).toBe(true);
  });
});
