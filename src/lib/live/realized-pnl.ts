import { asNumber } from "@/lib/normalize/numbers";

export interface LiveRealizedFee {
  amount: unknown;
}

export interface LiveRealizedExecution {
  price: unknown;
  shares: unknown;
  usdtAmount: unknown;
  order: {
    side: "BUY" | "SELL";
    fees: LiveRealizedFee[];
  };
}

export interface LiveRealizedPosition {
  executions: LiveRealizedExecution[];
  rawPayload: unknown;
  closedAt: Date | null;
  endDate: Date | null;
}

function rawNumber(raw: unknown, key: string): number | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return asNumber((raw as Record<string, unknown>)[key]);
}

function rawBool(raw: unknown, key: string): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  return (raw as Record<string, unknown>)[key] === true;
}

/**
 * Rebuild LIVE realized PnL from the immutable execution ledger.
 *
 * Position.realizedPnl is only a cache. Settlement synchronization must be
 * idempotent, so the dashboard and venue sync use this deterministic value
 * instead of repeatedly adding a venue-level settlement PnL.
 */
export function calculateLiveRealizedPnl(
  row: LiveRealizedPosition,
  options: { includeSettlement: boolean; settlementValue?: number | null } = {
    includeSettlement: false,
  },
): number {
  let openShares = 0;
  let costBasis = 0;
  let realized = 0;

  for (const execution of row.executions) {
    const shares = asNumber(execution.shares) ?? 0;
    const notional = asNumber(execution.usdtAmount) ?? 0;
    if (!(shares > 0) || !(notional >= 0)) continue;

    const fees = execution.order.fees.reduce(
      (sum, fee) => sum + (asNumber(fee.amount) ?? 0),
      0,
    );

    if (execution.order.side === "BUY") {
      openShares += shares;
      costBasis += notional + fees;
      continue;
    }

    const closeShares = Math.min(shares, openShares);
    if (!(closeShares > 0) || !(openShares > 0)) continue;

    const averageCost = costBasis / openShares;
    const ratio = shares > 0 ? closeShares / shares : 0;
    realized += notional * ratio - averageCost * closeShares - fees * ratio;
    costBasis = Math.max(0, costBasis - averageCost * closeShares);
    openShares = Math.max(0, openShares - closeShares);
  }

  if (options.includeSettlement) {
    const settlementValue =
      options.settlementValue ??
      rawNumber(row.rawPayload, "venueSettlementValue") ??
      rawNumber(row.rawPayload, "claimAmount");
    if (settlementValue != null && Number.isFinite(settlementValue)) {
      realized += settlementValue - costBasis;
    }
  }

  return Number.isFinite(realized) ? realized : 0;
}

export function liveSettlementReady(row: {
  rawPayload: unknown;
  closedAt: Date | null;
  endDate: Date | null;
  now?: Date;
  delayMs?: number;
}): boolean {
  const now = row.now ?? new Date();
  const delayMs = row.delayMs ?? 60_000;
  const rawReadyAt = rawNumber(row.rawPayload, "settlementReadyAt");
  const settlementValue =
    rawNumber(row.rawPayload, "venueSettlementValue") ??
    rawNumber(row.rawPayload, "claimAmount");
  const settlementApplied = rawBool(row.rawPayload, "liveSettlementApplied");

  // Expiry + one minute is only a time gate. It is NOT proof that Binance has
  // returned the settlement for this exact position. Without an actual venue
  // settlement value (including zero for a loser), falling back to settlement
  // here would subtract the whole remaining cost from an otherwise correctly
  // closed SELL and turn a profitable exit into a false loss.
  if (settlementValue == null && !settlementApplied) return false;
  if (rawReadyAt != null) return now.getTime() >= rawReadyAt;
  if (row.closedAt == null || row.endDate == null) return false;
  return row.closedAt.getTime() >= row.endDate.getTime() &&
    now.getTime() >= row.endDate.getTime() + delayMs;
}
