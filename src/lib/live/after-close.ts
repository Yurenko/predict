import { childLogger } from "@/lib/logger";
import type { LiveTradeContext } from "@/lib/live/engine";
import { syncLiveOrdersFromVenue } from "@/lib/live/reconcile";
import { LIVE_CLAIM_AFTER_CLOSE_MS } from "@/lib/live/sync-scope";
import {
  claimLiveWinnings,
  syncLivePositionsFromVenue,
  type LivePositionVenue,
} from "@/lib/live/venue-sync";

const log = childLogger({ component: "live-after-close" });

type AfterCloseVenue = LivePositionVenue & {
  queryOrderHistory: Parameters<typeof syncLiveOrdersFromVenue>[0]["queryOrderHistory"];
  queryActiveOrders: Parameters<typeof syncLiveOrdersFromVenue>[0]["queryActiveOrders"];
};

let claimTimer: ReturnType<typeof setTimeout> | null = null;
let claimRunning = false;
let claimPending = false;

export async function refreshLiveAccountAfterClose(
  venue: AfterCloseVenue,
  ctx: LiveTradeContext,
): Promise<void> {
  const applied = await syncLiveOrdersFromVenue(venue, ctx.walletAddress);
  if (applied > 0) log.info({ applied }, "live reconcile after close");
  const venueSync = await syncLivePositionsFromVenue(venue, ctx, { claim: false });
  log.info(venueSync, "live venue position sync after close");
}

/**
 * One batchRedeem/ENDED pass 30s after a close. Later closes in that window
 * share the same shot; a close during the pass arms one more delay.
 */
export function armLiveClaimAfterClose(venue: AfterCloseVenue, ctx: LiveTradeContext): void {
  claimPending = true;
  if (claimTimer != null || claimRunning) return;
  claimTimer = setTimeout(() => {
    claimTimer = null;
    void runArmedClaim(venue, ctx);
  }, LIVE_CLAIM_AFTER_CLOSE_MS);
}

async function runArmedClaim(venue: AfterCloseVenue, ctx: LiveTradeContext): Promise<void> {
  if (claimRunning) {
    claimPending = true;
    return;
  }
  claimPending = false;
  claimRunning = true;
  try {
    const result = await claimLiveWinnings(venue, ctx);
    if (result.claimed > 0) log.info(result, "live claim after close");
  } catch (error) {
    log.warn({ err: String(error) }, "live claim after close skipped");
  } finally {
    claimRunning = false;
    if (claimPending) armLiveClaimAfterClose(venue, ctx);
  }
}

export function resetLiveClaimScheduleForTests(): void {
  if (claimTimer != null) clearTimeout(claimTimer);
  claimTimer = null;
  claimRunning = false;
  claimPending = false;
}
