import { OfficialPredictionAdapter } from "@/lib/binance/prediction-adapter";
import { env } from "@/lib/config/env";
import { resolveWalletId, type LiveTradeContext } from "@/lib/live";
import { childLogger } from "@/lib/logger";

const log = childLogger({ component: "live-runtime" });

const LIVE_SKIP = {
  adapter: "live_adapter_unavailable",
  wallet: "missing_wallet_id",
} as const;

type LiveRuntimeCache = {
  __botpolLiveVenue?: OfficialPredictionAdapter;
  __botpolLiveCtx?: LiveTradeContext;
  __botpolLiveSkip?: string;
};

const cache = globalThis as unknown as LiveRuntimeCache;

export type LiveRuntime =
  | { ok: true; venue: OfficialPredictionAdapter; ctx: LiveTradeContext }
  | { ok: false; skip: string };

/**
 * One adapter + walletId per dashboard process. Init is lazy so
 * `npm run dev:live` does not placeOrder until Start.
 */
export async function ensureLiveRuntime(): Promise<LiveRuntime> {
  if (cache.__botpolLiveVenue && cache.__botpolLiveCtx) {
    return { ok: true, venue: cache.__botpolLiveVenue, ctx: cache.__botpolLiveCtx };
  }
  if (cache.__botpolLiveSkip) {
    return { ok: false, skip: cache.__botpolLiveSkip };
  }

  let venue: OfficialPredictionAdapter;
  try {
    venue = OfficialPredictionAdapter.fromEnv();
  } catch (error) {
    const skip = LIVE_SKIP.adapter;
    cache.__botpolLiveSkip = skip;
    log.error({ err: String(error) }, "live adapter unavailable");
    return { ok: false, skip };
  }

  const walletAddress = env.BINANCE_PREDICTION_WALLET_ADDRESS.trim();
  const walletId = await resolveWalletId({
    walletAddress,
    configuredWalletId: env.BINANCE_PREDICTION_WALLET_ID,
    listWallets: () => venue.listPredictionWallets(),
  });
  if (!walletId) {
    const skip = LIVE_SKIP.wallet;
    cache.__botpolLiveSkip = skip;
    log.error("walletId missing; set BINANCE_PREDICTION_WALLET_ID or register the wallet");
    return { ok: false, skip };
  }

  const ctx: LiveTradeContext = {
    walletAddress,
    walletId,
    accountType: env.BINANCE_PREDICTION_ACCOUNT_TYPE,
  };
  cache.__botpolLiveVenue = venue;
  cache.__botpolLiveCtx = ctx;
  return { ok: true, venue, ctx };
}

export function resetLiveRuntimeForTests(): void {
  delete cache.__botpolLiveVenue;
  delete cache.__botpolLiveCtx;
  delete cache.__botpolLiveSkip;
}
