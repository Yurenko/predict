import { OfficialPredictionAdapter, type GetQuoteParams } from "@/lib/binance/prediction-adapter";
import { env } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";
import { usdtToWei } from "@/lib/paper/amounts";
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
 * Official getQuote for paper fills. Never sends feeRateBps or placeOrder.
 * Returns null when wallet/keys are missing or the API call fails.
 */
export async function fetchOfficialPaperQuote(options: {
  tokenId: string;
  side: "BUY" | "SELL";
  amountUsdt: number;
  slippageBps: number;
}): Promise<PaperQuote | null> {
  const wallet = env.BINANCE_PREDICTION_WALLET_ADDRESS.trim();
  if (!wallet) {
    inc("quote.skip", { reason: "no_wallet" });
    return null;
  }
  const client = quoteAdapter();
  if (!client) {
    inc("quote.skip", { reason: "no_adapter" });
    return null;
  }
  try {
    const official = await client.getQuote({
      walletAddress: wallet,
      tokenId: options.tokenId,
      side: options.side as GetQuoteParams["side"],
      amountIn: usdtToWei(options.amountUsdt),
      orderType: "MARKET" as GetQuoteParams["orderType"],
      slippageBps: Math.min(Math.max(Math.trunc(options.slippageBps), 1), 10_000),
      chainId: env.BINANCE_PREDICTION_CHAIN_ID,
    });
    inc("quote.ok");
    return paperQuoteFromOfficial(official);
  } catch (error) {
    inc("quote.fail");
    log.warn({ err: String(error), tokenId: options.tokenId }, "getQuote failed; paper fills from last book");
    return null;
  }
}

export function hasPredictionWallet(): boolean {
  return env.BINANCE_PREDICTION_WALLET_ADDRESS.trim().length > 0;
}
