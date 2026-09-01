import { env, isLiveTradingEnabled } from "@/lib/config/env";
import { prisma } from "@/lib/db/prisma";
import { redis } from "@/lib/db/redis";
import { readLiveOrderbook } from "@/lib/ingest/raw-store";
import { asNumber } from "@/lib/normalize/numbers";
import { childLogger } from "@/lib/logger";
import { limitsFromEnv } from "@/lib/risk/limits";
import { loadRiskState } from "@/lib/risk/persist";
import { withTimeout } from "@/lib/observability/timeout";
import { assertNoSecrets } from "@/lib/dashboard/sanitize";
import { CURRENT_PHASE } from "@/lib/types/domain";
import type {
  DashboardBacktest,
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

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
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
    },
    positions: [],
    orders: [],
    signals: [],
    markets: [],
    strategies: [],
    backtests: [],
    riskEvents: [],
  };
}

function orderReason(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "reason" in raw) {
    const reason = (raw as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : null;
  }
  return null;
}

export async function loadDashboard(): Promise<DashboardPayload> {
  const payload = emptyDashboard();

  try {
    const pong = await withTimeout(redis.ping(), 1_500, "redis");
    payload.health.redis = pong === "PONG" ? "ok" : "error";
  } catch {
    payload.health.redis = "error";
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
      currentDrawdown: state.currentDrawdown,
      consecutiveLosses: state.consecutiveLosses,
      cooldownUntil: iso(state.cooldownUntil),
      staleData: state.staleData,
      apiErrorBreaker: state.apiErrorBreaker,
      openPositions: state.openPositions,
      openNotional: state.openNotional,
    };

    const [positions, orders, signals, markets, strategies, backtests, riskEvents] =
      await Promise.all([
        prisma.position.findMany({
          orderBy: { openedAt: "desc" },
          take: 50,
          include: { market: true, strategy: true },
        }),
        prisma.order.findMany({
          orderBy: { createdAt: "desc" },
          take: 50,
          include: { market: true },
        }),
        prisma.signal.findMany({
          orderBy: { timestamp: "desc" },
          take: 50,
          include: { strategy: true, market: true },
        }),
        prisma.market.findMany({
          take: env.COLLECTOR_MAX_TOPICS,
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

    const liveByVenue = new Map<string, { bestBid: number | null; bestAsk: number | null }>();
    await Promise.all(
      markets.map(async (market) => {
        const live = await readLiveOrderbook(market.venueMarketId);
        if (!live) return;
        liveByVenue.set(market.venueMarketId, {
          bestBid: asNumber(live.bestBid),
          bestAsk: asNumber(live.bestAsk),
        });
      }),
    );

    payload.positions = positions.map((row): DashboardPosition => {
      const live = liveByVenue.get(row.market.venueMarketId);
      const marketRow = markets.find((item) => item.id === row.marketId);
      const hist = asNumber(marketRow?.snapshots[0]?.lastPrice);
      const book = {
        bestBid: live?.bestBid ?? asNumber(marketRow?.snapshots[0]?.bestBid),
        bestAsk: live?.bestAsk ?? asNumber(marketRow?.snapshots[0]?.bestAsk),
        lastPrice: hist,
      };
      const marked = markPrice(row.side, book);
      const avg = asNumber(row.avgPrice) ?? 0;
      const shares = asNumber(row.shares) ?? 0;
      return {
        id: row.id,
        mode: row.mode,
        status: row.status,
        side: row.side,
        tokenId: row.tokenId,
        marketId: row.marketId,
        marketTitle: row.market.title,
        venueMarketId: row.market.venueMarketId,
        strategySlug: row.strategy?.slug ?? null,
        shares,
        avgPrice: avg,
        totalCost: asNumber(row.totalCost) ?? 0,
        realizedPnl: asNumber(row.realizedPnl) ?? 0,
        mark: marked.mark,
        markSource: marked.source,
        unrealizedPnl: unrealizedPnl(row.side, avg, shares, marked.mark),
        lastPriceHistorical: hist,
        openedAt: row.openedAt.toISOString(),
        closedAt: iso(row.closedAt),
      };
    });

    payload.orders = orders.map((row): DashboardOrder => ({
      id: row.id,
      clientOrderId: row.clientOrderId,
      status: row.status,
      side: row.side,
      tokenId: row.tokenId,
      marketTitle: row.market.title,
      requestedAmount: asNumber(row.requestedAmount) ?? 0,
      averagePrice: asNumber(row.averagePrice),
      filledUsdtAmount: asNumber(row.filledUsdtAmount),
      reason: orderReason(row.rawPayload),
      submittedAt: iso(row.submittedAt),
    }));

    payload.signals = signals.map((row): DashboardSignal => ({
      id: row.id,
      strategySlug: row.strategy.slug,
      marketTitle: row.market.title,
      direction: row.direction,
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
        title: row.title,
        symbol: row.topic.symbol,
        status: row.tradingStatus ?? row.status,
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
  } catch (error) {
    log.warn({ err: String(error) }, "dashboard query failed");
  }

  assertNoSecrets(payload);
  return payload;
}
