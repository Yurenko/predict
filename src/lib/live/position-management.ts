import type { Prisma } from "@prisma/client";
import type { StrategySignal } from "@/lib/types/domain";

export interface LivePositionManagementConfig {
  takeProfitPrice: number;
  takeProfitMinTteSec: number;
  trailActivationPrice: number;
  trailMinDistance: number;
  trailPercent: number;
  trailMinProfit: number;
  trailMinTteSec: number;
  reversalMinTteSec: number;
  reversalMinConfidence: number;
  reversalMinNetEdge: number;
  reversalMinLoss: number;
}

export const DEFAULT_LIVE_POSITION_MANAGEMENT: LivePositionManagementConfig = {
  takeProfitPrice: 0.98,
  takeProfitMinTteSec: 180,
  trailActivationPrice: 0.90,
  trailMinDistance: 0.05,
  trailPercent: 0.08,
  trailMinProfit: 0.03,
  trailMinTteSec: 60,
  reversalMinTteSec: 180,
  reversalMinConfidence: 0.70,
  reversalMinNetEdge: 0.05,
  reversalMinLoss: 0.005,
};

export type LivePositionManagementState = {
  peakPrice: number;
  peakAt: string;
};

export type LivePositionManagementDecision = {
  kind: "TAKE_PROFIT" | "TRAILING_STOP" | "STRONG_REVERSAL";
  reason: string;
};

function objectPayload(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
}

export function readLivePositionManagementState(raw: unknown): LivePositionManagementState | null {
  const payload = objectPayload(raw);
  const state = payload.livePositionManagement;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const peakPrice = Number((state as Record<string, unknown>).peakPrice);
  const peakAt = (state as Record<string, unknown>).peakAt;
  if (!(peakPrice >= 0 && peakPrice <= 1) || typeof peakAt !== "string") return null;
  return { peakPrice, peakAt };
}

export function updateLivePositionManagementState(
  raw: unknown,
  currentPrice: number,
  now: Date,
): { state: LivePositionManagementState; changed: boolean; rawPayload: Prisma.InputJsonValue } {
  const existing = readLivePositionManagementState(raw);
  const peakPrice = existing ? Math.max(existing.peakPrice, currentPrice) : currentPrice;
  const changed = !existing || peakPrice > existing.peakPrice + 0.0005;
  const state: LivePositionManagementState = {
    peakPrice,
    peakAt: changed ? now.toISOString() : existing!.peakAt,
  };
  const payload = objectPayload(raw);
  payload.livePositionManagement = state;
  return { state, changed, rawPayload: payload as Prisma.InputJsonValue };
}

export function evaluateLivePositionManagement(options: {
  entryPrice: number;
  currentPrice: number;
  timeToExpirySec: number | null;
  isDownPosition: boolean;
  signal: StrategySignal | null;
  state: LivePositionManagementState;
  config?: LivePositionManagementConfig;
}): LivePositionManagementDecision | null {
  const {
    entryPrice,
    currentPrice,
    timeToExpirySec,
    isDownPosition,
    signal,
    state,
  } = options;
  const config = options.config ?? DEFAULT_LIVE_POSITION_MANAGEMENT;

  if (!(currentPrice >= 0 && currentPrice <= 1)) return null;
  if (timeToExpirySec == null || timeToExpirySec <= config.trailMinTteSec) return null;

  // Hard take-profit: independent of entry price. A 0.03 -> 0.23 trade is
  // intentionally NOT forced out here; only the universal 0.98+ rule is.
  if (
    currentPrice >= config.takeProfitPrice &&
    timeToExpirySec > config.takeProfitMinTteSec
  ) {
    return {
      kind: "TAKE_PROFIT",
      reason: `take-profit: executable price ${currentPrice.toFixed(4)} >= ${config.takeProfitPrice.toFixed(2)} with ${Math.floor(timeToExpirySec)}s to expiry`,
    };
  }

  // Trailing protection is deliberately dormant below 0.90 and only arms
  // after the position has made at least 0.03 in absolute price profit.
  // The distance expands with price (8% of peak, min 0.05), so volatile
  // movement around 0.90-0.98 does not close the position on a tiny tick.
  const trailArmed =
    state.peakPrice >= config.trailActivationPrice &&
    state.peakPrice >= entryPrice + config.trailMinProfit;
  if (trailArmed) {
    const trailDistance = Math.max(
      config.trailMinDistance,
      state.peakPrice * config.trailPercent,
    );
    const trailPrice = Math.max(
      state.peakPrice - trailDistance,
      entryPrice + config.trailMinProfit,
    );
    if (currentPrice <= trailPrice && state.peakPrice - currentPrice >= config.trailMinDistance) {
      return {
        kind: "TRAILING_STOP",
        reason: `trailing protection: peak ${state.peakPrice.toFixed(4)} -> current ${currentPrice.toFixed(4)}, trail ${trailPrice.toFixed(4)}`,
      };
    }
  }

  // Reversal is intentionally much stricter than the normal entry signal.
  // It only applies while losing, needs enough time left for a new position,
  // and requires both strong confidence and a meaningful net edge.
  const oppositeSignal =
    signal &&
    ((isDownPosition && signal.direction === "BUY") ||
      (!isDownPosition && signal.direction === "SELL"));
  const losing = currentPrice < entryPrice - config.reversalMinLoss;
  const strong =
    signal != null &&
    signal.confidence >= config.reversalMinConfidence &&
    signal.netEdge >= config.reversalMinNetEdge;

  if (
    oppositeSignal &&
    losing &&
    strong &&
    timeToExpirySec > config.reversalMinTteSec
  ) {
    return {
      kind: "STRONG_REVERSAL",
      reason: `strong reversal: ${isDownPosition ? "UP" : "DOWN"} signal while position is losing; confidence ${signal.confidence.toFixed(2)}, net edge ${signal.netEdge.toFixed(4)}`,
    };
  }

  return null;
}

export type LiveManagementLock = {
  blockedDirection: "BUY" | "SELL";
  kind: "TAKE_PROFIT" | "TRAILING_STOP";
};

export function managementLockKey(strategyId: string, marketId: string): string {
  return `live:position-management-lock:${strategyId}:${marketId}`;
}
