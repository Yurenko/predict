import { TradingMode } from "@prisma/client";
import { OfficialPredictionAdapter } from "@/lib/binance/prediction-adapter";
import { env, isLiveTradingEnabled } from "@/lib/config/env";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { asNumber } from "@/lib/normalize/numbers";
import { buildStrategyContext, clampObservedAt, rowsAtOrBefore } from "@/lib/backtest/context";
import type { UnderlyingTick } from "@/lib/backtest/types";
import { evaluateRisk } from "@/lib/risk/evaluate";
import { limitsFromEnv } from "@/lib/risk/limits";
import { loadRiskState, persistRiskDecision } from "@/lib/risk/persist";
import { createStrategy } from "@/lib/strategy";
import { readLiveOrderbook } from "@/lib/ingest/raw-store";
import { heldOrTradableMarketQuery, isShortCryptoUpDownRow } from "@/lib/markets/horizon";
import { isExpiredAt } from "@/lib/markets/settlement";
import { sleep } from "@/lib/binance/rate-limit";
import {
  fetchOfficialPaperQuote,
  flattenExpiredPositions,
  hasPredictionWallet,
  persistPaperTrade,
  shouldSkipPeerEnter,
  type PaperBook,
  type PaperQuote,
  type PaperTradeRequest,
} from "@/lib/paper";
import {
  executeLiveTrade,
  syncLiveOrdersFromVenue,
  type LiveTradeContext,
} from "@/lib/live";
import { invertBinaryBook, resolveBinaryWorkerTrade } from "@/lib/live/binary";
import {
  DEFAULT_LIVE_BINARY_MODE,
  liveOppositeCloses,
  shouldBlockLiveFlipEnter,
} from "@/lib/live/binary-mode";
import { outcomeIsDownToken } from "@/lib/normalize/markets";
import { quoteLiveExitSell } from "@/lib/live/exit-quote";
import { exitIntentFromOutcome } from "@/lib/live/intent-label";
import { readVenueTradableShares } from "@/lib/live/venue-shares";
import {
  LIVE_MIN_ORDER_USDT,
  canLiveEnterNotional,
  clipLiveOrderNotional,
  isFreshLiveBook,
} from "@/lib/live/notional";
import { LIVE_INFLIGHT_STATUSES, reservedLivePositionCount } from "@/lib/live/position-fill";
import {
  clearExpiredPendingFlips,
  clearPendingFlip,
  hasPeerPendingFlip,
  listPendingFlips,
  pendingFlipFromSignal,
  pendingFlipReservesSlot,
  reservedCountForEnter,
  pendingFlipSignal,
  readPendingFlip,
  shouldCancelPendingFlip,
  writePendingFlip,
} from "@/lib/live/pending-flip";
import { fetchLiveUsdtAvailable } from "@/lib/live/wallet-usdt";
import { claimLiveWinnings, syncLivePositionsFromVenue } from "@/lib/live/venue-sync";
import { selectPrimarySnapshot, tickFromSnapshot } from "@/lib/normalize/tick";

const log = childLogger({ component: "live-worker" });

let claimPassRunning = false;

function scheduleLiveClaim(
  venue: OfficialPredictionAdapter,
  ctx: LiveTradeContext,
): void {
  if (claimPassRunning) return;
  claimPassRunning = true;
  void claimLiveWinnings(venue, ctx)
    .then((result) => {
      if (result.claimed > 0) log.info(result, "live claim (async)");
    })
    .catch((error) => {
      log.warn({ err: String(error) }, "live claim (async) skipped");
    })
    .finally(() => {
      claimPassRunning = false;
    });
}

const liveMarketInclude = {
  topic: true,
  outcomes: true,
  snapshots: { orderBy: { observedAt: "desc" as const }, take: 60 },
} as const;

async function recentUnderlyingsBySymbol(): Promise<Map<string, UnderlyingTick[]>> {
  const underlyingsRaw = await prisma.underlyingSnapshot.findMany({
    where: { observedAt: { gte: new Date(Date.now() - 30 * 60_000) } },
    orderBy: { observedAt: "asc" },
  });
  const underlyingsBySymbol = new Map<string, UnderlyingTick[]>();
  for (const row of underlyingsRaw) {
    const price = asNumber(row.price);
    if (!price) continue;
    const list = underlyingsBySymbol.get(row.symbol) ?? [];
    list.push({
      observedAt: row.observedAt,
      symbol: row.symbol,
      price,
      bid: asNumber(row.bid),
      ask: asNumber(row.ask),
      volume: asNumber(row.volume),
    });
    underlyingsBySymbol.set(row.symbol, list);
  }
  return underlyingsBySymbol;
}

