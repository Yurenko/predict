import { OrderStatus, PositionStatus, TradingMode } from "@prisma/client";
import type { W3WPredictionRestAPI } from "@binance/w3w-prediction";
import { prisma } from "@/lib/db/prisma";
import { asNumber } from "@/lib/normalize/numbers";
import { childLogger } from "@/lib/logger";
import { feeAmountToUsdt } from "@/lib/paper/quote-validate";
import { paperExitPnl } from "@/lib/paper/action";
import { mapOfficialOrderStatus } from "@/lib/live/status";
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

function fillFromOfficial(row: OfficialOrder): {
  status: OrderStatus | null;
  notional: number | null;
  shares: number | null;
  price: number | null;
  fee: number;
  network: number;
  fillPct: number | null;
} {
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

export async function applyOfficialLiveOrder(row: OfficialOrder): Promise<boolean> {
  if (!row.orderId) return false;
  const order = await prisma.order.findFirst({
    where: { mode: TradingMode.LIVE, venueOrderId: row.orderId },
    include: { executions: true, position: true },
  });
  if (!order) return false;

  const parsed = fillFromOfficial(row);
  const nextStatus = parsed.status ?? order.status;
  const hasFill =
    parsed.notional !== null &&
    parsed.shares !== null &&
    parsed.price !== null &&
    parsed.shares > 0 &&
    parsed.notional > 0 &&
    parsed.price > 0;

  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: nextStatus,
      vendorOrderId: row.vendorOrderId ?? order.vendorOrderId,
      filledUsdtAmount: parsed.notional ?? order.filledUsdtAmount,
      filledShareQty: parsed.shares ?? order.filledShareQty,
      fillPercentage: parsed.fillPct ?? order.fillPercentage,
      averagePrice: parsed.price ?? order.averagePrice,
      marketProviderFee: parsed.fee || order.marketProviderFee,
      networkFee: parsed.network || order.networkFee,
      terminalAt:
        nextStatus === OrderStatus.SUBMITTED || nextStatus === OrderStatus.PENDING
          ? order.terminalAt
          : new Date(),
      rawPayload: { officialStatus: row.status ?? null, orderId: row.orderId },
    },
  });

  if (!hasFill || order.executions.length > 0) {
    return true;
  }

  const fill = {
    ok: true as const,
    price: parsed.price as number,
    shares: parsed.shares as number,
    notional: parsed.notional as number,
    fee: parsed.fee,
    slippage: 0,
    priceImpact: 0,
    networkCost: parsed.network,
    partial: nextStatus === OrderStatus.PARTIALLY_FILLED,
  };

  let positionId = order.positionId;
  if (!positionId) {
    const open = await prisma.position.findFirst({
      where: {
        mode: TradingMode.LIVE,
        status: PositionStatus.OPEN,
        marketId: order.marketId,
        tokenId: order.tokenId,
      },
    });
    if (open && open.side !== order.side) {
      const pnl = paperExitPnl(
        { side: open.side, avgPrice: Number(open.avgPrice), shares: Number(open.shares) },
        fill,
      );
      await prisma.position.update({
        where: { id: open.id },
        data: {
          status: PositionStatus.CLOSED,
          closedAt: new Date(),
          realizedPnl: pnl,
          feesPaid: { increment: fill.fee },
          networkCostPaid: { increment: fill.networkCost },
        },
      });
      positionId = open.id;
    } else if (!open) {
      const created = await prisma.position.create({
        data: {
          mode: TradingMode.LIVE,
          marketId: order.marketId,
          outcomeId: order.outcomeId,
          tokenId: order.tokenId,
          side: order.side,
          status: PositionStatus.OPEN,
          shares: fill.shares,
          avgPrice: fill.price,
          totalCost: fill.notional + fill.fee,
          feesPaid: fill.fee,
          networkCostPaid: fill.networkCost,
        },
      });
      positionId = created.id;
    } else {
      positionId = open.id;
    }
  }

  await prisma.execution.create({
    data: {
      mode: TradingMode.LIVE,
      orderId: order.id,
      positionId,
      executedAt: new Date(),
      price: fill.price,
      shares: fill.shares,
      usdtAmount: fill.notional,
      isPartial: fill.partial,
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
