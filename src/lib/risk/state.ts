import { RiskEventType } from "@prisma/client";
import type { RiskLimits, RiskSnapshot } from "@/lib/risk/types";

export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function drawdown(peak: number, equity: number): number {
  if (!(peak > 0)) return 0;
  return Math.max(0, (peak - equity) / peak);
}

export function rollDailyWindow(state: RiskSnapshot, now: Date): RiskSnapshot {
  const day = utcDay(now);
  if (state.dailyLossDate === day) return state;
  return {
    ...state,
    dailyPnl: 0,
    dailyLossDate: day,
  };
}

export function armKillSwitch(state: RiskSnapshot, reason: string, now: Date, cooldownMs: number): RiskSnapshot {
  return {
    ...state,
    killSwitch: true,
    killSwitchReason: reason,
    cooldownUntil: new Date(now.getTime() + cooldownMs),
  };
}

export function noteStaleData(state: RiskSnapshot, stale: boolean): RiskSnapshot {
  return { ...state, staleData: stale };
}

export function noteApiError(state: RiskSnapshot, tripped: boolean): RiskSnapshot {
  return { ...state, apiErrorBreaker: tripped };
}

export function recordClosedTrade(
  state: RiskSnapshot,
  netPnl: number,
  now: Date,
  limits: RiskLimits,
): { state: RiskSnapshot; tripped: RiskEventType[] } {
  let next = rollDailyWindow(state, now);
  const equity = next.equity + netPnl;
  const peak = Math.max(next.peakEquity, equity, limits.bankrollUsdt);
  const dailyPnl = next.dailyPnl + netPnl;
  const consecutiveLosses = netPnl < 0 ? next.consecutiveLosses + 1 : 0;
  const currentDrawdown = drawdown(peak, equity);
  next = {
    ...next,
    equity,
    peakEquity: peak,
    dailyPnl,
    dailyLossDate: utcDay(now),
    consecutiveLosses,
    currentDrawdown,
  };

  const tripped: RiskEventType[] = [];
  const dailyLossLimit = -limits.bankrollUsdt * (limits.maxDailyLossPct / 100);
  if (dailyPnl <= dailyLossLimit) {
    next = armKillSwitch(next, "max_daily_loss", now, limits.cooldownMs);
    tripped.push(RiskEventType.MAX_DAILY_LOSS, RiskEventType.KILL_SWITCH);
  }
  if (currentDrawdown >= limits.maxDrawdownPct / 100) {
    next = armKillSwitch(next, "max_drawdown", now, limits.cooldownMs);
    tripped.push(RiskEventType.MAX_DRAWDOWN, RiskEventType.KILL_SWITCH);
  }
  if (
    consecutiveLosses >= limits.consecutiveLossesForCooldown &&
    !next.killSwitch
  ) {
    next = {
      ...next,
      cooldownUntil: new Date(now.getTime() + limits.cooldownMs),
    };
    tripped.push(RiskEventType.COOLDOWN);
  }
  return { state: next, tripped };
}
