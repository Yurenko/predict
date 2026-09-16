import { OrderStatus, PositionStatus, Prisma, TradingMode } from "@prisma/client";
import type { W3WPredictionRestAPI } from "@binance/w3w-prediction";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/config/env";
import { asNumber } from "@/lib/normalize/numbers";
import { childLogger } from "@/lib/logger";
import { feeAmountToUsdt } from "@/lib/paper/quote-validate";
import { mapOfficialOrderStatus } from "@/lib/live/status";
import {
  applyLiveFillToPosition,
  completeOfficialFill,
  LIVE_INFLIGHT_STATUSES,
  shouldReleaseStaleLiveInflight,
  type LivePositionSnapshot,
} from "@/lib/live/position-fill";
import { clearLiveFlatten } from "@/lib/live/flatten";
import { inc } from "@/lib/observability/metrics";
import { limitsFromEnv } from "@/lib/risk/limits";
import { loadRiskState, persistRiskSnapshot } from "@/lib/risk/persist";
import { recordClosedTrade } from "@/lib/risk/state";

const log = childLogger({ component: "live-reconcile" });

type OfficialOrder =
  | W3WPredictionRestAPI.QueryOrderHistoryResponseOrdersInner
  | W3WPredictionRestAPI.QueryActiveOrdersResponseOrdersInner;

function numericAmount(value: string | undefined): number | null {
  const fromFeeHelper = feeAmountToUsdt(value);
  if (fromFeeHelper !== null) return fromFeeHelper;
  return asNumber(value);
}

function fillFromOfficial(row: OfficialOrder) {
  const notional = numericAmount(row.filledUsdtAmount);
  const shares = numericAmount(row.filledShareQty);
  const price = asNumber(row.price);
  const fillPct = asNumber(row.fillPercentage);
  let status = mapOfficialOrderStatus(row.status);
  // Prefer the quantitative fill progress when it contradicts a generic
  // "OPEN"/"SUBMITTED" status. The venue's cumulative filled quantities are
  // the safest indicator of whether an execution actually happened.
  // LIVE never persists PARTIALLY_FILLED. Binance reports cumulative fill
  // progress, but a partially filled GTC order remains an active SUBMITTED
  // order in our state machine. This keeps partial fills from becoming a
  // blocking terminal/inflight state while still applying every fill delta.
  if (fillPct !== null && fillPct >= 1 && (shares ?? 0) > 0) {
    status = OrderStatus.FILLED;
  } else if (status === OrderStatus.PARTIALLY_FILLED) {
    status = OrderStatus.SUBMITTED;
  } else if (
    status === OrderStatus.SUBMITTED &&
    (shares ?? 0) > 0
  ) {
    status = OrderStatus.SUBMITTED;
  }
  return {
    status,
    notional,
    shares,
    price,
    fee: numericAmount(row.marketProviderFee) ?? 0,
    network: numericAmount(row.networkFee) ?? 0,
    fillPct,
  };
}

function snapshotFromRow(row: {
  id: string;
  side: LivePositionSnapshot["side"];
  shares: Prisma.Decimal | number | string;
  avgPrice: Prisma.Decimal | number | string;
  totalCost: Prisma.Decimal | number | string;
  feesPaid: Prisma.Decimal | number | string;
  networkCostPaid: Prisma.Decimal | number | string;
  realizedPnl: Prisma.Decimal | number | string;
}): LivePositionSnapshot {
  return {
    id: row.id,
    side: row.side,
    shares: Number(row.shares),
    avgPrice: Number(row.avgPrice),
    totalCost: Number(row.totalCost),
    feesPaid: Number(row.feesPaid),
    networkCostPaid: Number(row.networkCostPaid),
    realizedPnl: Number(row.realizedPnl),
  };
}

function jsonPayload(
  existing: Prisma.JsonValue | null | undefined,
  extra: Record<string, unknown>,
): Prisma.InputJsonValue {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, ...extra } as Prisma.InputJsonValue;
}


/**
 * Binance reports cumulative fill quantities. Never persist the cumulative
 * number as a new Execution on every poll: apply only the delta since the
 * last checkpoint stored on Order.
 *
 * This is the critical invariant for LIVE:
 *   venue filled = 100
 *   DB already applied = 40
 *   next execution = 60, not another 100.
 */
