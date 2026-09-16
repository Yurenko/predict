import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_POSITION_MANAGEMENT,
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

describe("live position management", () => {
  it("takes profit at 0.98+ only with more than 3 minutes left", () => {
    const state = { peakPrice: 0.98, peakAt: new Date().toISOString() };
    expect(
      evaluateLivePositionManagement({
        entryPrice: 0.02,
        currentPrice: 0.98,
        timeToExpirySec: 61,
        isDownPosition: false,
        signal: null,
        state,
      })?.kind,
    ).toBe("TAKE_PROFIT");

    expect(
      evaluateLivePositionManagement({
        entryPrice: 0.02,
        currentPrice: 0.98,
        timeToExpirySec: 60,
        isDownPosition: false,
        signal: null,
        state,
      }),
    ).toBeNull();
    expect(
      evaluateLivePositionManagement({
        entryPrice: 0.02,
        currentPrice: 0.98,
        timeToExpirySec: 60,
        isDownPosition: false,
        signal: null,
        state,
      }),
    ).toBeNull();
  });

  it("does not trail a 0.60 entry at 0.70 -> 0.65", () => {
    const state = { peakPrice: 0.70, peakAt: new Date().toISOString() };
    expect(
      evaluateLivePositionManagement({
        entryPrice: 0.60,
        currentPrice: 0.65,
        timeToExpirySec: 500,
        isDownPosition: false,
        signal: null,
        state,
      }),
    ).toBeNull();
  });

  it("arms trailing only after 0.90 and meaningful profit", () => {
    const state = { peakPrice: 0.94, peakAt: new Date().toISOString() };
    const decision = evaluateLivePositionManagement({
      entryPrice: 0.60,
      currentPrice: 0.86,
      timeToExpirySec: 500,
      isDownPosition: false,
      signal: null,
      state,
    });
    expect(decision?.kind).toBe("TRAILING_STOP");
  });

  it("requires a strong opposite signal for reversal", () => {
    const state = { peakPrice: 0.60, peakAt: new Date().toISOString() };
    expect(
      evaluateLivePositionManagement({
        entryPrice: 0.60,
        currentPrice: 0.58,
        timeToExpirySec: 500,
        isDownPosition: false,
        signal: signal({ confidence: 0.69, netEdge: 0.1 }),
        state,
      }),
    ).toBeNull();

    expect(
      evaluateLivePositionManagement({
        entryPrice: 0.60,
        currentPrice: 0.58,
        timeToExpirySec: 500,
        isDownPosition: false,
        signal: signal({ confidence: 0.70, netEdge: 0.05 }),
        state,
      })?.kind,
    ).toBe("STRONG_REVERSAL");
  });

  it("persists and only advances the peak", () => {
    const first = updateLivePositionManagementState({}, 0.91, new Date("2026-09-15T10:00:00Z"));
    expect(first.state.peakPrice).toBe(0.91);
    const second = updateLivePositionManagementState(first.rawPayload, 0.87, new Date("2026-09-15T10:00:05Z"));
    expect(second.state.peakPrice).toBe(0.91);
    expect(readLivePositionManagementState(second.rawPayload)?.peakPrice).toBe(0.91);
    expect(DEFAULT_LIVE_POSITION_MANAGEMENT.trailActivationPrice).toBe(0.9);
  });
});
