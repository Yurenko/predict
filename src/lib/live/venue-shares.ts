import type { W3WPredictionRestAPI } from "@binance/w3w-prediction";
import { mapVenuePosition } from "@/lib/live/claim";

/** ONGOING inventory for this token — EXIT must sell this, not a stale local leftover. */
export async function readVenueTradableShares(
  venue: {
    queryPositions: (
      params: W3WPredictionRestAPI.QueryPositionsRequest,
      extra?: { urgent?: boolean },
    ) => Promise<W3WPredictionRestAPI.QueryPositionsResponse>;
  },
  walletAddress: string,
  tokenId: string,
  options?: { urgent?: boolean },
): Promise<number | null> {
  const page = await venue.queryPositions(
    {
      walletAddress,
      tab: "ONGOING",
      limit: 100,
    },
    options,
  );
  for (const row of page.positions ?? []) {
    const mapped = mapVenuePosition(row);
    if (mapped.tokenId !== tokenId) continue;
    if (mapped.tradableShares != null && Number.isFinite(mapped.tradableShares)) {
      return Math.max(0, mapped.tradableShares);
    }
  }
  return 0;
}