async function countOpenLivePositions(): Promise<number> {
  return prisma.position.count({
    where: { mode: TradingMode.LIVE, status: "OPEN" },
  });
}

async function pruneExpiredLivePendings(now: Date): Promise<void> {
  const pendings = await listPendingFlips();
  const ids = [...new Set(pendings.map((row) => row.marketId))];
  if (ids.length === 0) return;
  const markets = await prisma.market.findMany({
    where: { id: { in: ids } },
    select: { id: true, topic: { select: { endDate: true } } },
  });
  await clearExpiredPendingFlips(
    new Map(markets.map((row) => [row.id, row.topic.endDate])),
    now,
  );
}

async function liveSlotUsage(): Promise<{ reserved: number; openAndInflight: number }> {
  const [open, inflight, pendings] = await Promise.all([
    prisma.position.findMany({
      where: { mode: TradingMode.LIVE, status: "OPEN" },
      select: { tokenId: true, marketId: true, strategyId: true },
    }),
    prisma.order.findMany({
      where: { mode: TradingMode.LIVE, status: { in: LIVE_INFLIGHT_STATUSES } },
      select: { tokenId: true, marketId: true, signal: { select: { strategyId: true } } },
    }),
    listPendingFlips(),
  ]);
  const openKeys = new Set(open.map((row) => `${row.strategyId}:${row.marketId}`));
  const openTokens = new Set(open.map((row) => row.tokenId).filter(Boolean));
  const inflightEnterKeys = new Set(
    inflight
      .filter((row) => row.tokenId && !openTokens.has(row.tokenId))
      .map((row) => `${row.signal?.strategyId ?? ""}:${row.marketId}`),
  );
  let pendingUncovered = 0;
  for (const pending of pendings) {
    const key = `${pending.strategyId}:${pending.marketId}`;
    if (
      pendingFlipReservesSlot({
        hasOpenOnMarket: openKeys.has(key),
        hasInflightEnterOnMarket: inflightEnterKeys.has(key),
      })
    ) {
      pendingUncovered += 1;
    }
  }
  const tokens = open.map((row) => row.tokenId);
  const inflightTokens = inflight.map((row) => row.tokenId);
  return {
    openAndInflight: reservedLivePositionCount(tokens, inflightTokens, 0),
    reserved: reservedLivePositionCount(tokens, inflightTokens, pendingUncovered),
  };
}

async function reservedLiveSlots(): Promise<number> {
  return (await liveSlotUsage()).reserved;
}

/** Local settlement only — Binance already expires the contract; never placeOrder. */
export async function settleExpiredLivePositions(): Promise<{ filled: number }> {
  const limits = limitsFromEnv();
  const riskState = await loadRiskState();
  const settled = await flattenExpiredPositions({
    mode: TradingMode.LIVE,
    now: new Date(),
    riskState,
    limits,
    underlyingsBySymbol: await recentUnderlyingsBySymbol(),
  });
  return { filled: settled.filled };
}

