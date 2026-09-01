import type { W3WPredictionRestAPI } from "@binance/w3w-prediction";

export type OfficialQuote = W3WPredictionRestAPI.GetQuoteResponse & {
  raw: W3WPredictionRestAPI.GetQuoteResponse;
};

/**
 * Map an official GetQuoteResponse.
 * Never fill feeRateBps / feeAmount from a hardcoded default — if the API
 * omitted them, leave them undefined so PnL code cannot pretend it knows the fee.
 */
export function mapOfficialQuote(
  data: W3WPredictionRestAPI.GetQuoteResponse,
): OfficialQuote {
  if (!data.quoteId || !data.tokenId) {
    throw new Error("GetQuoteResponse is missing quoteId or tokenId");
  }

  return {
    ...data,
    feeRateBps: typeof data.feeRateBps === "number" ? data.feeRateBps : undefined,
    feeAmount: data.feeAmount,
    slippageBps: typeof data.slippageBps === "number" ? data.slippageBps : undefined,
    priceImpact: typeof data.priceImpact === "number" ? data.priceImpact : undefined,
    raw: data,
  };
}

export function quoteHasExecutableCosts(quote: OfficialQuote): boolean {
  return quote.feeAmount !== undefined || quote.feeRateBps !== undefined;
}
