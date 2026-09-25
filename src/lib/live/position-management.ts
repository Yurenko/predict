import type { Prisma } from "@prisma/client";
import type { StrategySignal } from "@/lib/types/domain";
import { shouldStopLoss, shouldTakeProfit, stopLossReason, takeProfitReason } from "@/lib/live/take-profit";

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
  takeProfitPrice: 0.45,
  takeProfitMinTteSec: 30,
  trailActivationPrice: 0.90,
  trailMinDistance: 0.05,
  trailPercent: 0.08,
  trailMinProfit: 0.03,
  trailMinTteSec: 60,
  reversalMinTteSec: 60,
  reversalMinConfidence: 0.70,
  reversalMinNetEdge: 0.05,
  reversalMinLoss: 0.005,
};

export type LivePositionManagementState = {
  peakPrice: number;
  peakAt: string;
};

export type LivePositionManagementDecision = {
  kind: "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "STRONG_REVERSAL";
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
  void options.isDownPosition;
  void options.signal;
  void options.state;
  const config = options.config ?? DEFAULT_LIVE_POSITION_MANAGEMENT;
  if (
    shouldTakeProfit({
      entryPrice: options.entryPrice,
      currentPrice: options.currentPrice,
      timeToExpirySec: options.timeToExpirySec,
      takeProfitMark: config.takeProfitPrice,
      takeProfitMinDelta: 0.2,
      minTteSec: config.takeProfitMinTteSec,
    })
  ) {
    return {
      kind: "TAKE_PROFIT",
      reason: takeProfitReason(options.entryPrice, options.currentPrice),
    };
  }
  if (
    shouldStopLoss({
      entryPrice: options.entryPrice,
      currentPrice: options.currentPrice,
    })
  ) {
    return {
      kind: "STOP_LOSS",
      reason: stopLossReason(options.entryPrice, options.currentPrice),
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
