import { OrderStatus } from "@prisma/client";

/**
 * Map an official prediction order `status` string onto our enum.
 * Unknown values stay unmapped so we do not invent a fill.
 * OPEN is the active-order tab, not a fill.
 */
export function mapOfficialOrderStatus(raw: string | undefined | null): OrderStatus | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase();
  if (key === "OPEN") return OrderStatus.SUBMITTED;
  if (key === "FULFILLED" || key === "COMPLETED" || key === "FILLED") return OrderStatus.FILLED;
  if (key === "CANCELLED" || key === "CANCELED" || key === "CANCELLED_BY_USER") return OrderStatus.CANCELLED;
  if ((Object.values(OrderStatus) as string[]).includes(key)) {
    return key as OrderStatus;
  }
  return null;
}
