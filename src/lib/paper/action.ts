import { OrderSide } from "@prisma/client";
import type { SignalDirection } from "@/lib/types/domain";
import type { FillOk } from "@/lib/backtest/fills";

export type PaperAction = "ENTER" | "EXIT" | "HOLD";

export function decidePaperAction(
  direction: SignalDirection,
  openSide: OrderSide | null,
): PaperAction {
  if (direction === "FLAT") return "HOLD";
  if (direction === "EXIT") return openSide ? "EXIT" : "HOLD";
  if (!openSide) return "ENTER";
  const held: SignalDirection = openSide === OrderSide.BUY ? "BUY" : "SELL";
  if (direction === held) return "HOLD";
  return "EXIT";
}

/** Same market + token already held by another strategy — do not open a second $50 copy. */
export function isDuplicatePaperEnter(action: PaperAction, peerOccupied: boolean): boolean {
  return action === "ENTER" && peerOccupied;
}

export function paperOrderSide(
  action: Exclude<PaperAction, "HOLD">,
  direction: SignalDirection,
  positionSide?: OrderSide | null,
): OrderSide {
  if (action === "EXIT") {
    return positionSide === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
  }
  return direction === "SELL" ? OrderSide.SELL : OrderSide.BUY;
}

export function paperExitPnl(
  open: { side: OrderSide; avgPrice: number; shares: number },
  fill: FillOk,
): number {
  const shares = Math.min(fill.shares, open.shares);
  const gross =
    open.side === OrderSide.BUY
      ? (fill.price - open.avgPrice) * shares
      : (open.avgPrice - fill.price) * shares;
  return gross - fill.fee - fill.slippage - fill.priceImpact - fill.networkCost;
}
