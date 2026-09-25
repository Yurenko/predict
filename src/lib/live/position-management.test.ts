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
  it("takes profit on a cheap entry marked around 0.45+", () => {
    expect(
      evaluateLivePositionManagement({
        ...base,
        entryPrice: 0.13,
        currentPrice: 0.47,
        signal: null,
      })?.kind,
    ).toBe("TAKE_PROFIT");
    expect(
      evaluateLivePositionManagement({
        ...base,
        entryPrice: 0.6,
        currentPrice: 0.62,
        signal: null,
      }),
    ).toBeNull();
  });

  it("stops an expensive Up that dropped through 0.25", () => {
    expect(
      evaluateLivePositionManagement({
        ...base,
        entryPrice: 0.65,
        currentPrice: 0.24,
        signal: null,
      })?.kind,
    ).toBe("STOP_LOSS");
  });

  it("persists and only advances the peak", () => {
    const first = updateLivePositionManagementState({}, 0.91, new Date("2026-09-15T10:00:00Z"));
    expect(first.state.peakPrice).toBe(0.91);
    const second = updateLivePositionManagementState(first.rawPayload, 0.87, new Date("2026-09-15T10:00:05Z"));
    expect(second.state.peakPrice).toBe(0.91);
    expect(readLivePositionManagementState(second.rawPayload)?.peakPrice).toBe(0.91);
  });
});
