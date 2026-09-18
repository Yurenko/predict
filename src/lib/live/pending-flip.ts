import { redis } from "@/lib/db/redis";
import { childLogger } from "@/lib/logger";
import type { SignalDirection, StrategySignal } from "@/lib/types/domain";

export const LIVE_PENDING_FLIP_PREFIX = "live:pending-flip:";
export const LIVE_PENDING_FLIP_INDEX = "live:pending-flip:index";

export type PendingFlipSide = "UP" | "DOWN";

export interface PendingFlip {
  strategyId: string;
  marketId: string;
  side: PendingFlipSide;
  fromTokenId: string | null;
  createdAt: string;
  /** EXIT already placed or venue inventory is already 0 — finish the ENTER. */
  committed: boolean;
}

const log = childLogger({ component: "pending-flip" });

export function pendingFlipKey(strategyId: string, marketId: string): string {
  return `${LIVE_PENDING_FLIP_PREFIX}${strategyId}:${marketId}`;
}

export function pendingFlipMember(strategyId: string, marketId: string): string {
  return `${strategyId}:${marketId}`;
}

export function parsePendingFlipMember(raw: string): { strategyId: string; marketId: string } | null {
  const split = raw.indexOf(":");
  if (split <= 0 || split === raw.length - 1) return null;
  return { strategyId: raw.slice(0, split), marketId: raw.slice(split + 1) };
}

export function parsePendingFlip(raw: unknown): PendingFlip | null {
  if (!raw) return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const side = row.side === "UP" || row.side === "DOWN" ? row.side : null;
  const strategyId = typeof row.strategyId === "string" ? row.strategyId : null;
  const marketId = typeof row.marketId === "string" ? row.marketId : null;
  if (!side || !strategyId || !marketId) return null;
  return {
    strategyId,
    marketId,
    side,
    fromTokenId: typeof row.fromTokenId === "string" ? row.fromTokenId : null,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date(0).toISOString(),
    committed: row.committed === true,
  };
}

export function pendingFlipDirection(side: PendingFlipSide): Extract<SignalDirection, "BUY" | "SELL"> {
  return side === "DOWN" ? "SELL" : "BUY";
}

export function pendingFlipFromSignal(direction: SignalDirection): PendingFlipSide | null {
  if (direction === "BUY") return "UP";
  if (direction === "SELL") return "DOWN";
  return null;
}

/**
 * EXIT or the opposite of the stored side cancels. Missing/FLAT does not.
 * After the EXIT is committed, a noisy opposite tick must not abort the ENTER.
 */
export function shouldCancelPendingFlip(
  pending: PendingFlipSide,
  signalDirection: SignalDirection | null | undefined,
  options?: { committed?: boolean },
): boolean {
  if (signalDirection == null || signalDirection === "FLAT") return false;
  if (signalDirection === "EXIT") return true;
  if (options?.committed) return false;
  const wanted = pendingFlipFromSignal(signalDirection);
  return wanted != null && wanted !== pending;
}

export function pendingFlipReservesSlot(options: {
  hasOpenOnMarket: boolean;
  hasInflightEnterOnMarket: boolean;
}): boolean {
  return !options.hasOpenOnMarket && !options.hasInflightEnterOnMarket;
}

/**
 * Flip ENTER is limited by live OPEN/SUBMITTED only. Extra pending keys must
 * not block completing the flip (0 OPEN + 4 leftovers was a deadlock).
 * A new market still sees every reserved slot so it cannot crowd out a flip.
 */
export function reservedCountForEnter(options: {
  reserved: number;
  openAndInflight: number;
  fulfillsPendingFlip: boolean;
  closingLegStillCounted?: boolean;
}): number {
  const reserved = Math.max(0, options.reserved);
  const closing = options.fulfillsPendingFlip && options.closingLegStillCounted ? 1 : 0;
  const live = Math.max(0, options.openAndInflight - closing);
  if (options.fulfillsPendingFlip) return live;
  return reserved;
}

export function pendingFlipMarketExpired(
  endDate: Date | null | undefined,
  now = new Date(),
): boolean {
  if (!endDate || Number.isNaN(endDate.getTime())) return false;
  return now.getTime() >= endDate.getTime();
}

export function pendingFlipTtlMs(endDate: Date | null | undefined, now = new Date()): number {
  if (!endDate || Number.isNaN(endDate.getTime())) return 2 * 60 * 60 * 1000;
  return Math.max(1_000, endDate.getTime() - now.getTime() + 5_000);
}

