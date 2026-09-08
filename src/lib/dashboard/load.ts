import { env, isLiveTradingEnabled } from "@/lib/config/env";
import { prisma } from "@/lib/db/prisma";
import { redis } from "@/lib/db/redis";
import { readLiveOrderbook } from "@/lib/ingest/raw-store";
import { asNumber } from "@/lib/normalize/numbers";
import { childLogger } from "@/lib/logger";
import { limitsFromEnv } from "@/lib/risk/limits";
import { loadRiskState } from "@/lib/risk/persist";
import { withTimeout } from "@/lib/observability/timeout";
import { collectorsAreFresh, loadCollectorHeartbeats } from "@/lib/observability/health";
import { assertNoSecrets, redactCredentialMentions } from "@/lib/dashboard/sanitize";
import { markPrice, unrealizedPnl } from "@/lib/dashboard/mark";
import { invertBinaryBook } from "@/lib/live/binary";
import { outcomeIsDownToken } from "@/lib/normalize/markets";
import { mtmEquity, sumOpenUnrealized } from "@/lib/dashboard/equity";
import { equityCurveFromClosed } from "@/lib/dashboard/equity-curve";
import { closedExitPrice } from "@/lib/dashboard/exit-price";
import { lastExecutableSides } from "@/lib/ingest/orderbook-merge";
import { heldOrTradableMarketQuery, marketHeadline } from "@/lib/markets/horizon";
import { newerPaperCycle, readPaperCycle, type PaperCycle } from "@/lib/paper/cycle";
import { DEFAULT_PAPER_ENTRY_MODE } from "@/lib/paper/entry-mode";
import { DEFAULT_LIVE_BINARY_MODE } from "@/lib/live/binary-mode";
import { recordAccount, readRecordControl } from "@/lib/record/control";
import { isPidAlive } from "@/lib/record/types";
import { CURRENT_PHASE } from "@/lib/types/domain";
import { parseClaimState } from "@/lib/live/claim";
import { LEDGER_PAGE_SIZE, ledgerPageCount, ledgerSkip } from "@/lib/dashboard/pages";
import type {
  DashboardBacktest,
  DashboardLedger,
  DashboardMarket,
  DashboardOrder,
  DashboardPayload,
  DashboardPosition,
  DashboardRisk,
  DashboardRiskEvent,
  DashboardSignal,
  DashboardStrategy,
} from "@/lib/dashboard/types";

const log = childLogger({ component: "dashboard" });

const positionInclude = {
  market: {
    include: {
      topic: { select: { endDate: true } },
      snapshots: { orderBy: { observedAt: "desc" as const }, take: 5 },
    },
  },
  strategy: true,
  outcome: { select: { name: true } },
  executions: { orderBy: { executedAt: "desc" as const }, take: 8 },
} as const;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export interface DashboardLoadOptions {
  positionsPage?: number;
  ordersPage?: number;
  signalsPage?: number;
  pageSize?: number;
}

function emptyLedger(pageSize = LEDGER_PAGE_SIZE): DashboardLedger {
  const page = { page: 1, pageSize, total: 0 };
  return {
    openPositions: 0,
    closedPositions: 0,
    orders: 0,
    signals: 0,
    closedRealized: 0,
    pages: {
      positions: { ...page },
      orders: { ...page },
      signals: { ...page },
    },
  };
}

function emptyRisk(): DashboardRisk {
  const limits = limitsFromEnv();
  return {
    mode: "PAPER",
    killSwitch: false,
    killSwitchReason: null,
    dailyPnl: 0,
    dailyLossDate: null,
    peakEquity: limits.bankrollUsdt,
    equity: limits.bankrollUsdt,
    realizedEquity: limits.bankrollUsdt,
    mtmEquity: limits.bankrollUsdt,
    unrealizedPnl: 0,
    openMissingMark: 0,
    currentDrawdown: 0,
    consecutiveLosses: 0,
    cooldownUntil: null,
    staleData: false,
    apiErrorBreaker: false,
    openPositions: 0,
    openNotional: 0,
  };
}

