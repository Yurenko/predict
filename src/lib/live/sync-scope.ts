import { LIVE_CLAIM_DELAY_MS, type VenuePositionTab } from "@/lib/live/claim";
import { asNumber } from "@/lib/normalize/numbers";

/** Inventory needed to ENTER/EXIT. ENDED history is claim/ledger only. */
export const LIVE_INVENTORY_TABS: readonly VenuePositionTab[] = ["ONGOING", "PENDING_CLAIM"];

/** One claim pass this long after a close; not a repeating ledger poll. */
export const LIVE_CLAIM_AFTER_CLOSE_MS = LIVE_CLAIM_DELAY_MS;

export function livePositionTabs(includeEnded: boolean): readonly VenuePositionTab[] {
  return includeEnded ? ["ONGOING", "PENDING_CLAIM", "ENDED"] : LIVE_INVENTORY_TABS;
}

export function shouldAssignLiveVenuePositionId(options: {
  rowId: string;
  ownerId: string | null | undefined;
}): boolean {
  if (!options.ownerId) return true;
  return options.ownerId === options.rowId;
}

export function liveReconcileWriteNeeded(options: {
  currentStatus: string;
  nextStatus: string;
  hasFillDelta: boolean;
  previousShares: number;
  cumulativeShares: number;
  previousNotional: number;
  cumulativeNotional: number;
  previousFee: number;
  cumulativeFee: number;
  previousNetwork: number;
  cumulativeNetwork: number;
  vendorOrderIdChanged: boolean;
  fillPctChanged: boolean;
  averagePriceChanged: boolean;
}): boolean {
  if (options.hasFillDelta) return true;
  if (options.currentStatus !== options.nextStatus) return true;
  if (options.vendorOrderIdChanged) return true;
  if (options.fillPctChanged) return true;
  if (options.averagePriceChanged) return true;
  if (Math.abs(options.cumulativeShares - options.previousShares) > 1e-12) return true;
  if (Math.abs(options.cumulativeNotional - options.previousNotional) > 1e-12) return true;
  if (Math.abs(options.cumulativeFee - options.previousFee) > 1e-12) return true;
  if (Math.abs(options.cumulativeNetwork - options.previousNetwork) > 1e-12) return true;
  return false;
}

/** Extra REST after the tick only when a position actually closed. ENTER already persisted locally. */
export function shouldRefreshLiveAccountAfterCycle(options: { closed: number }): boolean {
  return options.closed > 0;
}

/** Arm the delayed one-shot claim only after a close/expiry, never on a dry tick. */
export function shouldArmLiveClaimAfterClose(options: { closed: number }): boolean {
  return options.closed > 0;
}

export function sameLiveNumber(left: unknown, right: unknown): boolean {
  const a = asNumber(left);
  const b = asNumber(right);
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= 1e-10;
}

/** Skip venue overlay UPDATEs when Binance numbers already match the local row. */
export function liveOverlayWriteNeeded(
  current: {
    status: string;
    shares: unknown;
    avgPrice: unknown;
    totalCost: unknown;
    realizedPnl: unknown;
    unrealizedPnl: unknown;
    venuePositionId: string | null;
    closedAt: Date | null;
  },
  next: {
    status?: string;
    shares?: unknown;
    avgPrice?: unknown;
    totalCost?: unknown;
    realizedPnl?: unknown;
    unrealizedPnl?: unknown;
    venuePositionId?: string | null;
    closedAt?: Date | null;
    rawPayload?: unknown;
  },
): boolean {
  if (next.rawPayload !== undefined) return true;
  if (next.status !== undefined && next.status !== current.status) return true;
  if (next.venuePositionId !== undefined && next.venuePositionId !== current.venuePositionId) {
    return true;
  }
  if (next.closedAt !== undefined) {
    const nextClosed = next.closedAt?.getTime() ?? null;
    const currentClosed = current.closedAt?.getTime() ?? null;
    if (nextClosed !== currentClosed) return true;
  }
  if (next.shares !== undefined && !sameLiveNumber(next.shares, current.shares)) return true;
  if (next.avgPrice !== undefined && !sameLiveNumber(next.avgPrice, current.avgPrice)) return true;
  if (next.totalCost !== undefined && !sameLiveNumber(next.totalCost, current.totalCost)) {
    return true;
  }
  if (next.realizedPnl !== undefined && !sameLiveNumber(next.realizedPnl, current.realizedPnl)) {
    return true;
  }
  if (
    next.unrealizedPnl !== undefined &&
    !sameLiveNumber(next.unrealizedPnl, current.unrealizedPnl)
  ) {
    return true;
  }
  return false;
}
