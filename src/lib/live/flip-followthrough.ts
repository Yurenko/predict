import { OrderStatus } from "@prisma/client";
import type { W3WPredictionRestAPI } from "@binance/w3w-prediction";
import { sleep } from "@/lib/binance/rate-limit";
import { mapOfficialOrderStatus } from "@/lib/live/status";
import { readVenueTradableShares } from "@/lib/live/venue-shares";
import { asNumber } from "@/lib/normalize/numbers";
import type { PendingFlipSide } from "@/lib/live/pending-flip";

export const LIVE_FLIP_EXIT_CONFIRM_TIMEOUT_MS = 2_500;
export const LIVE_FLIP_EXIT_CONFIRM_INTERVAL_MS = 0;

type HistoryOrder = W3WPredictionRestAPI.QueryOrderHistoryResponseOrdersInner;

export function shouldImmediateFlipEnter(options: {
  oppositeCloses: boolean;
  exitPlaced: boolean;
  managementExit: boolean;
  wantedSide: PendingFlipSide | null;
}): boolean {
  return (
    options.oppositeCloses &&
    options.exitPlaced &&
    !options.managementExit &&
    options.wantedSide != null
  );
}

export function officialFlipExitStatus(row: {
  status?: string;
  fillPercentage?: string;
  filledShareQty?: string;
} | null | undefined): OrderStatus | null {
  if (!row) return null;
  let status = mapOfficialOrderStatus(row.status);
  const fillPct = asNumber(row.fillPercentage);
  const shares = asNumber(row.filledShareQty) ?? 0;
  if (fillPct !== null && fillPct >= 1 && shares > 0) return OrderStatus.FILLED;
  if (status === OrderStatus.PARTIALLY_FILLED) return OrderStatus.SUBMITTED;
  return status;
}

/**
 * Inventory is the source of truth. Do not wait for a FILLED label once
 * ONGOING shares are already 0. FAILED/CANCELLED never proceed to ENTER.
 */
export function liveFlipExitConfirmResult(options: {
  orderStatus: string | null | undefined;
  leftoverShares: number | null;
  timedOut: boolean;
}): { ready: boolean; failed: boolean; reason: "filled" | "failed" | "timeout" | "waiting" } {
  const leftoverGone = options.leftoverShares != null && options.leftoverShares <= 1e-8;
  const status = options.orderStatus ?? null;
  if (status === "FAILED" || status === "CANCELLED" || status === "EXPIRED") {
    return { ready: false, failed: true, reason: "failed" };
  }
  if (leftoverGone) {
    return { ready: true, failed: false, reason: "filled" };
  }
  if (options.timedOut) {
    return { ready: false, failed: false, reason: "timeout" };
  }
  return { ready: false, failed: false, reason: "waiting" };
}

export async function confirmLiveFlipExit(options: {
  venue: {
    queryOrderHistory: (
      params: W3WPredictionRestAPI.QueryOrderHistoryRequest,
      extra?: { urgent?: boolean },
    ) => Promise<W3WPredictionRestAPI.QueryOrderHistoryResponse>;
    queryPositions: (
      params: W3WPredictionRestAPI.QueryPositionsRequest,
      extra?: { urgent?: boolean },
    ) => Promise<W3WPredictionRestAPI.QueryPositionsResponse>;
  };
  walletAddress: string;
  venueOrderId: string;
  tokenId: string;
  timeoutMs?: number;
  intervalMs?: number;
  nowMs?: () => number;
  wait?: (ms: number) => Promise<void>;
  readLeftoverShares?: (tokenId: string) => Promise<number | null>;
}): Promise<{
  ready: boolean;
  failed: boolean;
  reason: "filled" | "failed" | "timeout" | "waiting";
  status: string | null;
  leftoverShares: number | null;
  order: HistoryOrder | null;
}> {
  const timeoutMs = options.timeoutMs ?? LIVE_FLIP_EXIT_CONFIRM_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? LIVE_FLIP_EXIT_CONFIRM_INTERVAL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const wait = options.wait ?? sleep;
  const readShares =
    options.readLeftoverShares ??
    ((tokenId: string) =>
      readVenueTradableShares(options.venue, options.walletAddress, tokenId, { urgent: true }));
  const started = nowMs();
  let status: string | null = null;
  let leftoverShares: number | null = null;
  let order: HistoryOrder | null = null;

  while (true) {
    const timedOut = nowMs() - started >= timeoutMs;
    const historyTask = options.venue
      .queryOrderHistory({ walletAddress: options.walletAddress, limit: 50 }, { urgent: true })
      .then((history) => {
        order = history.orders?.find((row) => row.orderId === options.venueOrderId) ?? order;
        status = officialFlipExitStatus(order);
      })
      .catch(() => undefined);
    const sharesTask = readShares(options.tokenId)
      .then((shares) => {
        leftoverShares = shares;
      })
      .catch(() => undefined);
    await Promise.all([historyTask, sharesTask]);
    const result = liveFlipExitConfirmResult({
      orderStatus: status,
      leftoverShares,
      timedOut,
    });
    if (result.ready || result.failed || result.reason === "timeout") {
      return { ...result, status, leftoverShares, order };
    }
    if (nowMs() - started >= timeoutMs) {
      return {
        ...liveFlipExitConfirmResult({
          orderStatus: status,
          leftoverShares,
          timedOut: true,
        }),
        status,
        leftoverShares,
        order,
      };
    }
    if (intervalMs > 0) await wait(intervalMs);
  }
}