export async function runLiveOnce(ctx: LiveTradeContext, venue: OfficialPredictionAdapter): Promise<{
  enabled: number;
  considered: number;
  submitted: number;
  open: number;
}> {
  try {
    const applied = await syncLiveOrdersFromVenue(venue, ctx.walletAddress);
    if (applied > 0) log.info({ applied }, "live reconcile before cycle");
  } catch (error) {
    log.warn({ err: String(error) }, "live reconcile before cycle skipped");
  }

  const limits = limitsFromEnv();
  const underlyingsBySymbol = await recentUnderlyingsBySymbol();
  let riskState = await loadRiskState();
  const now = new Date();
  await pruneExpiredLivePendings(now);
  const settled = await flattenExpiredPositions({
    mode: TradingMode.LIVE,
    now,
    riskState,
    limits,
    underlyingsBySymbol,
  });
  if (settled.filled > 0) {
    log.info({ filled: settled.filled }, "live positions settled at expiry");
  }
  riskState = await loadRiskState();

  try {
    const venueSync = await syncLivePositionsFromVenue(venue, ctx, { claim: false });
    log.info(venueSync, "live venue position sync");
  } catch (error) {
    log.warn({ err: String(error) }, "live venue position sync skipped");
  }
  riskState = {
    ...riskState,
    openPositions: await reservedLiveSlots(),
  };

  const availableUsdt = await fetchLiveUsdtAvailable(ctx.accountType);
  const binaryMode = DEFAULT_LIVE_BINARY_MODE;
  const oppositeCloses = liveOppositeCloses(binaryMode);

  const enabled = await prisma.strategy.findMany({ where: { enabled: true } });
  if (enabled.length === 0) {
    log.info("no enabled strategies; live trader is idle");
    return { enabled: 0, considered: 0, submitted: 0, open: await countOpenLivePositions() };
  }

  const markets = await prisma.market.findMany({
    ...heldOrTradableMarketQuery(now, { mode: TradingMode.LIVE }),
    include: liveMarketInclude,
  });

  let considered = 0;
  let submitted = 0;
  const skips = {
    noSignal: 0,
    hold: 0,
    inflight: 0,
    peer: 0,
    belowMin: 0,
    usdt: 0,
    tte: 0,
    risk: 0,
    enter: 0,
  };

  for (const market of markets) {
    const picked = selectPrimarySnapshot(market.snapshots, market.outcomes);
    if (!picked) continue;
    const { snapshot: latest, outcome } = picked;
    if (isExpiredAt(now, market.topic.endDate)) {
      for (const row of enabled) {
        await clearPendingFlip(row.id, market.id);
      }
      continue;
    }
    considered += 1;

    let tick = clampObservedAt(tickFromSnapshot({ ...latest, market, outcome }), now);
    const snapBid = tick.bestBid;
    const snapAsk = tick.bestAsk;
    const snapLast = tick.lastPrice;
    const live = await readLiveOrderbook(market.venueMarketId);
    const liveAgeMs = live?.updateTimestampMs ? now.getTime() - live.updateTimestampMs : null;
    const freshLive = isFreshLiveBook(liveAgeMs);
    if (live) {
      tick = {
        ...tick,
        bestBid: asNumber(live.bestBid) ?? tick.bestBid,
        bestAsk: asNumber(live.bestAsk) ?? tick.bestAsk,
      };
    }

    const dataAgeMs = live?.updateTimestampMs
      ? now.getTime() - live.updateTimestampMs
      : now.getTime() - tick.observedAt.getTime();

    const probability = rowsAtOrBefore(
      market.snapshots
        .slice()
        .reverse()
        .flatMap((row) => {
          const value = asNumber(row.chance) ?? asNumber(row.midPrice);
          return value === null ? [] : [{ observedAt: row.observedAt, value }];
        }),
      now,
    );

    let ctxStrategy;
    try {
      ctxStrategy = buildStrategyContext({
        now,
        tick,
        underlyings: rowsAtOrBefore(
          tick.symbol ? (underlyingsBySymbol.get(tick.symbol) ?? []) : [],
          now,
        ),
        probability,
        quotes: [],
        rollingWindow: 60,
      });
    } catch (error) {
      log.warn(
        { err: String(error), market: market.venueMarketId },
        "live strategy context skipped",
      );
      continue;
    }

    for (const row of enabled) {
      const params = (row.parameters ?? {}) as Record<string, unknown>;
      const strategy = createStrategy(row.slug, params);
      if (!strategy) continue;
      const signal = strategy.evaluate(ctxStrategy);
      let pending = oppositeCloses ? await readPendingFlip(row.id, market.id) : null;
      if (pending && shouldCancelPendingFlip(pending.side, signal?.direction)) {
        log.info(
          { slug: row.slug, market: market.venueMarketId, pending: pending.side, signal: signal?.direction },
          "pending flip cancelled",
        );
        await clearPendingFlip(row.id, market.id);
        pending = null;
      }
      const tteSec = ctxStrategy.timeToExpirySec;
      const tooCloseToExpiry =
        isExpiredAt(now, market.topic.endDate) ||
        (tteSec != null && tteSec < limits.minTimeToExpirySec);
      if (pending && tooCloseToExpiry) {
        await clearPendingFlip(row.id, market.id);
        pending = null;
        skips.tte += 1;
      }
      if (!signal && !pending) {
        skips.noSignal += 1;
        continue;
      }
      const actingSignal =
        signal ??
        pendingFlipSignal({
          strategyId: row.slug,
          marketId: market.id,
          now,
          side: pending!.side,
          chance: asNumber(latest.chance) ?? asNumber(latest.midPrice),
        });
      const primaryTokenId = tick.tokenId;
      if (!primaryTokenId) continue;

      // Independent: Up and Down are separate legs; only EXIT closes.
      // Flip (Paper-style): SELL while long Up exits Up first; Down opens next tick
      // after that row is CLOSED and no EXIT is still in flight.
      const opens = await prisma.position.findMany({
        where: {
          mode: TradingMode.LIVE,
          status: "OPEN",
          marketId: market.id,
          strategyId: row.id,
        },
        include: { outcome: { select: { name: true } } },
      });
      const openUp =
        opens.find((item) => !outcomeIsDownToken(item.outcome?.name ?? null)) ?? null;
      const openDown =
        opens.find((item) => outcomeIsDownToken(item.outcome?.name ?? null)) ?? null;
      const trade = resolveBinaryWorkerTrade({
        direction: actingSignal.direction,
        hasOpenUp: Boolean(openUp),
        hasOpenDown: Boolean(openDown),
        openUpTokenId: openUp?.tokenId,
        openDownTokenId: openDown?.tokenId,
        oppositeCloses,
        primaryTokenId,
        primaryOutcomeId: tick.outcomeId,
        outcomes: market.outcomes,
      });
      if (!trade) {
        skips.hold += 1;
        continue;
      }
      if (trade.paperAction === "ENTER") skips.enter += 1;

      const open =
        trade.tokenId === openDown?.tokenId
          ? openDown
          : trade.tokenId === openUp?.tokenId
            ? openUp
            : null;

      const inflight = await prisma.order.findFirst({
        where: {
          mode: TradingMode.LIVE,
          marketId: market.id,
          tokenId: trade.tokenId,
          status: { in: LIVE_INFLIGHT_STATUSES },
          signal: { strategyId: row.id },
        },
        select: { id: true },
      });
      if (inflight) {
        skips.inflight += 1;
        continue;
      }

      // Flip: do not BUY Down while Up EXIT is still SUBMITTED / leftover OPEN.
      // The Down ticket uses bankroll sizing, never leftover Up shares.
      if (trade.paperAction === "ENTER" && oppositeCloses) {
        const inflightOnMarket = await prisma.order.findFirst({
          where: {
            mode: TradingMode.LIVE,
            marketId: market.id,
            status: { in: LIVE_INFLIGHT_STATUSES },
            signal: { strategyId: row.id },
          },
          select: { id: true },
        });
        if (
          shouldBlockLiveFlipEnter({
            mode: binaryMode,
            action: trade.paperAction,
            stillOpen: Boolean(openUp || openDown),
            inflightOnMarket: Boolean(inflightOnMarket),
          })
        ) {
          skips.inflight += 1;
          continue;
        }
      }

      const action = trade.paperAction;
      const tokenId = trade.tokenId;
      if (action === "EXIT" && !open) {
        skips.hold += 1;
        continue;
      }

      if (action === "ENTER" && !isShortCryptoUpDownRow(market)) {
        skips.enter += 1;
        continue;
      }

      if (action === "ENTER") {
        const [peerOpen, peerInflight, peerPending] = await Promise.all([
          prisma.position.findFirst({
            where: {
              mode: TradingMode.LIVE,
              status: "OPEN",
              marketId: market.id,
              NOT: { strategyId: row.id },
            },
            select: { id: true },
          }),
          prisma.order.findFirst({
            where: {
              mode: TradingMode.LIVE,
              marketId: market.id,
              status: { in: LIVE_INFLIGHT_STATUSES },
              signal: { strategyId: { not: row.id } },
            },
            select: { id: true },
          }),
          hasPeerPendingFlip(market.id, row.id),
        ]);
        if (
          shouldSkipPeerEnter("single", "ENTER", Boolean(peerOpen || peerInflight || peerPending))
        ) {
          skips.peer += 1;
          continue;
        }
      }

      if (
        oppositeCloses &&
        action === "EXIT" &&
        signal &&
        (signal.direction === "BUY" || signal.direction === "SELL")
      ) {
        const wanted = pendingFlipFromSignal(signal.direction);
        if (wanted) {
          await writePendingFlip({
            strategyId: row.id,
            marketId: market.id,
            side: wanted,
            fromTokenId: open?.tokenId,
            endDate: market.topic.endDate,
            now,
          });
        }
      }

      const upBook =
        action === "EXIT" && !freshLive
          ? { bestBid: snapBid, bestAsk: snapAsk, lastPrice: snapLast }
          : { bestBid: tick.bestBid, bestAsk: tick.bestAsk, lastPrice: tick.lastPrice };
      const priced = trade.invertBook ? invertBinaryBook(upBook) : upBook;

      const book: PaperBook = {
        bestBid: priced.bestBid,
        bestAsk: priced.bestAsk,
        lastPrice: priced.lastPrice,
        liquidity: tick.liquidity,
        bidDepth: tick.bidDepth,
        askDepth: tick.askDepth,
        timeToExpirySec: ctxStrategy.timeToExpirySec,
        dataAgeMs,
      };

      let quotedNotional: number;
      let quote: PaperQuote | null = null;
      let exitShares = open ? Number(open.shares) : 0;
      let exitPriceLimit: number | undefined;
      const exitIntent =
        action === "EXIT" ? exitIntentFromOutcome(open?.outcome?.name ?? null) : undefined;
      if (action === "EXIT" && open) {
        try {
          const venueShares = await readVenueTradableShares(venue, ctx.walletAddress, tokenId);
          if (venueShares != null) exitShares = venueShares;
        } catch (error) {
          log.warn({ err: String(error), tokenId }, "live EXIT venue shares skipped");
        }
        if (!(exitShares > 1e-8)) {
          log.info(
            { slug: row.slug, market: market.venueMarketId },
            "live EXIT skipped: Binance ONGOING shares are 0",
          );
          continue;
        }
        const exitQuote = await quoteLiveExitSell({
          tokenId,
          shares: exitShares,
          bestBid: priced.bestBid,
          bestAsk: priced.bestAsk,
          lastPrice: priced.lastPrice,
          avgPrice: Number(open.avgPrice),
          slippageBps: limits.maxSlippageBps,
        });
        if (exitQuote.belowMin || !exitQuote.quote) {
          log.info(
            {
              slug: row.slug,
              market: market.venueMarketId,
              exceeded: exitQuote.quote ? false : exitQuote.exceeded,
              notional: exitQuote.notional,
              shares: exitShares,
            },
            "live EXIT getQuote failed",
          );
          continue;
        }
        quote = exitQuote.quote;
        quotedNotional = exitQuote.notional;
        exitPriceLimit = exitQuote.priceLimit;
      } else {
        // Flip Down after a closed Up uses the same bankroll ticket, not leftover Up shares.
        quotedNotional = clipLiveOrderNotional({
          action,
          requested: limits.bankrollUsdt * (limits.maxPositionPct / 100),
          bankrollUsdt: limits.bankrollUsdt,
          maxPositionPct: limits.maxPositionPct,
        });
        if (quotedNotional < LIVE_MIN_ORDER_USDT) {
          skips.belowMin += 1;
          continue;
        }
        if (!canLiveEnterNotional(availableUsdt, quotedNotional)) {
          skips.usdt += 1;
          log.info(
            {
              slug: row.slug,
              market: market.venueMarketId,
              availableUsdt,
              quotedNotional,
            },
            "live ENTER skipped: not enough USDT",
          );
          continue;
        }
        quote = await fetchOfficialPaperQuote({
          tokenId,
          side: trade.orderSide,
          amountUsdt: quotedNotional,
          slippageBps: limits.maxSlippageBps,
        });
      }

      const usage = await liveSlotUsage();
      riskState = {
        ...riskState,
        openPositions: reservedCountForEnter({
          reserved: usage.reserved,
          openAndInflight: usage.openAndInflight,
          fulfillsPendingFlip: action === "ENTER" && Boolean(pending),
        }),
      };
      const pre = evaluateRisk(
        {
          action,
          mode: TradingMode.LIVE,
          now,
          strategyId: row.slug,
          marketId: market.id,
          requestedNotional: quotedNotional,
          bestBid: priced.bestBid,
          bestAsk: priced.bestAsk,
          lastPrice: priced.lastPrice,
          liquidity: tick.liquidity,
          timeToExpirySec: ctxStrategy.timeToExpirySec,
          estimatedSlippageBps: null,
          estimatedPriceImpact: null,
          quoteExpireAt: null,
          dataAgeMs,
        },
        riskState,
        limits,
      );
      if (!pre.allowed) {
        skips.risk += 1;
        if (
          action === "ENTER" &&
          pending &&
          pre.checks.some((check) => !check.passed && check.name === "min_time_to_expiry")
        ) {
          await clearPendingFlip(row.id, market.id);
        }
        log.info(
          {
            slug: row.slug,
            market: market.venueMarketId,
            action,
            blocked: pre.checks.filter((check) => !check.passed).map((check) => check.name),
          },
          "live risk rejected",
        );
        await persistRiskDecision(pre, { marketId: market.id, strategyId: row.id });
        riskState = pre.nextState;
        continue;
      }

      const request: PaperTradeRequest = {
        mode: TradingMode.LIVE,
        action,
        strategyId: row.slug,
        marketId: market.id,
        outcomeId: trade.outcomeId,
        tokenId,
        signal: actingSignal,
        book,
        quote,
        now,
        requestedNotional: quotedNotional,
        maxPriceImpact: limits.maxPriceImpact,
        positionSide: open?.side,
        positionId: open?.id,
        orderSide: trade.orderSide,
        orderType: action === "EXIT" ? "LIMIT" : "MARKET",
        priceLimit: exitPriceLimit,
        exitIntent,
        idempotencyWindowMs: env.LIVE_IDEMPOTENCY_MS,
        idempotencySalt: action === "EXIT" ? `flat-${exitShares.toFixed(6)}` : undefined,
      };

      const result = await executeLiveTrade(request, riskState, limits, venue, ctx);
      if (result.riskDecision) {
        await persistRiskDecision(result.riskDecision, {
          marketId: market.id,
          strategyId: row.id,
        });
        riskState = result.riskDecision.nextState;
      }
      if (result.placed && action === "ENTER") {
        riskState = {
          ...riskState,
          openPositions: riskState.openPositions + 1,
          openNotional: riskState.openNotional + quotedNotional,
        };
      }

      if (result.placed || quote) {
        await persistPaperTrade({ request, result, signal: actingSignal });
        if (result.placed) submitted += 1;
        if (result.placed && action === "ENTER") {
          await clearPendingFlip(row.id, market.id);
        }
        if (result.placed && action === "EXIT") {
          riskState = {
            ...riskState,
            openPositions: await reservedLiveSlots(),
          };
        }
      }

      log.info(
        {
          slug: row.slug,
          market: market.venueMarketId,
          action,
          intent: exitIntent,
          binary: trade.binary,
          token: trade.invertBook ? "down" : "up",
          status: result.status,
          reason: result.reason,
          venueOrderId: result.venueOrderId,
          placed: result.placed,
        },
        "live decision",
      );
    }
  }

  try {
    const applied = await syncLiveOrdersFromVenue(venue, ctx.walletAddress);
    log.info({ applied }, "live reconcile");
  } catch (error) {
    log.warn({ err: String(error) }, "live reconcile skipped");
  }

  scheduleLiveClaim(venue, ctx);

  const open = await countOpenLivePositions();
  log.info(
    { enabled: enabled.length, considered, submitted, open, binaryMode, availableUsdt, ...skips },
    "live cycle complete",
  );
  return { enabled: enabled.length, considered, submitted, open };
}

export async function startLiveTrader(): Promise<void> {
  log.info(
    {
      intervalMs: env.LIVE_LOOP_INTERVAL_MS,
      liveTradingEnabled: isLiveTradingEnabled(),
      hasWallet: hasPredictionWallet(),
    },
    "starting live trader (placeOrder only after dashboard Start, when both live flags are on)",
  );

  if (!isLiveTradingEnabled()) {
    log.warn("LIVE_TRADING_ENABLED+TRADING_MODE=LIVE are off; not calling placeOrder");
    do {
      if (env.COLLECTOR_ONCE) return;
      await sleep(env.LIVE_LOOP_INTERVAL_MS);
    } while (true);
  }

  const { runRecordLoop } = await import("@/lib/record/loop");
  await runRecordLoop({ exitOnSignal: true });
}
