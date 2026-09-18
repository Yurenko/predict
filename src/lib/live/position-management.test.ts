import { describe, expect, it } from "vitest";
import {
  evaluateLivePositionManagement,
  readLivePositionManagementState,
  updateLivePositionManagementState,
} from "@/lib/live/position-management";
import type { StrategySignal } from "@/lib/types/domain";

function signal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  return {
    strategyId: "s",
    marketId: "m",
    timestamp: new Date("2026-09-15T10:00:00Z"),
    direction: "SELL",
    marketProbability: 0.4,
    fairProbability: 0.3,
    grossEdge: 0.1,
    estimatedFees: 0,
    estimatedSlippage: 0,
    estimatedPriceImpact: 0,
    netEdge: 0.1,
    confidence: 0.8,
    reason: "strong",
    riskChecks: [],
    ...overrides,
  };
}

const base = {
  entryPrice: 0.6,
  timeToExpirySec: 500,
  isDownPosition: false,
  state: { peakPrice: 0.98, peakAt: new Date().toISOString() },
};

describe("live position management", () => {
  it("does not take profit, trail, or reverse — Live holds like Paper", () => {
    expect(
      evaluateLivePositionManagement({
        ...base,
        entryPrice: 0.02,
        currentPrice: 0.98,
        signal: null,
      }),
    ).toBeNull();
    expect(
      evaluateLivePositionManagement({
        ...base,
        currentPrice: 0.86,
        state: { peakPrice: 0.94, peakAt: new Date().toISOString() },
        signal: null,
      }),
    ).toBeNull();
    expect(
      evaluateLivePositionManagement({
        ...base,
        currentPrice: 0.58,
        signal: signal({ confidence: 0.7, netEdge: 0.05 }),
      }),
    ).toBeNull();
  });

  it("persists and only advances the peak", () => {
    const first = updateLivePositionManagementState({}, 0.91, new Date("2026-09-15T10:00:00Z"));
    expect(first.state.peakPrice).toBe(0.91);
    const second = updateLivePositionManagementState(first.rawPayload, 0.87, new Date("2026-09-15T10:00:05Z"));
    expect(second.state.peakPrice).toBe(0.91);
    expect(readLivePositionManagementState(second.rawPayload)?.peakPrice).toBe(0.91);
  });
});
