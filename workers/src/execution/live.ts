import { OrderSide, Prisma, TradingMode } from "@prisma/client";
import { OfficialPredictionAdapter } from "@/lib/binance/prediction-adapter";
import { env, isLiveTradingEnabled } from "@/lib/config/env";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { asNumber } from "@/lib/normalize/numbers";
import { buildStrategyContext, clampObservedAt, rowsAtOrBefore } from "@/lib/backtest/context";
import type { UnderlyingTick } from "@/lib/backtest/types";
import { evaluateRisk } from "@/lib/risk/evaluate";
import { shouldClearPendingFlipOnBlockedEnter } from "@/lib/risk/entry-ask";
import { limitsFromEnv } from "@/lib/risk/limits";
import { loadRiskState, persistRiskDecision } from "@/lib/risk/persist";
import type { RiskLimits, RiskSnapshot } from "@/lib/risk/types";
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
  manualCloseSignal,
  shouldSkipPeerEnter,
  type PaperBook,
  type PaperQuote,
  type PaperTradeRequest,
} from "@/lib/paper";
import {
  applyOfficialLiveOrder,
  executeLiveTrade,
  syncLiveOrdersFromVenue,
  type LiveTradeContext,
} from "@/lib/live";
import { invertBinaryBook, resolveBinaryWorkerTrade } from "@/lib/live/binary";
import {
  liveOppositeCloses,
  liveStrategyParams,
  readLiveBinaryMode,
  shouldBlockLiveFlipEnter,
} from "@/lib/live/binary-mode";
import { outcomeIsDownToken } from "@/lib/normalize/markets";
import { quoteLiveExitSell } from "@/lib/live/exit-quote";
import { exitIntentFromOutcome } from "@/lib/live/intent-label";
import { readVenueTradableShares } from "@/lib/live/venue-shares";
import {
  LIVE_MIN_ORDER_USDT,
  clipLiveOrderNotional,
  isFreshLiveBook,
} from "@/lib/live/notional";
import { isLiveDustPosition, LIVE_INFLIGHT_STATUSES, reservedLivePositionCount } from "@/lib/live/position-fill";
import { isLiveFlattening, stampLiveVenueFlat } from "@/lib/live/flatten";
import {
  clearExpiredPendingFlips,
  clearPendingFlip,
  hasPeerPendingFlip,
  listPendingFlips,
  pendingFlipFromSignal,
  pendingFlipReservesSlot,
  reservedCountForEnter,
  readPendingFlip,
  shouldCancelPendingFlip,
  writePendingFlip,
  type PendingFlipSide,
} from "@/lib/live/pending-flip";
import { syncLivePositionsFromVenue } from "@/lib/live/venue-sync";
import {
  shouldArmLiveClaimAfterClose,
  shouldRefreshLiveAccountAfterCycle,
} from "@/lib/live/sync-scope";
import { armLiveClaimAfterClose, refreshLiveAccountAfterClose } from "@/lib/live/after-close";
import {
  confirmLiveFlipExit,
  shouldConfirmFlipExit,
  shouldRecoverFlipEnter,
} from "@/lib/live/flip-followthrough";
import { selectPrimarySnapshot, tickFromSnapshot } from "@/lib/normalize/tick";
import type { PredictionOrderbookPayload } from "@/lib/binance/sapi-wss";

const log = childLogger({ component: "live-worker" });

async function applyLiveCloseFollowup(
  venue: OfficialPredictionAdapter,
  ctx: LiveTradeContext,
  closed: number,
): Promise<void> {
  try {
    if (shouldRefreshLiveAccountAfterCycle({ closed })) {
      await refreshLiveAccountAfterClose(venue, ctx);
    }
  } catch (error) {
    log.warn({ err: String(error) }, "live reconcile after close skipped");
  }
  if (shouldArmLiveClaimAfterClose({ closed })) {
    armLiveClaimAfterClose(venue, ctx);
  }
}

