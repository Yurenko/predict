import { OrderSide, PositionStatus, TradingMode } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { asNumber } from "@/lib/normalize/numbers";
import { outcomeIsDownToken } from "@/lib/normalize/markets";
import { readLiveOrderbook } from "@/lib/ingest/raw-store";
import { env } from "@/lib/config/env";
import { executeLiveTrade } from "@/lib/live/engine";
import { invertBinaryBook } from "@/lib/live/binary";
import { quoteLiveExitSell } from "@/lib/live/exit-quote";
import { exitIntentFromOutcome } from "@/lib/live/intent-label";
import { readVenueTradableShares } from "@/lib/live/venue-shares";
import { isFreshLiveBook, liveFlattenExitPrice } from "@/lib/live/notional";
import { LIVE_INFLIGHT_STATUSES } from "@/lib/live/position-fill";
import { syncLiveOrdersFromVenue } from "@/lib/live/reconcile";
import { persistPaperTrade } from "@/lib/paper/persist";
import { manualCloseSignal } from "@/lib/paper/close";
import type { PaperBook, PaperTradeRequest } from "@/lib/paper/engine";
import { limitsFromEnv } from "@/lib/risk/limits";
import { loadRiskState, persistRiskSnapshot } from "@/lib/risk/persist";
import { recordClosedTrade } from "@/lib/risk/state";
import { ensureLiveRuntime } from "@/lib/record/live-runtime";

const log = childLogger({ component: "live-manual-close" });

export type LiveManualCloseReason =
  | "not_found"
  | "not_open"
  | "not_live"
  | "no_book"
  | "no_runtime"
  | "quote_failed"
  | "inflight"
  | "persist_failed"
  | "place_failed"
  | string;

export async function closeLivePosition(positionId: string): Promise<
  { ok: true; submitted: boolean } | { ok: false; reason: LiveManualCloseReason }
