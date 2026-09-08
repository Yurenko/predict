import { OrderStatus, PositionStatus, Prisma, TradingMode } from "@prisma/client";
import type { W3WPredictionRestAPI } from "@binance/w3w-prediction";
import { prisma } from "@/lib/db/prisma";
import { asNumber } from "@/lib/normalize/numbers";
import { childLogger } from "@/lib/logger";
import { feeAmountToUsdt } from "@/lib/paper/quote-validate";
import { mapOfficialOrderStatus } from "@/lib/live/status";
import {
  applyLiveFillToPosition,
  completeOfficialFill,
  type LivePositionSnapshot,
} from "@/lib/live/position-fill";
import { clearLiveFlatten } from "@/lib/live/flatten";
import { inc } from "@/lib/observability/metrics";

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
  if (!status && fillPct !== null && fillPct >= 1 && (shares ?? 0) > 0) {
    status = OrderStatus.FILLED;
  } else if (!status && fillPct !== null && fillPct > 0 && fillPct < 1) {
    status = OrderStatus.PARTIALLY_FILLED;
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

export async function applyOfficialLiveOrder(row: OfficialOrder): Promise<boolean> {
  if (!row.orderId) return false;
  const order = await prisma.order.findFirst({
    where: { mode: TradingMode.LIVE, venueOrderId: row.orderId },
    include: {
      executions: true,
      position: true,
      signal: { select: { strategyId: true } },
    },
  });
  if (!order) return false;

  const parsed = fillFromOfficial(row);
  const nextStatus = parsed.status ?? order.status;
  const fill = completeOfficialFill(parsed);

  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: nextStatus,
      vendorOrderId: row.vendorOrderId ?? order.vendorOrderId,
      filledUsdtAmount: fill?.notional ?? parsed.notional ?? order.filledUsdtAmount,
      filledShareQty: fill?.shares ?? parsed.shares ?? order.filledShareQty,
      fillPercentage: parsed.fillPct ?? order.fillPercentage,
      averagePrice: fill?.price ?? parsed.price ?? order.averagePrice,
      marketProviderFee: parsed.fee || order.marketProviderFee,
      networkFee: parsed.network || order.networkFee,
      terminalAt:
        nextStatus === OrderStatus.SUBMITTED || nextStatus === OrderStatus.PENDING
          ? order.terminalAt
          : new Date(),
      rawPayload: jsonPayload(order.rawPayload, {
        officialStatus: row.status ?? null,
        orderId: row.orderId,
      }),
    },
  });

  if (!fill || order.executions.length > 0) {
    return true;
  }

  const linkedOpen =
    order.position && order.position.status === PositionStatus.OPEN ? order.position : null;
  const open =
    linkedOpen ??
    (await prisma.position.findFirst({
      where: {
        mode: TradingMode.LIVE,
        status: PositionStatus.OPEN,
        marketId: order.marketId,
        tokenId: order.tokenId,
      },
    }));

  const applied = applyLiveFillToPosition(open ? snapshotFromRow(open) : null, fill, order.side);
  const strategyId = open?.strategyId ?? order.signal?.strategyId ?? undefined;
  const now = new Date();

  let positionId = open?.id ?? applied.position.id;
  if (!open) {
    const created = await prisma.position.create({
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
      },
    });
    positionId = created.id;
  } else {
    await prisma.position.update({
      where: { id: open.id },
      data: {
        strategyId: open.strategyId ?? strategyId,
        status: applied.status === "CLOSED" ? PositionStatus.CLOSED : PositionStatus.OPEN,
        closedAt: applied.status === "CLOSED" ? now : open.closedAt,
        shares: applied.position.shares,
        avgPrice: applied.position.avgPrice,
        totalCost: applied.position.totalCost,
        realizedPnl: applied.position.realizedPnl,
        feesPaid: applied.position.feesPaid,
        networkCostPaid: applied.position.networkCostPaid,
        rawPayload:
          applied.closePrice !== null || open.side !== order.side
            ? jsonPayload(
                applied.status === "CLOSED" ? clearLiveFlatten(open.rawPayload) : open.rawPayload,
                {
                  ...(applied.closePrice !== null ? { closePrice: applied.closePrice } : {}),
                  ...(open.side !== order.side && applied.status !== "CLOSED"
                    ? { liveFlatten: true }
                    : {}),
                },
              )
            : undefined,
      },
    });
    positionId = open.id;
  }

  await prisma.execution.create({
    data: {
      mode: TradingMode.LIVE,
      orderId: order.id,
      positionId,
      executedAt: now,
      price: fill.price,
      shares: fill.shares,
      usdtAmount: fill.notional,
      isPartial:
        fill.partial || (applied.status === "OPEN" && open != null && open.side !== order.side),
      rawPayload: { orderId: row.orderId, status: row.status ?? null },
    },
  });

  if (positionId) {
    await prisma.order.update({ where: { id: order.id }, data: { positionId } });
  }

  inc("live.reconcile_fill");
  return true;
}

export async function reconcileLiveOrders(options: {
  history: W3WPredictionRestAPI.QueryOrderHistoryResponse;
  active: W3WPredictionRestAPI.QueryActiveOrdersResponse;
}): Promise<number> {
  const rows = [...(options.history.orders ?? []), ...(options.active.orders ?? [])];
  let applied = 0;
  for (const row of rows) {
    try {
      if (await applyOfficialLiveOrder(row)) applied += 1;
    } catch (error) {
      log.warn({ err: String(error), orderId: row.orderId }, "live reconcile row failed");
    }
  }
  return applied;
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
  const [history, active] = await Promise.all([
    venue.queryOrderHistory({ walletAddress, limit: 50 }),
    venue.queryActiveOrders({ walletAddress, limit: 50 }),
  ]);
  return reconcileLiveOrders({ history, active });
}
