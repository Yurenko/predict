import { describe, expect, it } from "vitest";
import { TradingMode } from "@prisma/client";
import { evaluateRisk } from "./evaluate";
import { emptyRiskSnapshot } from "./limits";
import { disarmKillSwitch, recordClosedTrade } from "./state";
import type { RiskIntent, RiskLimits, RiskSnapshot } from "./types";

function limits(over: Partial<RiskLimits> = {}): RiskLimits {
  return {
    bankrollUsdt: 1000,
    maxPositionPct: 5,
    maxSimultaneousPositions: 2,
    maxDailyLossPct: 3,
    maxDrawdownPct: 10,
    maxSlippageBps: 1000,
    maxPriceImpact: 0.05,
    minLiquidityUsdt: 100,
    minTimeToExpirySec: 60,
    maxTimeToExpirySec: 86_400,
    staleMs: 15_000,
    cooldownMs: 900_000,
    consecutiveLossesForCooldown: 5,
    liveTradingEnabled: false,
    ...over,
  };
}

function intent(over: Partial<RiskIntent> = {}): RiskIntent {
  return {
    action: "ENTER",
    mode: TradingMode.PAPER,
    now: new Date("2026-01-01T00:00:00.000Z"),
    marketId: "m1",
    requestedNotional: 50,
    bestBid: 0.44,
    bestAsk: 0.46,
    lastPrice: 0.99,
    liquidity: 500,
    timeToExpirySec: 600,
    estimatedSlippageBps: 100,
    estimatedPriceImpact: 0.01,
    quoteExpireAt: null,
    dataAgeMs: 200,
    ...over,
  };
}

function state(lim: RiskLimits, over: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return { ...emptyRiskSnapshot(lim), ...over };
}

describe("evaluateRisk", () => {
  const lim = limits();

  it("allows a paper entry inside all limits", () => {
    const decision = evaluateRisk(intent(), state(lim), lim);
    expect(decision.allowed).toBe(true);
  });

  it("refuses LIVE when live flags are off", () => {
    const decision = evaluateRisk(intent({ mode: TradingMode.LIVE }), state(lim), lim);
    expect(decision.allowed).toBe(false);
    expect(decision.checks.find((item) => item.name === "live_gate")?.passed).toBe(false);
  });

  it("blocks LIVE ENTER on kill switch but still allows EXIT; PAPER ignores kill", () => {
    const armed = state(lim, { killSwitch: true, killSwitchReason: "manual" });
    expect(evaluateRisk(intent(), armed, lim).allowed).toBe(true);
    expect(evaluateRisk(intent({ action: "EXIT" }), armed, lim).allowed).toBe(true);
    const liveLimits = limits({ liveTradingEnabled: true });
    const liveArmed = state(liveLimits, { killSwitch: true, killSwitchReason: "manual" });
    expect(evaluateRisk(intent({ mode: TradingMode.LIVE }), liveArmed, liveLimits).allowed).toBe(
      false,
    );
    expect(
      evaluateRisk(intent({ mode: TradingMode.LIVE, action: "EXIT" }), liveArmed, liveLimits)
        .allowed,
    ).toBe(true);
  });

  it("does not block LIVE ENTER on stale, cooldown, or API breaker while kill is off", () => {
    const liveLimits = limits({ liveTradingEnabled: true });
    expect(
      evaluateRisk(
        intent({ mode: TradingMode.LIVE, dataAgeMs: 20_000 }),
        state(liveLimits),
        liveLimits,
      ).allowed,
    ).toBe(true);
    expect(evaluateRisk(intent({ dataAgeMs: 20_000 }), state(lim), lim).allowed).toBe(true);
    expect(evaluateRisk(intent(), state(lim, { apiErrorBreaker: true }), lim).allowed).toBe(
      true,
    );
    expect(
      evaluateRisk(
        intent({ mode: TradingMode.LIVE }),
        state(liveLimits, { apiErrorBreaker: true }),
        liveLimits,
      ).allowed,
    ).toBe(true);
    expect(
      evaluateRisk(
        intent(),
        state(lim, { cooldownUntil: new Date("2026-01-01T00:15:00.000Z") }),
        lim,
      ).allowed,
    ).toBe(true);
    expect(
      evaluateRisk(
        intent({ mode: TradingMode.LIVE }),
        state(liveLimits, { cooldownUntil: new Date("2026-01-01T00:15:00.000Z") }),
        liveLimits,
      ).allowed,
    ).toBe(true);
    expect(
      evaluateRisk(intent({ action: "EXIT", dataAgeMs: 20_000 }), state(lim, { staleData: true }), lim)
        .allowed,
    ).toBe(true);
  });

  it("enforces position size, count, exposure, tte, liquidity", () => {
    expect(evaluateRisk(intent({ requestedNotional: 100 }), state(lim), lim).allowed).toBe(false);
    expect(
      evaluateRisk(intent(), state(lim, { openPositions: 2 }), lim).allowed,
    ).toBe(false);
    expect(
      evaluateRisk(intent({ requestedNotional: 50 }), state(lim, { openNotional: 980 }), lim).allowed,
    ).toBe(false);
    expect(evaluateRisk(intent({ timeToExpirySec: 10 }), state(lim), lim).allowed).toBe(false);
    expect(
      evaluateRisk(
        intent({ timeToExpirySec: 10, ignoreMinTimeToExpiry: true }),
        state(lim),
        lim,
      ).allowed,
    ).toBe(true);
    expect(evaluateRisk(intent({ timeToExpirySec: 200_000 }), state(lim), lim).allowed).toBe(
      false,
    );
    expect(evaluateRisk(intent({ liquidity: null }), state(lim), lim).allowed).toBe(false);
    expect(evaluateRisk(intent({ estimatedSlippageBps: 50_000 }), state(lim), lim).allowed).toBe(
      true,
    );
  });

  it("rejects lastPrice as the proposed fill", () => {
    const decision = evaluateRisk(
      intent({ proposedFillPrice: 0.99, lastPrice: 0.99, bestAsk: 0.46 }),
      state(lim),
      lim,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.checks.find((item) => item.name === "not_last_price")?.passed).toBe(false);
  });

  it("does not invent a book from lastPrice", () => {
    const decision = evaluateRisk(
      intent({ bestBid: null, bestAsk: null, lastPrice: 0.5 }),
      state(lim),
      lim,
    );
    expect(decision.allowed).toBe(false);
  });
});