export async function applyOfficialLiveOrder(row: OfficialOrder): Promise<{ applied: boolean; realizedDelta: number }> {
  if (!row.orderId) return { applied: false, realizedDelta: 0 };

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { mode: TradingMode.LIVE, venueOrderId: row.orderId },
      include: {
        executions: { orderBy: { executedAt: "desc" } },
        position: true,
        signal: { select: { strategyId: true } },
      },
    });
    if (!order) return { applied: false, realizedDelta: 0 };

    const parsed = fillFromOfficial(row);
    const nextStatus = parsed.status ?? order.status;

    const previousShares = Number(order.filledShareQty ?? 0);
    const previousNotional = Number(order.filledUsdtAmount ?? 0);
    const previousFee = Number(order.marketProviderFee ?? 0);
    const previousNetwork = Number(order.networkFee ?? 0);

    const cumulativeShares = parsed.shares ?? previousShares;
    const cumulativeNotional = parsed.notional ?? previousNotional;
    const cumulativeFee = parsed.fee;
    const cumulativeNetwork = parsed.network;

    // Venue values are cumulative. Clamp negative deltas so a stale/out-of-order
    // response can never manufacture a negative execution.
    let deltaShares = Math.max(0, cumulativeShares - previousShares);
    let deltaNotional = Math.max(0, cumulativeNotional - previousNotional);
    let deltaFee = Math.max(0, cumulativeFee - previousFee);
    let deltaNetwork = Math.max(0, cumulativeNetwork - previousNetwork);

    const price = parsed.price ?? (
      deltaShares > 0 && deltaNotional > 0 ? deltaNotional / deltaShares : null
    );

    if (deltaShares > 0 && deltaNotional <= 0 && price && price > 0) {
      deltaNotional = deltaShares * price;
    }
    if (deltaNotional > 0 && deltaShares <= 0 && price && price > 0) {
      deltaShares = deltaNotional / price;
    }

    const fill =
      price && deltaShares > 0 && deltaNotional > 0
        ? completeOfficialFill({
            status: nextStatus,
            shares: deltaShares,
            notional: deltaNotional,
            price,
            fee: deltaFee,
            network: deltaNetwork,
            // A delta is partial only when the venue order is still partial.
            fillPct: nextStatus === OrderStatus.PARTIALLY_FILLED ? 0.5 : 1,
          })
        : null;

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: nextStatus,
        vendorOrderId: row.vendorOrderId ?? order.vendorOrderId,
        // Keep these fields as cumulative venue checkpoints.
        filledUsdtAmount:
          parsed.notional != null ? parsed.notional : order.filledUsdtAmount,
        filledShareQty:
          parsed.shares != null ? parsed.shares : order.filledShareQty,
        fillPercentage: parsed.fillPct ?? order.fillPercentage,
        averagePrice: parsed.price ?? order.averagePrice,
        marketProviderFee:
          parsed.fee > 0 ? parsed.fee : order.marketProviderFee,
        networkFee:
          parsed.network > 0 ? parsed.network : order.networkFee,
        terminalAt:
          nextStatus === OrderStatus.SUBMITTED ||
          nextStatus === OrderStatus.PENDING ||
          nextStatus === OrderStatus.PARTIALLY_FILLED
            ? null
            : order.terminalAt ?? new Date(),
        rawPayload: jsonPayload(order.rawPayload, {
          officialStatus: row.status ?? null,
          orderId: row.orderId,
          reconciledAt: new Date().toISOString(),
          cumulativeFilledShares: cumulativeShares,
          cumulativeFilledNotional: cumulativeNotional,
          appliedDeltaShares: deltaShares,
          appliedDeltaNotional: deltaNotional,
          appliedDeltaFee: deltaFee,
          appliedDeltaNetwork: deltaNetwork,
        }),
      },
    });

    // No new venue fill since the last poll. The order status may still have
    // changed (e.g. PARTIALLY_FILLED -> FILLED), which is enough to return.
    if (!fill) return { applied: true, realizedDelta: 0 };

    let open = order.position?.status === PositionStatus.OPEN ? order.position : null;
    if (!open) {
      open = await tx.position.findFirst({
        where: {
          mode: TradingMode.LIVE,
          status: PositionStatus.OPEN,
          marketId: order.marketId,
          tokenId: order.tokenId,
        },
        orderBy: { openedAt: "desc" },
      });
    }

    const strategyId = open?.strategyId ?? order.signal?.strategyId ?? undefined;

    // A SELL without a known local position is an accounting anomaly. Never
    // create a synthetic OPEN SELL position: that would make the local DB
    // contradict the real Binance account. Persist the execution and let the
    // venue-position sync repair/overlay the local state.
    if (!open && order.side !== "BUY") {
      await tx.execution.create({
        data: {
          mode: TradingMode.LIVE,
          orderId: order.id,
          positionId: null,
          executedAt: new Date(),
          price: fill.price,
          shares: fill.shares,
          usdtAmount: fill.notional,
          isPartial: fill.partial,
          rawPayload: {
            orderId: row.orderId,
            status: row.status ?? null,
            orphanExit: true,
          },
        },
      });
      inc("live.reconcile_orphan_exit");
      log.error(
        {
          orderId: row.orderId,
          marketId: order.marketId,
          tokenId: order.tokenId,
          shares: fill.shares,
        },
        "LIVE SELL fill has no local OPEN position; execution recorded without synthetic position",
      );
      return { applied: true, realizedDelta: 0 };
    }

    const applied = applyLiveFillToPosition(
      open ? snapshotFromRow(open) : null,
      fill,
      order.side,
    );
    const now = new Date();
    const remainingNotional =
      applied.status === PositionStatus.OPEN
        ? Math.max(0, applied.position.shares * Math.max(fill.price, 0))
        : 0;
    const isDustResidual =
      order.side !== "BUY" &&
      applied.status === PositionStatus.OPEN &&
      remainingNotional <= 0.01 + 1e-9;

    let positionId = open?.id ?? null;
    if (!open) {
      const created = await tx.position.create({
        data: {
          mode: TradingMode.LIVE,
          strategyId,
          marketId: order.marketId,
          outcomeId: order.outcomeId,
          tokenId: order.tokenId,
          side: applied.position.side,
          status: PositionStatus.OPEN,
          shares: applied.position.shares,
          avgPrice: applied.position.avgPrice,
          totalCost: applied.position.totalCost,
          feesPaid: applied.position.feesPaid,
          networkCostPaid: applied.position.networkCostPaid,
          rawPayload: {
            source: "live-reconciliation",
            venueOrderId: order.venueOrderId,
          },
        },
      });
      positionId = created.id;
    } else {
      await tx.position.update({
        where: { id: open.id },
        data: {
          strategyId: open.strategyId ?? strategyId,
          status:
            applied.status === "CLOSED"
              ? PositionStatus.CLOSED
              : PositionStatus.OPEN,
          closedAt:
            applied.status === "CLOSED" ? now : open.closedAt,
          shares: applied.position.shares,
          avgPrice: applied.position.avgPrice,
          totalCost: applied.position.totalCost,
          realizedPnl: applied.position.realizedPnl,
          feesPaid: applied.position.feesPaid,
          networkCostPaid: applied.position.networkCostPaid,
          rawPayload:
            applied.closePrice !== null || open.side !== order.side
              ? jsonPayload(
                  applied.status === "CLOSED"
                    ? clearLiveFlatten(open.rawPayload)
                    : open.rawPayload,
                  {
                    ...(applied.closePrice !== null
                      ? { closePrice: applied.closePrice }
                      : {}),
                    ...(open.side !== order.side &&
                    applied.status !== "CLOSED"
                      ? { liveFlatten: true }
                      : {}),
                  },
                )
              : undefined,
        },
      });
    }

    await tx.execution.create({
      data: {
        mode: TradingMode.LIVE,
        orderId: order.id,
        positionId,
        executedAt: now,
        price: fill.price,
        shares: fill.shares,
        usdtAmount: fill.notional,
        isPartial:
          fill.partial ||
          (applied.status === "OPEN" &&
            open != null &&
            open.side !== order.side),
        rawPayload: {
          orderId: row.orderId,
          status: row.status ?? null,
          cumulativeFilledShares: cumulativeShares,
          cumulativeFilledNotional: cumulativeNotional,
        },
      },
    });

    if (positionId && isDustResidual) {
      const current = await tx.position.findUnique({ where: { id: positionId }, select: { rawPayload: true } });
      await tx.position.update({
        where: { id: positionId },
        data: {
          rawPayload: jsonPayload(current?.rawPayload, {
            liveDust: true,
            liveDustNotionalUsdt: remainingNotional,
            liveDustMarkedAt: now.toISOString(),
          }),
        },
      });
    }

    if (positionId) {
      await tx.order.update({
        where: { id: order.id },
        data: { positionId },
      });
    }

    if (deltaFee > 0) {
      await tx.fee.create({
        data: {
          orderId: order.id,
          positionId,
          kind: "market_provider",
          amount: deltaFee,
          currency: "USDT",
          observedAt: now,
        },
      });
    }
    if (deltaNetwork > 0) {
      await tx.fee.create({
        data: {
          orderId: order.id,
          positionId,
          kind: "network",
          amount: deltaNetwork,
          currency: "USDT",
          observedAt: now,
        },
      });
    }

    inc("live.reconcile_fill");
    return { applied: true, realizedDelta: applied.realizedDelta };
  });
}