async function markLivePositionVenueFlat(position: {
  id: string;
  rawPayload: unknown;
}): Promise<void> {
  await prisma.position.update({
    where: { id: position.id },
    data: {
      rawPayload: stampLiveVenueFlat(position.rawPayload) as Prisma.InputJsonValue,
    },
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

async function retryLiveFlattening(
  ctx: LiveTradeContext,
  venue: OfficialPredictionAdapter,
): Promise<number> {
  const rows = await prisma.position.findMany({
    where: { mode: TradingMode.LIVE, status: "OPEN" },
    include: {
      strategy: true,
      outcome: { select: { name: true } },
      market: {
        include: {
          topic: true,
          snapshots: { orderBy: { observedAt: "desc" as const }, take: 1 },
        },
      },
    },
  });

  let submitted = 0;
  const limits = limitsFromEnv();
  for (const row of rows) {
    if (!isLiveFlattening(row.rawPayload)) continue;
    if (isExpiredAt(new Date(), row.market.topic.endDate)) continue;

    const inflight = await prisma.order.findFirst({
      where: {
        mode: TradingMode.LIVE,
        marketId: row.marketId,
        tokenId: row.tokenId,
        status: { in: LIVE_INFLIGHT_STATUSES },
      },
      select: { id: true },
    });
    if (inflight) continue;

    const live = await readLiveOrderbook(row.market.venueMarketId);
    if (!live) continue;
    const liveAgeMs = live.updateTimestampMs
      ? Date.now() - live.updateTimestampMs
      : null;
    if (!isFreshLiveBook(liveAgeMs)) continue;

    let shares = asNumber(row.shares) ?? 0;
    try {
      const venueShares = await readVenueTradableShares(venue, ctx.walletAddress, row.tokenId);
      if (venueShares != null) shares = venueShares;
    } catch (error) {
      log.warn({ err: String(error), tokenId: row.tokenId }, "live flatten retry skipped: shares unavailable");
      continue;
    }
    if (!(shares > 1e-8)) continue;

    const downToken = outcomeIsDownToken(row.outcome?.name);
    const snap = row.market.snapshots[0];
    const rawBook = {
      bestBid: asNumber(live.bestBid),
      bestAsk: asNumber(live.bestAsk),
      lastPrice: asNumber(snap?.lastPrice),
    };
    const priced = downToken ? invertBinaryBook(rawBook) : rawBook;
    const avgPrice = asNumber(row.avgPrice) ?? 0;
    const exitQuote = await quoteLiveExitSell({
      tokenId: row.tokenId,
      shares,
      bestBid: priced.bestBid,
      bestAsk: priced.bestAsk,
      lastPrice: priced.lastPrice,
      avgPrice,
      slippageBps: limits.maxSlippageBps,
    });
    if (exitQuote.belowMin || !exitQuote.quote) continue;

    const now = new Date();
    const strategyId = row.strategy?.slug ?? "flatten-retry";
    const chance = asNumber(snap?.chance) ?? asNumber(snap?.midPrice);
    const book: PaperBook = {
      bestBid: priced.bestBid,
      bestAsk: priced.bestAsk,
      lastPrice: priced.lastPrice,
      liquidity: asNumber(snap?.liquidity),
      bidDepth: asNumber(snap?.bidDepth),
      askDepth: asNumber(snap?.askDepth),
      timeToExpirySec: row.market.topic.endDate
        ? Math.max(0, (row.market.topic.endDate.getTime() - now.getTime()) / 1000)
        : null,
      dataAgeMs: liveAgeMs ?? 0,
    };
    const signal = manualCloseSignal({
      strategyId,
      marketId: row.marketId,
      now,
      chance,
    });
    const request: PaperTradeRequest = {
      mode: TradingMode.LIVE,
      action: "EXIT",
      strategyId,
      marketId: row.marketId,
      outcomeId: row.outcomeId ?? undefined,
      tokenId: row.tokenId,
      signal,
      book,
      quote: exitQuote.quote,
      now,
      requestedNotional: exitQuote.notional,
      maxPriceImpact: limits.maxPriceImpact,
      positionSide: row.side,
      positionId: row.id,
      orderSide: OrderSide.SELL,
      orderType: "MARKET",
      exitIntent: exitIntentFromOutcome(row.outcome?.name),
      idempotencyWindowMs: env.LIVE_IDEMPOTENCY_MS,
      idempotencySalt: `flatten-retry-${shares.toFixed(8)}-${Math.floor(now.getTime() / 5_000)}`,
    };

    const riskState = await loadRiskState();
    const result = await executeLiveTrade(request, riskState, limits, venue, ctx);
    if (!result.placed) continue;
    await persistPaperTrade({ request, result, signal });
    submitted += 1;
    log.info(
        { positionId: row.id, tokenId: row.tokenId, shares, venueOrderId: result.venueOrderId },
        "live flatten retry submitted",
    );
  }
  return submitted;
}

async function liveSlotUsage(): Promise<{ reserved: number; openAndInflight: number }> {
  const [open, inflight, pendings] = await Promise.all([
    prisma.position.findMany({
      where: { mode: TradingMode.LIVE, status: "OPEN" },
      select: {
        tokenId: true,
        marketId: true,
        strategyId: true,
        rawPayload: true,
        shares: true,
        avgPrice: true,
      },
    }),
    prisma.order.findMany({
      where: { mode: TradingMode.LIVE, status: { in: LIVE_INFLIGHT_STATUSES } },
      select: {
        tokenId: true,
        marketId: true,
        rawPayload: true,
        signal: { select: { strategyId: true } },
      },
    }),
    listPendingFlips(),
  ]);

  // One tiny residual (<= $0.01) is kept as an OPEN cleanup position, but it
  // does not consume the user's normal MAX_SIMULTANEOUS_POSITIONS capacity.
  // If multiple dust rows accumulate, only the first gets the free cleanup
  // slot; additional dust rows count normally.
  const dustOpen = open.filter((row) =>
    isLiveDustPosition({
      rawPayload: row.rawPayload,
      shares: row.shares,
      avgPrice: row.avgPrice,
    }),
  );
  const normalOpen = open.filter((row) => !dustOpen.includes(row));
  const extraDustSlots = Math.max(0, dustOpen.length - 1);

  const openKeys = new Set(normalOpen.map((row) => `${row.strategyId}:${row.marketId}`));
  const openTokens = new Set(normalOpen.map((row) => row.tokenId).filter(Boolean));
  const inflightEnter = inflight.filter((row) => {
    const raw =
      row.rawPayload && typeof row.rawPayload === "object" && !Array.isArray(row.rawPayload)
        ? (row.rawPayload as Record<string, unknown>)
        : {};
    const action = raw.action;
    return action == null || action === "ENTER";
  });
  const inflightEnterKeys = new Set(
    inflightEnter
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
  const tokens = normalOpen.map((row) => row.tokenId);
  const inflightTokens = inflightEnter.map((row) => row.tokenId);
  // Match paper: pending leftovers occupy reserved capacity for a *new* market,
  // but must not inflate openAndInflight or a flip ENTER deadlocks at MAX=1.
  const occupied = reservedLivePositionCount(tokens, inflightTokens, 0);
  const reserved = reservedLivePositionCount(tokens, inflightTokens, pendingUncovered);
  return {
    openAndInflight: occupied + extraDustSlots,
    reserved: reserved + extraDustSlots,
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


/**
 * Take-profit / trailing / strong-reversal used to exit here from the
 * prediction WS. Live now matches Paper: only the strategy cycle closes.
 */
export async function runLiveRealtimePositionManagement(
  _book: PredictionOrderbookPayload,
  _ctx: LiveTradeContext,
  _venue: OfficialPredictionAdapter,
): Promise<void> {}

export async function runLiveOnce(ctx: LiveTradeContext, venue: OfficialPredictionAdapter): Promise<{
  enabled: number;
  considered: number;
  submitted: number;
  open: number;
}> {
  // LIVE never trades from a stale local snapshot after an account-sync
  // failure. Binance is the source of truth for real inventory.
  let accountStateHealthy = true;
  try {
    const applied = await syncLiveOrdersFromVenue(venue, ctx.walletAddress);
    if (applied > 0) log.info({ applied }, "live reconcile before cycle");
  } catch (error) {
    accountStateHealthy = false;
    log.error({ err: String(error) }, "live reconcile before cycle FAILED");
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
  let closed = settled.filled;
  riskState = await loadRiskState();

  try {
    const venueSync = await syncLivePositionsFromVenue(venue, ctx, { claim: false });
    log.info(venueSync, "live venue position sync");
  } catch (error) {
    accountStateHealthy = false;
    log.error({ err: String(error) }, "live venue position sync FAILED");
  }

  if (!accountStateHealthy) {
    log.error(
      "LIVE trading cycle aborted: Binance order/position state could not be verified",
    );
    if (shouldArmLiveClaimAfterClose({ closed })) {
      armLiveClaimAfterClose(venue, ctx);
    }
    return {
      enabled: 0,
      considered: 0,
      submitted: 0,
      open: await countOpenLivePositions(),
    };
  }

  riskState = {
    ...riskState,
    openPositions: await reservedLiveSlots(),
  };

  const binaryMode = await readLiveBinaryMode();
  const oppositeCloses = liveOppositeCloses(binaryMode);

  const enabled = await prisma.strategy.findMany({ where: { enabled: true } });
  if (enabled.length === 0) {
    log.info("no enabled strategies; live trader is idle");
    await applyLiveCloseFollowup(venue, ctx, closed);
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
      const opens = await prisma.position.findMany({
        where: {
          mode: TradingMode.LIVE,
          status: "OPEN",
          marketId: market.id,
          strategyId: row.id,
        },
        include: { outcome: { select: { name: true } } },
      });
      const tradableOpens = opens.filter(
        (item) => !isLiveDustPosition({ rawPayload: item.rawPayload, shares: item.shares, avgPrice: item.avgPrice }),
      );
      const openUp =
        tradableOpens.find((item) => !outcomeIsDownToken(item.outcome?.name ?? null)) ?? null;
      const openDown =
        tradableOpens.find((item) => outcomeIsDownToken(item.outcome?.name ?? null)) ?? null;
      let pending = oppositeCloses ? await readPendingFlip(row.id, market.id) : null;
      const params = liveStrategyParams({
        parameters: (row.parameters ?? {}) as Record<string, unknown>,
        keepSignallingNearExpiry:
          oppositeCloses && Boolean(openUp || openDown || pending),
      });
      const strategy = createStrategy(row.slug, params);
      if (!strategy) continue;
      const signal = strategy.evaluate(ctxStrategy);

      if (pending && shouldCancelPendingFlip(pending.side, signal?.direction)) {
        log.info(
          { slug: row.slug, market: market.venueMarketId, pending: pending.side, signal: signal?.direction },
          "pending flip cancelled",
        );
        await clearPendingFlip(row.id, market.id);
        pending = null;
      }
      if (!signal) {
        if (pending) {
          log.info(
            { slug: row.slug, market: market.venueMarketId, pending: pending.side },
            "pending flip waits for evaluate (no pending_flip ENTER)",
          );
        }
        skips.noSignal += 1;
        continue;
      }
      const actingSignal = signal;
      const primaryTokenId = tick.tokenId;
      if (!primaryTokenId) continue;

      // Independent: Up and Down are separate legs; only EXIT closes.
      // Flip: opposite signal EXITs the held leg first. The other side opens
      // on a later cycle if evaluate still wants it (Paper delayed-fill).
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

      // Flip: do not BUY Down while Up is still OPEN on Binance.
      // A leftover SUBMITTED EXIT must not block ENTER once ONGOING shares are 0.
      if (trade.paperAction === "ENTER" && oppositeCloses) {
        const inflightOnMarket = await prisma.order.findMany({
          where: {
            mode: TradingMode.LIVE,
            marketId: market.id,
            status: { in: LIVE_INFLIGHT_STATUSES },
            signal: { strategyId: row.id },
          },
          select: { id: true, rawPayload: true },
        });
        const inflightEnterOnMarket = inflightOnMarket.some((item) => {
          const raw =
            item.rawPayload && typeof item.rawPayload === "object" && !Array.isArray(item.rawPayload)
              ? (item.rawPayload as Record<string, unknown>)
              : {};
          return raw.action == null || raw.action === "ENTER";
        });
        if (
          shouldBlockLiveFlipEnter({
            mode: binaryMode,
            action: trade.paperAction,
            stillOpen: Boolean(openUp || openDown),
            inflightOnMarket: inflightEnterOnMarket,
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
            select: { id: true, rawPayload: true, shares: true, avgPrice: true },
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
          shouldSkipPeerEnter(
            "single",
            "ENTER",
            Boolean(
              (peerOpen && !isLiveDustPosition({ rawPayload: peerOpen.rawPayload, shares: peerOpen.shares, avgPrice: peerOpen.avgPrice })) ||
                peerInflight ||
                peerPending,
            ),
          )
        ) {
          skips.peer += 1;
          continue;
        }
      }

      let flipWanted: PendingFlipSide | null = null;
      if (
        oppositeCloses &&
        action === "EXIT" &&
        signal &&
        (signal.direction === "BUY" || signal.direction === "SELL")
      ) {
        flipWanted = pendingFlipFromSignal(signal.direction);
        if (flipWanted) {
          await writePendingFlip({
            strategyId: row.id,
            marketId: market.id,
            side: flipWanted,
            fromTokenId: open?.tokenId,
            endDate: market.topic.endDate,
            now,
          });
        }
      }
      const recoverSide = flipWanted ?? pending?.side ?? null;

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
      const exitIntent =
        action === "EXIT" ? exitIntentFromOutcome(open?.outcome?.name ?? null) : undefined;
      if (action === "EXIT" && open) {
        try {
          const venueShares = await readVenueTradableShares(
            venue,
            ctx.walletAddress,
            tokenId,
            flipWanted ? { urgent: true } : undefined,
          );
          if (venueShares != null) exitShares = venueShares;
        } catch (error) {
          // Real-money safety: never fall back to a stale local share count
          // when Binance inventory cannot be verified.
          log.error({ err: String(error), tokenId }, "live EXIT blocked: Binance shares unavailable");
          continue;
        }
        if (!(exitShares > 1e-8)) {
          if (
            shouldRecoverFlipEnter({
              wantedSide: recoverSide,
              managementExit: false,
              venueShares: exitShares,
            }) &&
            recoverSide
          ) {
            await writePendingFlip({
              strategyId: row.id,
              marketId: market.id,
              side: recoverSide,
              fromTokenId: open.tokenId,
              endDate: market.topic.endDate,
              now,
            });
            await markLivePositionVenueFlat(open);
            log.info(
              { slug: row.slug, market: market.venueMarketId, wanted: recoverSide },
              "live flip EXIT already flat; ENTER waits for next evaluate",
            );
          } else {
            log.info(
              { slug: row.slug, market: market.venueMarketId },
              "live EXIT skipped: Binance ONGOING shares are 0",
            );
          }
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
          urgent: Boolean(flipWanted),
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
        // LIVE entries use the Prediction wallet (fundingSource=MPC).
        // Do not gate the order using Spot/Funding CEX balances; Binance validates
        // the actual Prediction-wallet balance when the quote/order is executed.
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
          proposedFillPrice:
            action === "ENTER" ? (quote?.averagePrice ?? priced.bestAsk) : priced.bestBid,
          ignoreMinTimeToExpiry: action === "ENTER" && Boolean(pending),
        },
        riskState,
        limits,
      );
      if (!pre.allowed) {
        skips.risk += 1;
        if (
          action === "ENTER" &&
          pending &&
          shouldClearPendingFlipOnBlockedEnter(
            pre.checks.filter((check) => !check.passed).map((check) => check.name),
          )
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
        orderType: "MARKET",
        exitIntent,
        idempotencyWindowMs: env.LIVE_IDEMPOTENCY_MS,
        idempotencySalt: action === "EXIT" ? `flat-${exitShares.toFixed(6)}` : undefined,
        ignoreMinTimeToExpiry: action === "ENTER" && Boolean(pending),
        urgentRest: Boolean(flipWanted) || (action === "ENTER" && Boolean(pending)),
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
          closed += 1;
          riskState = {
            ...riskState,
            openPositions: await reservedLiveSlots(),
          };
          if (
            shouldConfirmFlipExit({
              oppositeCloses,
              exitPlaced: true,
              managementExit: false,
              wantedSide: recoverSide,
            }) &&
            recoverSide
          ) {
            await writePendingFlip({
              strategyId: row.id,
              marketId: market.id,
              side: recoverSide,
              fromTokenId: open?.tokenId,
              endDate: market.topic.endDate,
              now,
            });
            if (!result.venueOrderId) {
              log.info(
                { slug: row.slug, market: market.venueMarketId },
                "live flip EXIT placed; ENTER waits for next evaluate",
              );
            } else {
              const confirm = await confirmLiveFlipExit({
                venue,
                walletAddress: ctx.walletAddress,
                venueOrderId: result.venueOrderId,
                tokenId,
              });
              log.info(
                {
                  slug: row.slug,
                  market: market.venueMarketId,
                  ...confirm,
                  venueOrderId: result.venueOrderId,
                },
                "live flip exit confirm",
              );
              if (confirm.failed) {
                await clearPendingFlip(row.id, market.id);
              } else if (confirm.ready) {
                if (open) {
                  try {
                    await markLivePositionVenueFlat(open);
                  } catch (error) {
                    log.warn({ err: String(error), positionId: open.id }, "live flip venue-flat stamp skipped");
                  }
                }
                if (confirm.order) {
                  try {
                    await applyOfficialLiveOrder(confirm.order);
                  } catch (error) {
                    log.warn({ err: String(error), venueOrderId: result.venueOrderId }, "live flip fill apply skipped");
                  }
                }
                log.info(
                  { slug: row.slug, market: market.venueMarketId, wanted: recoverSide },
                  "live flip EXIT filled; ENTER waits for next evaluate",
                );
              }
            }
          }
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
    const flattenRetries = await retryLiveFlattening(ctx, venue);
    if (flattenRetries > 0) {
      log.info({ flattenRetries }, "live flatten retries");
      closed += flattenRetries;
    }
  } catch (error) {
    log.warn({ err: String(error) }, "live flatten retries skipped");
  }
  await applyLiveCloseFollowup(venue, ctx, closed);

  const open = await countOpenLivePositions();
  const slotUsage = await liveSlotUsage();
  log.info(
    {
      enabled: enabled.length,
      considered,
      submitted,
      open,
      reservedSlots: slotUsage.reserved,
      binaryMode,
      fundingSource: "MPC",
      ...skips,
    },
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
