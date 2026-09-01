import { CURRENT_PHASE } from "@/lib/types/domain";

export interface DashboardHealth {
  database: "ok" | "error";
  redis: "ok" | "error";
}

export interface DashboardRisk {
  mode: "PAPER" | "LIVE";
  killSwitch: boolean;
  killSwitchReason: string | null;
  dailyPnl: number;
  dailyLossDate: string | null;
  peakEquity: number;
  equity: number;
  currentDrawdown: number;
  consecutiveLosses: number;
  cooldownUntil: string | null;
  staleData: boolean;
  apiErrorBreaker: boolean;
  openPositions: number;
  openNotional: number;
}

export interface DashboardLimits {
  bankrollUsdt: number;
  maxPositionPct: number;
  maxSimultaneousPositions: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  minLiquidityUsdt: number;
  minTimeToExpirySec: number;
}

export interface DashboardPosition {
  id: string;
  mode: "PAPER" | "LIVE";
  status: string;
  side: "BUY" | "SELL";
  tokenId: string;
  marketId: string;
  marketTitle: string;
  venueMarketId: string;
  strategySlug: string | null;
  shares: number;
  avgPrice: number;
  totalCost: number;
  realizedPnl: number;
  mark: number | null;
  markSource: "bid" | "ask" | "none";
  unrealizedPnl: number | null;
  lastPriceHistorical: number | null;
  openedAt: string;
  closedAt: string | null;
}

export interface DashboardOrder {
  id: string;
  clientOrderId: string;
  status: string;
  side: string;
  tokenId: string;
  marketTitle: string;
  requestedAmount: number;
  averagePrice: number | null;
  filledUsdtAmount: number | null;
  reason: string | null;
  submittedAt: string | null;
}

export interface DashboardSignal {
  id: string;
  strategySlug: string;
  marketTitle: string;
  direction: string;
  netEdge: number;
  accepted: boolean;
  reason: string;
  timestamp: string;
}

export interface DashboardMarket {
  id: string;
  venueMarketId: string;
  title: string;
  symbol: string | null;
  status: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  lastPriceHistorical: number | null;
  chance: number | null;
  liquidity: number | null;
  liveBook: boolean;
  observedAt: string | null;
}

export interface DashboardStrategy {
  id: string;
  slug: string;
  name: string;
  kind: string;
  enabled: boolean;
  description: string | null;
}

export interface DashboardBacktest {
  id: string;
  name: string;
  strategySlug: string;
  status: string;
  netPnl: number | null;
  maxDrawdown: number | null;
  tradeCount: number;
  walkForward: boolean;
  createdAt: string;
}

export interface DashboardRiskEvent {
  id: string;
  type: string;
  severity: string;
  message: string;
  createdAt: string;
}

export interface DashboardPayload {
  phase: typeof CURRENT_PHASE;
  tradingMode: "PAPER" | "LIVE";
  liveTradingEnabled: boolean;
  hasWallet: boolean;
  hasPaperKeys: boolean;
  hasLiveKeys: boolean;
  health: DashboardHealth;
  risk: DashboardRisk;
  limits: DashboardLimits;
  positions: DashboardPosition[];
  orders: DashboardOrder[];
  signals: DashboardSignal[];
  markets: DashboardMarket[];
  strategies: DashboardStrategy[];
  backtests: DashboardBacktest[];
  riskEvents: DashboardRiskEvent[];
}