async function persistLiveRealizedDelta(delta: number, now = new Date()): Promise<void> {
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-12) return;
  try {
    const state = await loadRiskState();
    const limits = limitsFromEnv();
    const next = recordClosedTrade(
      { ...state, mode: TradingMode.LIVE },
      delta,
      now,
      limits,
    );
    const open = await prisma.position.findMany({
      where: { mode: TradingMode.LIVE, status: PositionStatus.OPEN },
      select: { shares: true, avgPrice: true },
    });
    const openNotional = open.reduce(
      (sum, row) => sum + (asNumber(row.shares) ?? 0) * (asNumber(row.avgPrice) ?? 0),
      0,
    );
    await persistRiskSnapshot({
      ...next.state,
      mode: TradingMode.LIVE,
      openPositions: open.length,
      openNotional,
    });
  } catch (error) {
    log.warn({ err: String(error), delta }, "live realized PnL risk sync skipped");
  }
}

export async function reconcileLiveOrders(options: {
  history: W3WPredictionRestAPI.QueryOrderHistoryResponse;
  active: W3WPredictionRestAPI.QueryActiveOrdersResponse;
}): Promise<number> {
  const rows = [...(options.history.orders ?? []), ...(options.active.orders ?? [])];
  let applied = 0;
  let realizedDelta = 0;
  for (const row of rows) {
    try {
      const result = await applyOfficialLiveOrder(row);
      if (result.applied) applied += 1;
      realizedDelta += result.realizedDelta;
    } catch (error) {
      log.warn({ err: String(error), orderId: row.orderId }, "live reconcile row failed");
    }
  }
  await persistLiveRealizedDelta(realizedDelta);
  return applied;
}

