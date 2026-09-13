import { OfficialPredictionAdapter, type GetQuoteParams } from "@/lib/binance/prediction-adapter";
import { env } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";
import { quoteAmountInWei } from "@/lib/paper/amounts";
import { paperQuoteFromOfficial, type PaperQuote } from "@/lib/paper/quote-validate";
import { inc } from "@/lib/observability/metrics";

const log = childLogger({ component: "paper-quote" });

let adapter: OfficialPredictionAdapter | null | undefined;

function quoteAdapter(): OfficialPredictionAdapter | null {
  if (adapter !== undefined) return adapter;
  try {
    adapter = OfficialPredictionAdapter.fromEnv();
  } catch (error) {
    log.warn({ err: String(error) }, "paper getQuote adapter unavailable");
    adapter = null;
  }
  return adapter;
}

/**
 * Official getQuote. Never sends feeRateBps or placeOrder.
 */
export async function fetchOfficialPaperQuoteResult(options: {
  tokenId: string;
  side: "BUY" | "SELL";
  amountUsdt?: number;
  /** SELL only: tradable shares (Binance Max). Ignored on BUY. */
  amountShares?: number;
  slippageBps: number;
  orderType?: "MARKET" | "LIMIT";
  priceLimit?: number;
}): Promise<{ quote: PaperQuote | null; exceededShares: boolean }> {
  const wallet = env.BINANCE_PREDICTION_WALLET_ADDRESS.trim();
  if (!wallet) {
    inc("quote.skip", { reason: "no_wallet" });
    return { quote: null, exceededShares: false };
  }
  const client = quoteAdapter();
  if (!client) {
    inc("quote.skip", { reason: "no_adapter" });
    return { quote: null, exceededShares: false };
  }
  try {
    const orderType = options.orderType === "LIMIT" ? "LIMIT" : "MARKET";
    const official = await client.getQuote({
      walletAddress: wallet,
      tokenId: options.tokenId,
      side: options.side as GetQuoteParams["side"],
      amountIn: quoteAmountInWei({
        side: options.side,
        amountUsdt: options.amountUsdt,
        amountShares: options.amountShares,
      }),
      orderType: orderType as GetQuoteParams["orderType"],
      slippageBps: Math.min(Math.max(Math.trunc(options.slippageBps), 1), 10_000),
      chainId: env.BINANCE_PREDICTION_CHAIN_ID,
      fundingSource: "MPC",
      ...(orderType === "LIMIT" && options.priceLimit != null && options.priceLimit > 0
        ? { priceLimit: options.priceLimit.toFixed(8) }
        : {}),
    });
    inc("quote.ok");
    return {
      quote: {
        ...paperQuoteFromOfficial(official),
        orderType,
        priceLimit: orderType === "LIMIT" ? options.priceLimit ?? null : null,
      },
      exceededShares: false,
    };
  } catch (error) {
    inc("quote.fail");
    const err = String(error);
    log.warn({ err, tokenId: options.tokenId }, "getQuote failed; paper fills from last book");
    return { quote: null, exceededShares: /exceeded your available shares/i.test(err) };
  }
}

export async function fetchOfficialPaperQuote(options: {
  tokenId: string;
  side: "BUY" | "SELL";
  amountUsdt?: number;
  amountShares?: number;
  slippageBps: number;
}): Promise<PaperQuote | null> {
  const { quote } = await fetchOfficialPaperQuoteResult(options);
  return quote;
}

export function hasPredictionWallet(): boolean {
  return env.BINANCE_PREDICTION_WALLET_ADDRESS.trim().length > 0;
}