> {
  const row = await prisma.position.findUnique({
    where: { id: positionId },
    include: {
      strategy: true,
      outcome: { select: { name: true } },
      market: {
        include: {
          snapshots: { orderBy: { observedAt: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.mode !== TradingMode.LIVE) return { ok: false, reason: "not_live" };
  if (row.status !== PositionStatus.OPEN) return { ok: false, reason: "not_open" };

  const inflight = await prisma.order.findFirst({
    where: {
      mode: TradingMode.LIVE,
      marketId: row.marketId,
      tokenId: row.tokenId,
      status: { in: LIVE_INFLIGHT_STATUSES },
    },
    select: { id: true },
  });
  if (inflight) return { ok: false, reason: "inflight" };

  const snap = row.market.snapshots[0];
  const live = await readLiveOrderbook(row.market.venueMarketId);
  const nowForBook = new Date();
  const liveAgeMs = live?.updateTimestampMs
    ? nowForBook.getTime() - live.updateTimestampMs
    : null;
  const fresh = isFreshLiveBook(liveAgeMs);
  const upBid = (fresh ? asNumber(live?.bestBid) : null) ?? asNumber(snap?.bestBid);
  const upAsk = (fresh ? asNumber(live?.bestAsk) : null) ?? asNumber(snap?.bestAsk);
  const upLast = asNumber(snap?.lastPrice);
  const downToken = outcomeIsDownToken(row.outcome?.name);
  const priced = downToken
    ? invertBinaryBook({ bestBid: upBid, bestAsk: upAsk, lastPrice: upLast })
    : { bestBid: upBid, bestAsk: upAsk, lastPrice: upLast };
  const bestBid = priced.bestBid;
  const bestAsk = priced.bestAsk;
  const lastPrice = priced.lastPrice;
  const chance = asNumber(snap?.chance) ?? asNumber(snap?.midPrice);
  const avgPrice = asNumber(row.avgPrice) ?? 0;
  const price = liveFlattenExitPrice({
    positionSide: row.side,
    bestBid,
    bestAsk,
    lastPrice,
    avgPrice,
    aggressive: true,
  });
  if (!(price > 0) && chance === null) return { ok: false, reason: "no_book" };

  let shares = asNumber(row.shares) ?? 0;
  const limits = limitsFromEnv();
  const runtime = await ensureLiveRuntime();
  if (!runtime.ok) return { ok: false, reason: "no_runtime" };

  try {
    const venueShares = await readVenueTradableShares(
      runtime.venue,
      runtime.ctx.walletAddress,
      row.tokenId,
    );
    if (venueShares != null) shares = venueShares;
  } catch (error) {
    log.warn({ err: String(error), positionId }, "manual close venue shares skipped");
  }
  if (!(shares > 1e-8)) return { ok: false, reason: "below_market_min_amount" };

  let notional: number;
  let quote;
  let priceLimit: number | undefined;
  if (row.side === OrderSide.BUY) {
    const exitQuote = await quoteLiveExitSell({
      tokenId: row.tokenId,
      shares,
      bestBid,
      bestAsk,
      lastPrice,
      avgPrice,
      slippageBps: limits.maxSlippageBps,
    });
    if (exitQuote.belowMin || !exitQuote.quote) return { ok: false, reason: "quote_failed" };
    quote = exitQuote.quote;
    notional = exitQuote.notional;
    priceLimit = exitQuote.priceLimit;
  } else {
    return { ok: false, reason: "quote_failed" };
  }

  const now = new Date();
  const strategyId = row.strategy?.slug ?? "unknown";
  const dataAgeMs = fresh && liveAgeMs != null ? liveAgeMs : 0;
  const book: PaperBook = {
    bestBid: bestBid ?? price,
    bestAsk: bestAsk ?? price,
    lastPrice: null,
    liquidity: asNumber(snap?.liquidity),
    bidDepth: asNumber(snap?.bidDepth),
    askDepth: asNumber(snap?.askDepth),
    timeToExpirySec: snap?.timeToExpirySec ?? null,
    dataAgeMs,
  };
  const request: PaperTradeRequest = {
    mode: TradingMode.LIVE,
    action: "EXIT",
    strategyId,
    marketId: row.marketId,
    outcomeId: row.outcomeId ?? undefined,
    tokenId: row.tokenId,
    signal: manualCloseSignal({ strategyId, marketId: row.marketId, now, chance }),
    book,
    quote,
    now,
    requestedNotional: notional,
    maxPriceImpact: limits.maxPriceImpact,
    positionSide: row.side,
    positionId: row.id,
    orderSide: OrderSide.SELL,
    orderType: "LIMIT",
    priceLimit,
    exitIntent: exitIntentFromOutcome(row.outcome?.name),
    idempotencyWindowMs: env.LIVE_IDEMPOTENCY_MS,
    idempotencySalt: `flat-${shares.toFixed(6)}`,
  };

  const riskState = await loadRiskState();
  const result = await executeLiveTrade(request, riskState, limits, runtime.venue, runtime.ctx);
  if (!result.placed) {
    return { ok: false, reason: result.reason || "place_failed" };
  }

  const saved = await persistPaperTrade({ request, result, signal: request.signal });
  if (!saved) return { ok: false, reason: "persist_failed" };

  try {
    await syncLiveOrdersFromVenue(runtime.venue, runtime.ctx.walletAddress);
  } catch (error) {
    log.warn({ err: String(error), positionId }, "live close placed; reconcile deferred");
  }

  const closed = await prisma.position.findUnique({
    where: { id: row.id },
    select: { status: true, realizedPnl: true },
  });
  if (closed?.status && closed.status !== PositionStatus.OPEN) {
    const pnl = asNumber(closed.realizedPnl) ?? 0;
    const next = recordClosedTrade(riskState, pnl, now, limits);
    await persistRiskSnapshot({
      ...next.state,
      openPositions: Math.max(0, riskState.openPositions - 1),
      openNotional: Math.max(0, riskState.openNotional - shares * (asNumber(row.avgPrice) ?? 0)),
    });
  }

  log.info(
    { positionId, market: row.market.venueMarketId, venueOrderId: result.venueOrderId },
    "live position close submitted from dashboard",
  );
  return { ok: true, submitted: true };
}