function venueOrderIds(rows: OfficialOrder[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const row of rows ?? []) {
    if (row.orderId) ids.add(row.orderId);
  }
  return ids;
}

/** Drop local LIVE inflight rows that Binance no longer reports, so flip is not deadlocked. */
export async function releaseStaleLiveInflight(options: {
  now: Date;
  seenVenueOrderIds: Set<string>;
  staleMs?: number;
}): Promise<number> {
  const rows = await prisma.order.findMany({
    where: { mode: TradingMode.LIVE, status: { in: LIVE_INFLIGHT_STATUSES } },
    select: {
      id: true,
      venueOrderId: true,
      submittedAt: true,
      createdAt: true,
      rawPayload: true,
    },
  });
  let released = 0;
  for (const row of rows) {
    const seenOnVenue = Boolean(
      row.venueOrderId && options.seenVenueOrderIds.has(row.venueOrderId),
    );
    if (
      !shouldReleaseStaleLiveInflight({
        submittedAt: row.submittedAt,
        createdAt: row.createdAt,
        now: options.now,
        seenOnVenue,
        staleMs: options.staleMs ?? env.LIVE_INFLIGHT_STALE_MS,
      })
    ) {
      continue;
    }
    const payload =
      row.rawPayload && typeof row.rawPayload === "object" && !Array.isArray(row.rawPayload)
        ? { ...(row.rawPayload as Record<string, unknown>) }
        : {};
    payload.staleInflightReleased = true;
    await prisma.order.update({
      where: { id: row.id },
      data: {
        status: OrderStatus.FAILED,
        terminalAt: options.now,
        rawPayload: payload as Prisma.InputJsonValue,
      },
    });
    released += 1;
    log.warn(
      { orderId: row.id, venueOrderId: row.venueOrderId },
      "stale live inflight released",
    );
  }
  return released;
}

export async function syncLiveOrdersFromVenue(
  venue: {
    queryOrderHistory: (
      params: W3WPredictionRestAPI.QueryOrderHistoryRequest,
    ) => Promise<W3WPredictionRestAPI.QueryOrderHistoryResponse>;
    queryActiveOrders: (
      params: W3WPredictionRestAPI.QueryActiveOrdersRequest,
    ) => Promise<W3WPredictionRestAPI.QueryActiveOrdersResponse>;
  },
  walletAddress: string,
): Promise<number> {
  // Migrate any legacy LIVE PARTIALLY_FILLED rows to SUBMITTED before
  // exposing them to slot/inflight checks. New LIVE reconciliation never writes
  // this status; historical rows are normalized here as well.
  await prisma.order.updateMany({
    where: { mode: TradingMode.LIVE, status: OrderStatus.PARTIALLY_FILLED },
    data: { status: OrderStatus.SUBMITTED, terminalAt: null },
  });

  const [history, active] = await Promise.all([
    venue.queryOrderHistory({ walletAddress, limit: 200 }),
    venue.queryActiveOrders({ walletAddress, limit: 200 }),
  ]);
  const applied = await reconcileLiveOrders({ history, active });
  const seenVenueOrderIds = new Set([
    ...venueOrderIds(history.orders),
    ...venueOrderIds(active.orders),
  ]);
  const released = await releaseStaleLiveInflight({
    now: new Date(),
    seenVenueOrderIds,
  });
  if (released > 0) {
    log.warn({ released }, "stale live inflight orders failed locally");
  }
  return applied;
}
