import { asNumber } from "@/lib/normalize/numbers";
import { feeAmountToUsdt } from "@/lib/paper/quote-validate";

/** Wait this long after an expired close before calling batchRedeem. */
export const LIVE_CLAIM_DELAY_MS = 60_000;
/** If a batch redeem fails, wait this long between single-token retries. */
export const LIVE_CLAIM_STAGGER_MS = 90_000;

/** Binance position tabs. Claimable winners live under PENDING_CLAIM, not ONGOING. */
export const VENUE_POSITION_TABS = ["ONGOING", "PENDING_CLAIM", "ENDED"] as const;
export type VenuePositionTab = (typeof VENUE_POSITION_TABS)[number];

const FINISHED = new Set(["CONFIRMED", "CLAIMED", "REDEEMED", "SUCCESS", "DONE"]);
const IN_FLIGHT = new Set(["PENDING", "SUBMITTED"]);

export interface ClaimState {
  eligibleAt: string | null;
  startedAt: string | null;
  txHash: string | null;
  status: string | null;
}

export interface VenuePositionNumbers {
  venuePositionId: string | null;
  tokenId: string | null;
  shares: number | null;
  /** Shares still on the book (ONGOING). Settled tabs are 0 — do not SELL those. */
  tradableShares: number | null;
  avgPrice: number | null;
  totalCost: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  claimAmount: number | null;
  canClaim: boolean;
  redeemStatus: string | null;
  closePrice: number | null;
  expired: boolean;
}

export function venueAmount(value: unknown): number | null {
  return feeAmountToUsdt(value) ?? asNumber(value);
}

export function parseClaimState(raw: unknown): ClaimState {
  const claim =
    raw && typeof raw === "object" && "claim" in raw
      ? (raw as { claim?: unknown }).claim
      : raw;
  if (!claim || typeof claim !== "object") {
    return { eligibleAt: null, startedAt: null, txHash: null, status: null };
  }
  const row = claim as Record<string, unknown>;
  return {
    eligibleAt: typeof row.eligibleAt === "string" ? row.eligibleAt : null,
    startedAt: typeof row.startedAt === "string" ? row.startedAt : null,
    txHash: typeof row.txHash === "string" ? row.txHash : null,
    status: typeof row.status === "string" ? row.status : null,
  };
}

export function isClaimFinished(state: ClaimState): boolean {
  if (state.status && FINISHED.has(state.status.toUpperCase())) return true;
  return false;
}

export function isClaimInFlight(state: ClaimState, now = new Date()): boolean {
  if (isClaimFinished(state)) return false;
  if (state.txHash) return true;
  if (state.status && IN_FLIGHT.has(state.status.toUpperCase())) {
    if (!state.startedAt) return true;
    const started = Date.parse(state.startedAt);
    if (!Number.isFinite(started)) return true;
    return now.getTime() - started < LIVE_CLAIM_STAGGER_MS;
  }
  return false;
}

export function isRedeemedStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return FINISHED.has(status.toUpperCase());
}

export function stampClaimEligibleAt(raw: unknown, eligibleAt: Date): Record<string, unknown> {
  const base =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  const existing = parseClaimState(base);
  if (existing.eligibleAt) {
    return { ...base, expired: true, claim: { ...existing } };
  }
  return {
    ...base,
    expired: true,
    claim: {
      ...existing,
      eligibleAt: eligibleAt.toISOString(),
    },
  };
}

export function mergeClaimState(
  raw: unknown,
  patch: Partial<ClaimState> & { expired?: boolean },
): Record<string, unknown> {
  const base =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  const existing = parseClaimState(base);
  return {
    ...base,
    expired: patch.expired === true || base.expired === true || existing.eligibleAt != null,
    claim: {
      eligibleAt: patch.eligibleAt ?? existing.eligibleAt,
      startedAt: patch.startedAt ?? existing.startedAt,
      txHash: patch.txHash ?? existing.txHash,
      status: patch.status ?? existing.status,
    },
  };
}

/**
 * Claim only after expiry + delay, never while a redeem is already pending,
 * and only when Binance says there is something to collect.
 */