export function emptyDashboard(): DashboardPayload {
  const limits = limitsFromEnv();
  return {
    phase: CURRENT_PHASE,
    tradingMode: isLiveTradingEnabled() ? "LIVE" : "PAPER",
    liveTradingEnabled: isLiveTradingEnabled(),
    hasWallet: env.BINANCE_PREDICTION_WALLET_ADDRESS.trim().length > 0,
    hasPaperKeys: Boolean(env.BINANCE_PAPER_API_KEY && env.BINANCE_PAPER_API_SECRET),
    hasLiveKeys: Boolean(env.BINANCE_LIVE_API_KEY && env.BINANCE_LIVE_API_SECRET),
    health: { database: "error", redis: "error" },
    risk: emptyRisk(),
    limits: {
      bankrollUsdt: limits.bankrollUsdt,
      maxPositionPct: limits.maxPositionPct,
      maxSimultaneousPositions: limits.maxSimultaneousPositions,
      maxDailyLossPct: limits.maxDailyLossPct,
      maxDrawdownPct: limits.maxDrawdownPct,
      minLiquidityUsdt: limits.minLiquidityUsdt,
      minTimeToExpirySec: limits.minTimeToExpirySec,
      maxTimeToExpirySec: limits.maxTimeToExpirySec,
    },
    account: recordAccount(),
    ledger: emptyLedger(),
    record: {
      running: false,
      workerAlive: false,
      collecting: false,
      lastSampleAt: null,
      lastError: null,
      tickCount: 0,
      signalCount: 0,
      sessionId: null,
      paper: null,
    },
    collectors: [],
    underlyings: [],
    positions: [],
    orders: [],
    signals: [],
    markets: [],
    strategies: [],
    equityCurve: [],
    paperEntryMode: DEFAULT_PAPER_ENTRY_MODE,
    liveBinaryMode: DEFAULT_LIVE_BINARY_MODE,
    backtests: [],
    riskEvents: [],
  };
}

function redactPaperCycle(cycle: PaperCycle | null): PaperCycle | null {
  if (!cycle) return null;
  return {
    ...cycle,
    skip: cycle.skip ? redactCredentialMentions(cycle.skip) : null,
  };
}

