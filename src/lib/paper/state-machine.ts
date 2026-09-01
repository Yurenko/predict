import { OrderStatus } from "@prisma/client";

const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  PENDING: [OrderStatus.SUBMITTED, OrderStatus.FAILED, OrderStatus.CANCELLED],
  SUBMITTED: [
    OrderStatus.FILLED,
    OrderStatus.PARTIALLY_FILLED,
    OrderStatus.FAILED,
    OrderStatus.EXPIRED,
    OrderStatus.CANCELLED,
  ],
  PARTIALLY_FILLED: [OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.FAILED],
  FILLED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from].includes(to);
}

export function transitionOrder(from: OrderStatus, to: OrderStatus): OrderStatus {
  if (!canTransition(from, to)) {
    throw new Error(`illegal order transition ${from} → ${to}`);
  }
  return to;
}