export function shouldClaimPosition(options: {
  now: Date;
  expired: boolean;
  claim: ClaimState;
  canClaim: boolean;
  claimAmount: number | null;
  /** Manual «Отримати все»: Binance already lists PENDING_CLAIM, skip the 1m timer. */
  immediate?: boolean;
}): boolean {
  if (!options.expired) return false;
  if (isClaimFinished(options.claim) || isRedeemedStatus(options.claim.status)) return false;
  if (isClaimInFlight(options.claim, options.now)) return false;
  if (!options.canClaim && !(options.claimAmount != null && options.claimAmount > 0)) return false;
  if (!options.immediate) {
    if (!options.claim.eligibleAt) return false;
    const at = Date.parse(options.claim.eligibleAt);
    if (!Number.isFinite(at) || options.now.getTime() < at) return false;
  }
  if (options.claim.status?.toUpperCase() === "FAILED" && options.claim.startedAt) {
    const started = Date.parse(options.claim.startedAt);
    if (Number.isFinite(started) && options.now.getTime() - started < LIVE_CLAIM_STAGGER_MS) {
      return false;
    }
  }
  return true;
}

export function mergeVenuePosition(
  existing: VenuePositionNumbers | undefined,
  mapped: VenuePositionNumbers,
  tab?: string,
): VenuePositionNumbers {
  const pendingClaim = tab === "PENDING_CLAIM";
  const ended = pendingClaim || tab === "ENDED";
  const tradableShares = ended ? 0 : (mapped.shares ?? existing?.tradableShares ?? null);
  if (!existing) {
    return {
      ...mapped,
      tradableShares,
      canClaim: mapped.canClaim || pendingClaim,
      expired: mapped.expired || ended,
    };
  }
  return {
    ...existing,
    ...mapped,
    tradableShares,
    canClaim: mapped.canClaim || pendingClaim || existing.canClaim,
    expired: mapped.expired || ended || existing.expired,
    claimAmount: mapped.claimAmount ?? existing.claimAmount,
    realizedPnl: mapped.realizedPnl ?? existing.realizedPnl,
    closePrice: mapped.closePrice ?? existing.closePrice,
    redeemStatus: mapped.redeemStatus ?? existing.redeemStatus,
  };
}

export function mapVenuePosition(row: {
  positionId?: string | number | bigint;
  tokenId?: string;
  shares?: string;
  avgPrice?: string;
  totalCost?: string;
  realizedPnl?: string;
  unrealizedPnl?: string;
  pnl?: string;
  claimAmount?: string;
  canClaim?: boolean;
  redeemStatus?: string;
  currentPrice?: string;
  positionStatus?: string;
  isWinner?: boolean;
}): VenuePositionNumbers {
  const shares = venueAmount(row.shares);
  const claimAmount = venueAmount(row.claimAmount);
  const currentPrice = venueAmount(row.currentPrice);
  const closePrice =
    currentPrice ??
    (shares != null && shares > 0 && claimAmount != null ? claimAmount / shares : null);
  const realized = venueAmount(row.realizedPnl) ?? venueAmount(row.pnl);
  const status = (row.positionStatus ?? row.redeemStatus ?? "").toUpperCase();
  const expired =
    row.isWinner != null ||
    row.canClaim === true ||
    claimAmount != null ||
    Boolean(row.redeemStatus) ||
    /ENDED|SETTLED|CLAIM|RESOLVED|EXPIRED/.test(status);
  return {
    venuePositionId: row.positionId != null ? String(row.positionId) : null,
    tokenId: row.tokenId ?? null,
    shares,
    tradableShares: shares,
    avgPrice: venueAmount(row.avgPrice),
    totalCost: venueAmount(row.totalCost),
    realizedPnl: realized,
    unrealizedPnl: venueAmount(row.unrealizedPnl),
    claimAmount,
    canClaim: row.canClaim === true,
    redeemStatus: row.redeemStatus ?? null,
    closePrice,
    expired,
  };
}

export function pickClaimTokenIds(ready: string[]): string[] {
  return [...new Set(ready.filter(Boolean))];
}

export function pickSingleClaimToken(
  ready: string[],
  lastStartedAt: Date | null,
  now: Date,
): string[] {
  const unique = pickClaimTokenIds(ready);
  if (unique.length === 0) return [];
  if (
    lastStartedAt &&
    now.getTime() - lastStartedAt.getTime() < LIVE_CLAIM_STAGGER_MS
  ) {
    return [];
  }
  return unique.slice(0, 1);
}