function orderPayloadField(raw: unknown, key: "reason" | "intent" | "action"): string | null {
  if (raw && typeof raw === "object" && key in raw) {
    const value = (raw as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  }
  return null;
}

export async function loadDashboard(options: DashboardLoadOptions = {}): Promise<DashboardPayload> {
  const payload = emptyDashboard();
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? LEDGER_PAGE_SIZE));
  const requested = {
    positionsPage: Math.max(1, options.positionsPage ?? 1),
    ordersPage: Math.max(1, options.ordersPage ?? 1),
    signalsPage: Math.max(1, options.signalsPage ?? 1),
  };

  try {
    const pong = await withTimeout(redis.ping(), 1_500, "redis");
    payload.health.redis = pong === "PONG" ? "ok" : "error";
  } catch {
    payload.health.redis = "error";
  }

  if (payload.health.redis === "ok") {
    try {
      payload.collectors = await loadCollectorHeartbeats();
      payload.record.collecting = collectorsAreFresh(payload.collectors);
    } catch {
      payload.collectors = [];
    }
    try {
      const [control, paperCycle] = await Promise.all([readRecordControl(), readPaperCycle()]);
      payload.record.running = control.desired === "running";
      payload.record.workerAlive = isPidAlive(control.pid);
      payload.record.lastSampleAt = control.lastSampleAt;
      payload.record.lastError = control.lastError
        ? redactCredentialMentions(control.lastError)
        : null;
      payload.record.sessionId = control.sessionId;
      payload.record.paper = redactPaperCycle(newerPaperCycle(control.paper, paperCycle));
    } catch {
      // ignore
    }
  }

  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 1_500, "postgres");
    payload.health.database = "ok";
  } catch (error) {
    log.warn({ err: String(error) }, "dashboard database unavailable");
    assertNoSecrets(payload);
    return payload;
  }

  try {
    const state = await loadRiskState();
    payload.risk = {
      mode: state.mode,
      killSwitch: state.killSwitch,
      killSwitchReason: state.killSwitchReason,
      dailyPnl: state.dailyPnl,
      dailyLossDate: state.dailyLossDate,
      peakEquity: state.peakEquity,
      equity: state.equity,
      realizedEquity: state.equity,
      mtmEquity: state.equity,
      unrealizedPnl: 0,
      openMissingMark: 0,
      currentDrawdown: state.currentDrawdown,
      consecutiveLosses: state.consecutiveLosses,
      cooldownUntil: iso(state.cooldownUntil),
      staleData: state.staleData,
      apiErrorBreaker: state.apiErrorBreaker,
      openPositions: state.openPositions,
      openNotional: state.openNotional,
    };

    const [
      openRows,
      closedCount,
      closedRealizedAgg,
      closedCurveRows,
      orderCount,
      signalCount,
      markets,
      strategies,
      backtests,
      riskEvents,
    ] = await Promise.all([
      prisma.position.findMany({
        where: { status: "OPEN" },
        include: positionInclude,
      }),
      prisma.position.count({ where: { status: { not: "OPEN" } } }),
      prisma.position.aggregate({
        where: { status: { not: "OPEN" } },
        _sum: { realizedPnl: true },
      }),
      prisma.position.findMany({
        where: { status: { not: "OPEN" }, mode: payload.tradingMode },
        orderBy: { openedAt: "asc" },
        take: 2_000,
        select: { closedAt: true, openedAt: true, realizedPnl: true },
      }),
      prisma.order.count(),
      prisma.signal.count(),
      prisma.market.findMany({
        ...heldOrTradableMarketQuery(),
        include: {
          topic: true,
          snapshots: { orderBy: { observedAt: "desc" }, take: 1 },
        },
      }),
      prisma.strategy.findMany({ orderBy: { slug: "asc" } }),
      prisma.backtestRun.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { strategy: true, trades: { select: { id: true } } },
      }),
      prisma.riskEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 40,
      }),
    ]);

    const positionsPage = Math.min(requested.positionsPage, ledgerPageCount(closedCount, pageSize));
    const ordersPage = Math.min(requested.ordersPage, ledgerPageCount(orderCount, pageSize));
    const signalsPage = Math.min(requested.signalsPage, ledgerPageCount(signalCount, pageSize));

    const [closedRows, orders, signals] = await Promise.all([
      prisma.position.findMany({
        where: { status: { not: "OPEN" } },
        orderBy: { openedAt: "desc" },
        skip: ledgerSkip(positionsPage, pageSize),
        take: pageSize,
        include: positionInclude,
      }),
      prisma.order.findMany({
        orderBy: { createdAt: "desc" },
        skip: ledgerSkip(ordersPage, pageSize),
        take: pageSize,
        include: { market: true, outcome: { select: { name: true } } },
      }),
      prisma.signal.findMany({
        orderBy: { timestamp: "desc" },
        skip: ledgerSkip(signalsPage, pageSize),
        take: pageSize,
        include: { strategy: true, market: true, outcome: { select: { name: true } } },
      }),
    ]);

    payload.ledger = {
      openPositions: openRows.length,
      closedPositions: closedCount,
      orders: orderCount,
      signals: signalCount,
      closedRealized: asNumber(closedRealizedAgg._sum.realizedPnl) ?? 0,
      pages: {
        positions: { page: positionsPage, pageSize, total: closedCount },
        orders: { page: ordersPage, pageSize, total: orderCount },
        signals: { page: signalsPage, pageSize, total: signalCount },
      },
    };

    const positions = [...openRows, ...closedRows];

    const liveByVenue = new Map<string, { bestBid: number | null; bestAsk: number | null }>();
    const venues = new Set([
      ...markets.map((market) => market.venueMarketId),
      ...positions.map((row) => row.market.venueMarketId),
    ]);
    await Promise.all(
      [...venues].map(async (venueMarketId) => {
        const live = await readLiveOrderbook(venueMarketId);
        if (!live) return;
        liveByVenue.set(venueMarketId, {
          bestBid: asNumber(live.bestBid),
          bestAsk: asNumber(live.bestAsk),
        });
      }),
    );

    payload.positions = positions.map((row): DashboardPosition => {
      const live = liveByVenue.get(row.market.venueMarketId);
      const snap = lastExecutableSides(row.market.snapshots);
      const hist = snap.lastPrice;
      const open = row.status === "OPEN";
      const downToken = outcomeIsDownToken(row.outcome?.name);
      const rawBook = open
        ? {
            bestBid: live?.bestBid ?? snap.bestBid,
            bestAsk: live?.bestAsk ?? snap.bestAsk,
            lastPrice: hist,
          }
        : { bestBid: null, bestAsk: null, lastPrice: hist };
      const book =
        open && downToken && row.side === "BUY" ? invertBinaryBook(rawBook) : rawBook;
      const marked = markPrice(row.side, book);
      const avg = asNumber(row.avgPrice) ?? 0;
      const shares = asNumber(row.shares) ?? 0;
      return {
        id: row.id,
        mode: row.mode,
        status: row.status,
        side: row.side,
        outcomeName: row.outcome?.name ?? null,
        tokenId: row.tokenId,
        marketId: row.marketId,
        marketTitle: marketHeadline(row.market),
        marketQuestion: row.market.question,
        venueMarketId: row.market.venueMarketId,
        strategySlug: row.strategy?.slug ?? null,
        shares,
        avgPrice: avg,
        totalCost: asNumber(row.totalCost) ?? 0,
        realizedPnl: asNumber(row.realizedPnl) ?? 0,
        mark: open ? marked.mark : null,
        markSource: open ? marked.source : "none",
        markHeld: false,
        unrealizedPnl: open ? unrealizedPnl(row.side, avg, shares, marked.mark) : null,
        lastPriceHistorical: hist,
        exitPrice: closedExitPrice({
          status: row.status,
          executions: row.executions,
          rawPayload: row.rawPayload,
        }),
        openedAt: row.openedAt.toISOString(),
        closedAt: iso(row.closedAt),
        endDate: iso(row.market.topic.endDate),
        claimStatus: open ? null : parseClaimState(row.rawPayload).status,
      };
    });

    const openMark = sumOpenUnrealized(payload.positions);
    payload.risk.unrealizedPnl = openMark.pnl;
    payload.risk.openMissingMark = openMark.missingMark;
    payload.risk.mtmEquity = mtmEquity(payload.risk.realizedEquity, openMark.pnl);
    payload.equityCurve = equityCurveFromClosed({
      bankroll: payload.limits.bankrollUsdt,
      now: new Date(),
      mtmEquity: payload.risk.mtmEquity,
      closed: closedCurveRows.map((row) => ({
        at: row.closedAt ?? row.openedAt,
        pnl: asNumber(row.realizedPnl) ?? 0,
      })),
    });

    payload.orders = orders.map((row): DashboardOrder => ({
      id: row.id,
      clientOrderId: row.clientOrderId,
      status: row.status,
      side: row.side,
      outcomeName: row.outcome?.name ?? null,
      tokenId: row.tokenId,
      marketTitle: marketHeadline(row.market),
      marketQuestion: row.market.question,
      requestedAmount: asNumber(row.requestedAmount) ?? 0,
      averagePrice: asNumber(row.averagePrice),
      filledUsdtAmount: asNumber(row.filledUsdtAmount),
      reason: orderPayloadField(row.rawPayload, "reason"),
      intent: orderPayloadField(row.rawPayload, "intent"),
      action: orderPayloadField(row.rawPayload, "action"),
      submittedAt: iso(row.submittedAt),
    }));

    payload.signals = signals.map((row): DashboardSignal => ({
      id: row.id,
      strategySlug: row.strategy.slug,
      marketTitle: marketHeadline(row.market),
      marketQuestion: row.market.question,
      direction: row.direction,
      outcomeName: row.outcome?.name ?? null,
      netEdge: asNumber(row.netEdge) ?? 0,
      accepted: row.accepted,
      reason: row.reason,
      timestamp: row.timestamp.toISOString(),
    }));

    payload.markets = markets.map((row): DashboardMarket => {
      const snap = row.snapshots[0];
      const live = liveByVenue.get(row.venueMarketId);
      return {
        id: row.id,
        venueMarketId: row.venueMarketId,
        title: marketHeadline(row),
        question: row.question,
        topicTitle: row.topic.title,
        symbol: row.topic.symbol,
        status: row.tradingStatus ?? row.status,
        endDate: iso(row.topic.endDate),
        bestBid: live?.bestBid ?? asNumber(snap?.bestBid),
        bestAsk: live?.bestAsk ?? asNumber(snap?.bestAsk),
        lastPriceHistorical: asNumber(snap?.lastPrice),
        chance: asNumber(snap?.chance) ?? asNumber(snap?.midPrice),
        liquidity: asNumber(snap?.liquidity) ?? asNumber(row.liquidity),
        liveBook: Boolean(live),
        observedAt: iso(snap?.observedAt),
      };
    });

    payload.strategies = strategies.map((row): DashboardStrategy => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind: row.kind,
      enabled: row.enabled,
      description: row.description,
    }));

    payload.backtests = backtests.map((row): DashboardBacktest => ({
      id: row.id,
      name: row.name,
      strategySlug: row.strategy.slug,
      status: row.status,
      netPnl: asNumber(row.netPnl),
      maxDrawdown: asNumber(row.maxDrawdown),
      tradeCount: row.trades.length,
      walkForward: row.walkForward,
      createdAt: row.createdAt.toISOString(),
    }));

    payload.riskEvents = riskEvents.map((row): DashboardRiskEvent => ({
      id: row.id,
      type: row.type,
      severity: row.severity,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
    }));

    const [activeSession, underlyings] = await Promise.all([
      prisma.recordSession.findFirst({
        where: payload.record.sessionId
          ? { id: payload.record.sessionId }
          : { status: "RUNNING" },
        orderBy: { startedAt: "desc" },
      }),
      Promise.all(
        env.COLLECTOR_UNDERLYING_SYMBOLS.map(async (symbol) => {
          const row = await prisma.underlyingSnapshot.findFirst({
            where: { symbol },
            orderBy: { observedAt: "desc" },
          });
          return {
            symbol,
            price: asNumber(row?.price),
            observedAt: iso(row?.observedAt),
          };
        }),
      ),
    ]);
    payload.underlyings = underlyings;
    if (activeSession) {
      payload.record.sessionId = activeSession.id;
      payload.record.tickCount = activeSession.tickCount;
      payload.record.signalCount = activeSession.signalCount;
      payload.record.lastSampleAt =
        payload.record.lastSampleAt ?? iso(activeSession.lastSampleAt);
    }
  } catch (error) {
    log.warn({ err: String(error) }, "dashboard query failed");
  }

  assertNoSecrets(payload);
  return payload;
}
