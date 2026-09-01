import type { OrderSide, SignalDirection, StrategySignal } from "@/lib/types/domain";

export interface BacktestCosts {
  useQuoteFees: boolean;
  /** Explicit researcher override. null = refuse to assume a fee and skip the fill. */
  fallbackFeeRateBps: number | null;
  simulateSlippage: boolean;
  simulatePriceImpact: boolean;
  allowPartialFills: boolean;
  networkCostUsdt: number;
}

export interface BacktestConfig {
  name: string;
  strategy: string;
  trainFrom: Date | null;
  trainTo: Date | null;
  validationFrom: Date | null;
  validationTo: Date | null;
  testFrom: Date;
  testTo: Date;
  walkForward: boolean;
  walkForwardTrainDays: number;
  walkForwardTestDays: number;
  walkForwardStepDays: number;
  lookbackMinutes: number;
  rollingWindow: number;
  parameters: Record<string, unknown>;
  costs: BacktestCosts;
  bankrollUsdt: number;
  maxPositionPct: number;
  maxSimultaneousPositions: number;
  minTimeToExpirySec: number;
  minLiquidityUsdt: number;
  maxPriceImpact: number;
  safetyMargin: number;
}

export interface HistoricalQuote {
  tokenId: string;
  quotedAt: Date;
  averagePrice: number | null;
  lastPrice: number | null;
  chance: number | null;
  feeAmount: number | null;
  feeRateBps: number | null;
  slippageBps: number | null;
  priceImpact: number | null;
  minReceive: number | null;
  expireAt: Date | null;
}

export interface MarketTick {
  observedAt: Date;
  marketId: string;
  venueMarketId: string;
  outcomeId: string | null;
  tokenId: string | null;
  outcomeName: string | null;
  symbol: string | null;
  endDate: Date | null;
  startPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  chance: number | null;
  lastPrice: number | null;
  spread: number | null;
  liquidity: number | null;
  bidDepth: number | null;
  askDepth: number | null;
  timeToExpirySec: number | null;
}

export interface UnderlyingTick {
  observedAt: Date;
  symbol: string;
  price: number;
  bid: number | null;
  ask: number | null;
  volume: number | null;
}

export type ReplayEvent =
  | { kind: "underlying"; at: Date; tick: UnderlyingTick }
  | { kind: "market"; at: Date; tick: MarketTick };

export interface BacktestTradeResult {
  marketId: string;
  openedAt: Date;
  closedAt: Date;
  side: OrderSide;
  direction: SignalDirection;
  entryPrice: number;
  exitPrice: number;
  size: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  priceImpact: number;
  netPnl: number;
  reason: string;
}

export interface EquityPoint {
  t: string;
  equity: number;
}

export interface BacktestMetrics {
  netPnl: number;
  grossPnl: number;
  fees: number;
  maxDrawdown: number;
  winRate: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  sharpe: number | null;
  sortino: number | null;
  tradeCount: number;
  skippedFills: number;
}

export interface BacktestFoldResult {
  trainFrom: Date | null;
  trainTo: Date | null;
  testFrom: Date;
  testTo: Date;
  trades: BacktestTradeResult[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
  skipped: Array<{ at: Date; marketId: string; reason: string }>;
  signals: StrategySignal[];
}

export interface BacktestResult {
  name: string;
  strategy: string;
  walkForward: boolean;
  folds: BacktestFoldResult[];
  trades: BacktestTradeResult[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
}
