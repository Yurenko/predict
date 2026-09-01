export type SignalDirection = "BUY" | "SELL" | "EXIT" | "FLAT";
export type OrderSide = "BUY" | "SELL";

export interface RiskCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface StrategySignal {
  strategyId: string;
  marketId: string;
  outcomeId?: string;
  timestamp: Date;
  direction: SignalDirection;
  marketProbability: number;
  fairProbability: number | null;
  grossEdge: number;
  estimatedFees: number;
  estimatedSlippage: number;
  estimatedPriceImpact: number;
  netEdge: number;
  confidence: number;
  reason: string;
  riskChecks: RiskCheckResult[];
}

export interface StrategyContext {
  now: Date;
  marketId: string;
  outcomeId?: string;
  tokenId: string;
  marketProbability: number;
  executableProbability: number | null;
  lastPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  liquidity: number | null;
  spread: number | null;
  timeToExpirySec: number | null;
  underlyingSymbol: string | null;
  underlyingPrice: number | null;
  startPrice: number | null;
  volume: number | null;
  /** Rolling features computed only from observations with t <= now. */
  features: {
    underlyingReturn1m: number | null;
    underlyingReturn5m: number | null;
    underlyingReturn15m: number | null;
    probabilityMean: number | null;
    probabilityStd: number | null;
    probabilityZ: number | null;
  };
  quote: {
    averagePrice: number | null;
    lastPrice: number | null;
    chance: number | null;
    feeAmount: number | null;
    feeRateBps: number | null;
    slippageBps: number | null;
    priceImpact: number | null;
    minReceive: number | null;
    expireAt: Date | null;
  } | null;
}

export interface Strategy {
  readonly id: string;
  readonly kind: "MEAN_REVERSION" | "UNDERLYING_MOMENTUM_LAG" | "FAIR_VALUE" | "ENGINE_SMOKE";
  evaluate(context: StrategyContext): StrategySignal | null;
}

export const CURRENT_PHASE = 11 as const;

export const PHASES = [
  { id: 1, name: "Project structure + database", status: "done" },
  { id: 2, name: "Binance adapters + raw data collector", status: "done" },
  { id: 3, name: "Normalized historical data", status: "done" },
  { id: 4, name: "Backtest engine", status: "done" },
  { id: 5, name: "Three strategies", status: "done" },
  { id: 6, name: "Risk engine", status: "done" },
  { id: 7, name: "Paper trading", status: "done" },
  { id: 8, name: "Dashboard", status: "done" },
  { id: 9, name: "Observability", status: "done" },
  { id: 10, name: "AWS deployment", status: "done" },
  { id: 11, name: "Optional live execution", status: "done" },
] as const;