describe("recordClosedTrade", () => {
  it("does not auto-arm kill switch after LIVE losses; kill is manual only", () => {
    const lim = limits({ maxDailyLossPct: 3, maxDrawdownPct: 10, consecutiveLossesForCooldown: 1 });
    const start = emptyRiskSnapshot(lim, TradingMode.LIVE);
    const loss = recordClosedTrade(start, -40, new Date("2026-01-01T00:00:00.000Z"), lim);
    expect(loss.state.killSwitch).toBe(false);
    expect(loss.state.cooldownUntil).toBeNull();
    expect(loss.tripped).toEqual([]);

    const draw = recordClosedTrade(
      emptyRiskSnapshot(lim, TradingMode.LIVE),
      -150,
      new Date("2026-01-01T00:00:00.000Z"),
      lim,
    );
    expect(draw.state.killSwitch).toBe(false);
    expect(draw.tripped).toEqual([]);
    expect(draw.state.currentDrawdown).toBeGreaterThan(0);
  });

  it("does not arm kill or cooldown after PAPER losses", () => {
    const lim = limits({ maxDailyLossPct: 3, maxDrawdownPct: 10, consecutiveLossesForCooldown: 1 });
    const start = emptyRiskSnapshot(lim, TradingMode.PAPER);
    const loss = recordClosedTrade(start, -150, new Date("2026-01-01T00:00:00.000Z"), lim);
    expect(loss.state.killSwitch).toBe(false);
    expect(loss.state.cooldownUntil).toBeNull();
    expect(loss.tripped).toEqual([]);
    expect(loss.state.equity).toBe(850);
    expect(loss.state.currentDrawdown).toBeGreaterThan(0);
  });

  it("resets daily pnl on a new UTC day", () => {
    const lim = limits();
    const day1 = recordClosedTrade(
      emptyRiskSnapshot(lim),
      -10,
      new Date("2026-01-01T23:00:00.000Z"),
      lim,
    );
    const day2 = recordClosedTrade(
      day1.state,
      1,
      new Date("2026-01-02T01:00:00.000Z"),
      lim,
    );
    expect(day2.state.dailyPnl).toBe(1);
  });

  it("disarmKillSwitch turns kill and cooldown off", () => {
    const lim = limits();
    const armed = {
      ...emptyRiskSnapshot(lim, TradingMode.LIVE),
      killSwitch: true,
      killSwitchReason: "manual_dashboard",
      cooldownUntil: new Date("2026-01-01T00:15:00.000Z"),
    };
    const off = disarmKillSwitch(armed);
    expect(off.killSwitch).toBe(false);
    expect(off.killSwitchReason).toBeNull();
    expect(off.cooldownUntil).toBeNull();
  });
});
