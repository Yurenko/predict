import { OrderSide, OrderStatus, PositionStatus } from "@prisma/client";
import { paperExitPnl } from "@/lib/paper/action";
import type { FillOk } from "@/lib/backtest/fills";

export const LIVE_INFLIGHT_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.SUBMITTED,
  OrderStatus.PARTIALLY_FILLED,
];

export interface LivePositionSnapshot {
  id?: string;
  side: OrderSide;
  shares: number;
  avgPrice: number;
  totalCost: number;
  feesPaid: number;
  networkCostPaid: number;
  realizedPnl: number;
}

export interface LiveFillQty {
  price: number;
  shares: number;
  notional: number;
  fee: number;
  networkCost: number;
  partial: boolean;
}

export type LivePositionAfterFill = {
  status: "OPEN" | "CLOSED";
  position: LivePositionSnapshot;
  realizedDelta: number;
  closePrice: number | null;
};

const DUST_SHARES = 1e-8;

export function completeOfficialFill(parsed: {
  notional: number | null;
  shares: number | null;
  price: number | null;
  fee: number;
  network: number;
  fillPct: number | null;
  status: OrderStatus | null;
}): LiveFillQty | null {
  let notional = parsed.notional;
  let shares = parsed.shares;
  let price = parsed.price;
  if ((shares === null || shares <= 0) && notional && price && price > 0) {
    shares = notional / price;
  }
  if ((notional === null || notional <= 0) && shares && price && price > 0) {
    notional = shares * price;
  }
  if ((price === null || price <= 0) && shares && notional && shares > 0) {
    price = notional / shares;
  }
  if (shares === null || notional === null || price === null) return null;
  if (!(shares > 0) || !(notional > 0) || !(price > 0)) return null;
  return {
    price,
    shares,
    notional,
    fee: parsed.fee,
    networkCost: parsed.network,
    partial: parsed.status === OrderStatus.PARTIALLY_FILLED || (parsed.fillPct !== null && parsed.fillPct > 0 && parsed.fillPct < 1),
  };
}

export function fillOkFromLive(fill: LiveFillQty): FillOk {
  return {
    ok: true,
    price: fill.price,
    shares: fill.shares,
    notional: fill.notional,
    fee: fill.fee,
    slippage: 0,
    priceImpact: 0,
    networkCost: fill.networkCost,
    partial: fill.partial,
  };
}

/** Wait for the SUBMITTED enter to land before opening another live ticket. */
export function shouldDeferLiveEnter(openExists: boolean, inflightExists: boolean): boolean {
  return !openExists && inflightExists;
}

/**
 * LIVE ENTER does not create an OPEN row until the Binance fill lands.
 * Count those SUBMITTED tickets as reserved slots so maxSimultaneousPositions holds.
 */
export function reservedLivePositionCount(
  openTokenIds: string[],
  inflightTokenIds: string[],
  pendingUncovered = 0,
): number {
  const openTokens = new Set(openTokenIds.filter(Boolean));
  const pendingEnter = new Set(
    inflightTokenIds.filter((tokenId) => tokenId && !openTokens.has(tokenId)),
  );
  const extra = Number.isFinite(pendingUncovered) ? Math.max(0, pendingUncovered) : 0;
  return openTokenIds.length + pendingEnter.size + extra;
}

export function applyLiveFillToPosition(
  open: LivePositionSnapshot | null,
  fill: LiveFillQty,
  orderSide: OrderSide,
): LivePositionAfterFill {
  if (!open) {
    return {
      status: PositionStatus.OPEN,
      position: {
        side: orderSide,
        shares: fill.shares,
        avgPrice: fill.price,
        totalCost: fill.notional + fill.fee + fill.networkCost,
        feesPaid: fill.fee,
        networkCostPaid: fill.networkCost,
        realizedPnl: 0,
      },
      realizedDelta: 0,
      closePrice: null,
    };
  }

  if (open.side === orderSide) {
    const shares = open.shares + fill.shares;
    const avgPrice =
      shares > 0 ? (open.avgPrice * open.shares + fill.price * fill.shares) / shares : fill.price;
    return {
      status: PositionStatus.OPEN,
      position: {
        ...open,
        shares,
        avgPrice,
        totalCost: open.totalCost + fill.notional + fill.fee + fill.networkCost,
        feesPaid: open.feesPaid + fill.fee,
        networkCostPaid: open.networkCostPaid + fill.networkCost,
      },
      realizedDelta: 0,
      closePrice: null,
    };
  }

  const realizedDelta = paperExitPnl(
    { side: open.side, avgPrice: open.avgPrice, shares: open.shares },
    fillOkFromLive(fill),
  );
  const closeShares = Math.min(fill.shares, open.shares);
  const remaining = open.shares - closeShares;
  const fraction = open.shares > 0 ? remaining / open.shares : 0;
  if (remaining <= DUST_SHARES) {
    return {
      status: PositionStatus.CLOSED,
      position: {
        ...open,
        feesPaid: open.feesPaid + fill.fee,
        networkCostPaid: open.networkCostPaid + fill.networkCost,
        realizedPnl: open.realizedPnl + realizedDelta,
      },
      realizedDelta,
      closePrice: fill.price,
    };
  }
  return {
    status: PositionStatus.OPEN,
    position: {
      ...open,
      shares: remaining,
      totalCost: open.totalCost * fraction,
      feesPaid: open.feesPaid + fill.fee,
      networkCostPaid: open.networkCostPaid + fill.networkCost,
      realizedPnl: open.realizedPnl + realizedDelta,
    },
    realizedDelta,
    closePrice: fill.price,
  };
}
