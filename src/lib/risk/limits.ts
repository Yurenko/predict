import { TradingMode } from "@prisma/client";
import { env, isLiveTradingEnabled } from "@/lib/config/env";
import type { RiskLimits, RiskSnapshot } from "@/lib/risk/types";

export function limitsFromEnv(): RiskLimits {
  return {
    bankrollUsdt: env.BANKROLL_USDT,
    maxPositionPct: env.MAX_POSITION_PCT,
    maxSimultaneousPositions: env.MAX_SIMULTANEOUS_POSITIONS,
    maxDailyLossPct: env.MAX_DAILY_LOSS_PCT,
    maxDrawdownPct: env.MAX_DRAWDOWN_PCT,
    maxSlippageBps: env.MAX_SLIPPAGE_BPS,
    maxPriceImpact: env.MAX_PRICE_IMPACT,
    minLiquidityUsdt: env.MIN_LIQUIDITY_USDT,
    minTimeToExpirySec: env.MIN_TIME_TO_EXPIRY_SEC,
    maxTimeToExpirySec: env.COLLECTOR_MAX_TIME_TO_EXPIRY_SEC,
    staleMs: env.WS_STALE_MS,
    cooldownMs: env.RISK_COOLDOWN_MS,
    consecutiveLossesForCooldown: env.RISK_CONSECUTIVE_LOSSES,
    liveTradingEnabled: isLiveTradingEnabled(),
  };
}

export function emptyRiskSnapshot(
  limits: RiskLimits,
  mode: TradingMode = TradingMode.PAPER,
): RiskSnapshot {
  return {
    mode,
    killSwitch: false,
    killSwitchReason: null,
    dailyPnl: 0,
    dailyLossDate: null,
    peakEquity: limits.bankrollUsdt,
    equity: limits.bankrollUsdt,
    currentDrawdown: 0,
    consecutiveLosses: 0,
    cooldownUntil: null,
    staleData: false,
    apiErrorBreaker: false,
    openPositions: 0,
    openNotional: 0,
  };
}
