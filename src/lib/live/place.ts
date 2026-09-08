import type { PlaceOrderParams } from "@/lib/binance/prediction-adapter";

export interface LivePlaceDraft {
  walletAddress: string;
  walletId: string;
  quoteId: string;
  slippageBps: number;
  accountType: "SPOT" | "FUNDING";
}

/**
 * Official MARKET place-order body.
 * timeInForce must be FOK when orderType is MARKET (SDK Place Order notes).
 * feeRateBps is not a placeOrder field; fees come from getQuote / order history.
 */
export function formatLimitPrice(price: number): string {
  if (!Number.isFinite(price) || !(price > 0)) {
    throw new Error("LIMIT priceLimit must be > 0");
  }
  return Math.min(1, price).toFixed(8);
}

export function buildMarketPlaceOrder(draft: LivePlaceDraft): PlaceOrderParams {
  const slippageBps = Math.min(Math.max(Math.trunc(draft.slippageBps), 1), 10_000);
  return {
    walletAddress: draft.walletAddress,
    walletId: draft.walletId,
    quoteId: draft.quoteId,
    timeInForce: "FOK",
    accountType: draft.accountType,
    orderType: "MARKET",
    slippageBps,
  };
}

/** EXIT flatten: GTC stays on the book until the full amountIn is sold. MARKET FOK cannot. */
export function buildLimitPlaceOrder(
  draft: LivePlaceDraft & { priceLimit: number },
): PlaceOrderParams {
  const slippageBps = Math.min(Math.max(Math.trunc(draft.slippageBps), 1), 10_000);
  return {
    walletAddress: draft.walletAddress,
    walletId: draft.walletId,
    quoteId: draft.quoteId,
    timeInForce: "GTC",
    accountType: draft.accountType,
    orderType: "LIMIT",
    slippageBps,
    priceLimit: formatLimitPrice(draft.priceLimit),
  };
}
