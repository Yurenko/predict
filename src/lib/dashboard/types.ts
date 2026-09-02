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
  realizedEquity: number;
  mtmEquity: number;
  unrealizedPnl: number;
  openMissingMark: number;
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
  maxTimeToExpirySec: number;
}

export interface DashboardPosition {
  id: string;
  mode: "PAPER" | "LIVE";
  status: string;
  side: "BUY" | "SELL";
  tokenId: string;
  marketId: string;
  marketTitle: string;
  marketQuestion: string | null;
  venueMarketId: string;
  strategySlug: string | null;
  shares: number;
  avgPrice: number;
  totalCost: number;
  realizedPnl: number;
  mark: number | null;
  markSource: "bid" | "ask" | "none";
  markHeld?: boolean;
  unrealizedPnl: number | null;
  lastPriceHistorical: number | null;
  exitPrice: number | null;
  openedAt: string;
  closedAt: string | null;
  endDate: string | null;
}

export interface DashboardOrder {
  id: string;
  clientOrderId: string;
  status: string;
  side: string;
  tokenId: string;
  marketTitle: string;
  marketQuestion: string | null;
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
  marketQuestion: string | null;
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
  question: string | null;
  topicTitle: string | null;
  symbol: string | null;
  status: string | null;
  endDate: string | null;
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

export interface DashboardCollector {
  channel: string;
  lastAt: string | null;
  ageMs: number | null;
  stale: boolean;
}

export interface DashboardUnderlying {
  symbol: string;
  price: number | null;
  observedAt: string | null;
}

export interface DashboardPaperCycle {
  at: string;
  enabled: number;
  considered: number;
  filled: number;
  skip: string | null;
}

export interface DashboardRecordStatus {
  running: boolean;
  workerAlive: boolean;
  collecting: boolean;
  lastSampleAt: string | null;
  lastError: string | null;
  tickCount: number;
  signalCount: number;
  sessionId: string | null;
  paper: DashboardPaperCycle | null;
}

export interface DashboardLedgerPage {
  page: number;
  pageSize: number;
  total: number;
}

export interface DashboardLedger {
  openPositions: number;
  closedPositions: number;
  orders: number;
  signals: number;
  closedRealized: number;
  pages: {
    positions: DashboardLedgerPage;
    orders: DashboardLedgerPage;
    signals: DashboardLedgerPage;
  };
}

export interface DashboardAccount {
  walletPreview: string | null;
  hasWallet: boolean;
  hasPaperKeys: boolean;
  bankrollUsdt: number;
  accountType: string;
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
  account: DashboardAccount;
  ledger: DashboardLedger;
  record: DashboardRecordStatus;
  collectors: DashboardCollector[];
  underlyings: DashboardUnderlying[];
  positions: DashboardPosition[];
  orders: DashboardOrder[];
  signals: DashboardSignal[];
  markets: DashboardMarket[];
  strategies: DashboardStrategy[];
  paperEntryMode: "all" | "single";
  backtests: DashboardBacktest[];
  riskEvents: DashboardRiskEvent[];
}
