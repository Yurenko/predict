import { describe, expect, it } from "vitest";
import { mapOfficialQuote, quoteHasExecutableCosts } from "./quote";

describe("mapOfficialQuote", () => {
  it("keeps official fee fields and does not invent a 200 bps default", () => {
    const quote = mapOfficialQuote({
      quoteId: "q-1",
      tokenId: "tok-1",
      averagePrice: 0.51,
      lastPrice: 0.5,
      feeAmount: "1000000000000000",
      feeRateBps: 180,
      slippageBps: 1000,
      priceImpact: 0.002,
      minReceive: "0.9",
    });

    expect(quote.feeRateBps).toBe(180);
    expect(quote.feeAmount).toBe("1000000000000000");
    expect(quoteHasExecutableCosts(quote)).toBe(true);
  });

  it("leaves fees undefined when the API omitted them", () => {
    const quote = mapOfficialQuote({
      quoteId: "q-2",
      tokenId: "tok-2",
      averagePrice: 0.4,
    });

    expect(quote.feeRateBps).toBeUndefined();
    expect(quote.feeAmount).toBeUndefined();
    expect(quoteHasExecutableCosts(quote)).toBe(false);
  });

  it("rejects a quote without quoteId", () => {
    expect(() => mapOfficialQuote({ tokenId: "tok" })).toThrow(/quoteId/);
  });
});