export function pendingFlipSignal(options: {
  strategyId: string;
  marketId: string;
  now: Date;
  side: PendingFlipSide;
  chance?: number | null;
}): StrategySignal {
  const probability = options.chance ?? 0.5;
  return {
    strategyId: options.strategyId,
    marketId: options.marketId,
    timestamp: options.now,
    direction: pendingFlipDirection(options.side),
    marketProbability: probability,
    fairProbability: probability,
    grossEdge: 0,
    estimatedFees: 0,
    estimatedSlippage: 0,
    estimatedPriceImpact: 0,
    netEdge: 0,
    confidence: 1,
    reason: "pending_flip",
    riskChecks: [],
  };
}

export async function readPendingFlip(
  strategyId: string,
  marketId: string,
): Promise<PendingFlip | null> {
  try {
    return parsePendingFlip(await redis.get(pendingFlipKey(strategyId, marketId)));
  } catch (error) {
    log.warn({ err: String(error), strategyId, marketId }, "pending flip read failed");
    return null;
  }
}

export async function writePendingFlip(options: {
  strategyId: string;
  marketId: string;
  side: PendingFlipSide;
  fromTokenId?: string | null;
  endDate?: Date | null;
  now?: Date;
  committed?: boolean;
}): Promise<void> {
  const now = options.now ?? new Date();
  const payload: PendingFlip = {
    strategyId: options.strategyId,
    marketId: options.marketId,
    side: options.side,
    fromTokenId: options.fromTokenId ?? null,
    createdAt: now.toISOString(),
    committed: options.committed === true,
  };
  const key = pendingFlipKey(options.strategyId, options.marketId);
  const member = pendingFlipMember(options.strategyId, options.marketId);
  try {
    const ttl = pendingFlipTtlMs(options.endDate, now);
    await redis.set(key, JSON.stringify(payload), "PX", ttl);
    await redis.sadd(LIVE_PENDING_FLIP_INDEX, member);
    await redis.pexpire(LIVE_PENDING_FLIP_INDEX, Math.max(ttl, 2 * 60 * 60 * 1000));
  } catch (error) {
    log.warn({ err: String(error), strategyId: options.strategyId, marketId: options.marketId }, "pending flip write failed");
  }
}

export async function clearAllPendingFlips(): Promise<number> {
  const rows = await listPendingFlips();
  for (const row of rows) {
    await clearPendingFlip(row.strategyId, row.marketId);
  }
  try {
    await redis.del(LIVE_PENDING_FLIP_INDEX);
  } catch (error) {
    log.warn({ err: String(error) }, "pending flip index clear failed");
  }
  return rows.length;
}

export async function clearPendingFlip(strategyId: string, marketId: string): Promise<void> {
  try {
    await redis.del(pendingFlipKey(strategyId, marketId));
    await redis.srem(LIVE_PENDING_FLIP_INDEX, pendingFlipMember(strategyId, marketId));
  } catch (error) {
    log.warn({ err: String(error), strategyId, marketId }, "pending flip clear failed");
  }
}

export async function listPendingFlips(): Promise<PendingFlip[]> {
  try {
    const members = await redis.smembers(LIVE_PENDING_FLIP_INDEX);
    if (members.length === 0) return [];
    const keyed = members.flatMap((member) => {
      const parsed = parsePendingFlipMember(member);
      return parsed ? [{ member, key: pendingFlipKey(parsed.strategyId, parsed.marketId) }] : [];
    });
    if (keyed.length === 0) return [];
    const values = await redis.mget(...keyed.map((row) => row.key));
    const out: PendingFlip[] = [];
    const stale: string[] = [];
    for (let i = 0; i < keyed.length; i += 1) {
      const parsed = parsePendingFlip(values[i]);
      if (parsed) out.push(parsed);
      else stale.push(keyed[i]?.member ?? "");
    }
    if (stale.length > 0) {
      await redis.srem(LIVE_PENDING_FLIP_INDEX, ...stale.filter(Boolean));
    }
    return out;
  } catch (error) {
    log.warn({ err: String(error) }, "pending flip list failed");
    return [];
  }
}

export async function clearExpiredPendingFlips(
  endDateByMarketId: Map<string, Date | null | undefined>,
  now = new Date(),
): Promise<number> {
  const rows = await listPendingFlips();
  let cleared = 0;
  for (const row of rows) {
    const end = endDateByMarketId.get(row.marketId);
    if (end === undefined || pendingFlipMarketExpired(end ?? null, now)) {
      await clearPendingFlip(row.strategyId, row.marketId);
      cleared += 1;
    }
  }
  return cleared;
}

export async function hasPeerPendingFlip(marketId: string, strategyId: string): Promise<boolean> {
  const rows = await listPendingFlips();
  return rows.some((row) => row.marketId === marketId && row.strategyId !== strategyId);
}
