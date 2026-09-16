import { describe, expect, it, vi } from "vitest";
import { quoteLiveExitSell } from "./exit-quote";

vi.mock("@/lib/paper/fetch-quote", () => ({
  fetchOfficialPaperQuoteResult: vi.fn(async (options: {
    side: string;
    amountShares?: number;
    orderType?: string;
  }) => {
    expect(options.side).toBe("SELL");
    expect(options.orderType).toBe("MARKET");
    expect(options.amountShares).toBe(4);
    return {
      quote: {
        quoteId: "q-exit",
        tokenId: "yes-1",
        averagePrice: 0.5,
        lastPrice: null,
        chance: 0.5,
        feeAmount: 0,
        feeRateBps: 100,
        slippageBps: 50,
        priceImpact: 0.01,
        minReceive: null,
        expireAt: new Date("2026-01-01T00:05:00.000Z"),
        orderType: "MARKET",
        priceLimit: null,
      },
      exceededShares: false,
    };
  }),
}));

describe("quoteLiveExitSell", () => {
  it("quotes a MARKET sell for the full Max share stack", async () => {
    const result = await quoteLiveExitSell({
      tokenId: "yes-1",
      shares: 4,
      bestBid: 0.5,
      bestAsk: 0.52,
      lastPrice: 0.51,
      avgPrice: 0.4,
      slippageBps: 1000,
    });
    expect(result.belowMin).toBe(false);
    expect(result.quote?.quoteId).toBe("q-exit");
    expect(result.quote?.orderType).toBe("MARKET");
    expect(result.priceLimit).toBeNull();
    expect(result.notional).toBeCloseTo(2);
  });
});
