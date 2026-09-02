import type { RiskEventType, SystemEventLevel, TradingMode } from "@prisma/client";
import type { RiskCheckResult } from "@/lib/types/domain";

export type RiskAction = "ENTER" | "EXIT";

export interface RiskLimits {
  bankrollUsdt: number;
  maxPositionPct: number;
  maxSimultaneousPositions: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxSlippageBps: number;
  maxPriceImpact: number;
  minLiquidityUsdt: number;
  minTimeToExpirySec: number;
  maxTimeToExpirySec: number;
  staleMs: number;
  cooldownMs: number;
  consecutiveLossesForCooldown: number;
  liveTradingEnabled: boolean;
}

export interface RiskSnapshot {
  mode: TradingMode;
  killSwitch: boolean;
  killSwitchReason: string | null;
  dailyPnl: number;
  dailyLossDate: string | null;
  peakEquity: number;
  equity: number;
  currentDrawdown: number;
  consecutiveLosses: number;
  cooldownUntil: Date | null;
  staleData: boolean;
  apiErrorBreaker: boolean;
  openPositions: number;
  openNotional: number;
}

export interface RiskIntent {
  action: RiskAction;
  mode: TradingMode;
  now: Date;
  strategyId?: string;
  marketId: string;
  requestedNotional: number;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  liquidity: number | null;
  timeToExpirySec: number | null;
  estimatedSlippageBps: number | null;
  estimatedPriceImpact: number | null;
  quoteExpireAt: Date | null;
  dataAgeMs: number | null;
  /** If set, must be the executable book price — not lastPrice. */
  proposedFillPrice?: number | null;
}

export interface RiskEventDraft {
  type: RiskEventType;
  severity: SystemEventLevel;
  message: string;
}

export interface RiskDecision {
  allowed: boolean;
  action: RiskAction;
  checks: RiskCheckResult[];
  events: RiskEventDraft[];
  nextState: RiskSnapshot;
}
