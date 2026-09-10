import { OrderStatus, SystemEventLevel, TradingMode } from "@prisma/client";
import { env, isLiveTradingEnabled } from "@/lib/config/env";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { asNumber } from "@/lib/normalize/numbers";
import { selectPrimarySnapshot, tickFromSnapshot } from "@/lib/normalize/tick";
import { buildStrategyContext } from "@/lib/backtest/context";
import type { UnderlyingTick } from "@/lib/backtest/types";
import { evaluateRisk } from "@/lib/risk/evaluate";
import { limitsFromEnv } from "@/lib/risk/limits";
import { loadRiskState, persistRiskDecision, persistRiskSnapshot } from "@/lib/risk/persist";
import { recordClosedTrade } from "@/lib/risk/state";
import type { RiskLimits, RiskSnapshot } from "@/lib/risk/types";
import type { StrategySignal } from "@/lib/types/domain";
import { createStrategy } from "@/lib/strategy";
import { readLiveOrderbook } from "@/lib/ingest/raw-store";
import { isShortCryptoUpDownRow, tradableMarketQuery } from "@/lib/markets/horizon";
import { isExpiredAt } from "@/lib/markets/settlement";
import { sleep } from "@/lib/binance/rate-limit";
import { inc } from "@/lib/observability/metrics";
import { recordSystemEvent } from "@/lib/observability/events";
import {
  executePaperTrade,
  fetchOfficialPaperQuote,
  hasPredictionWallet,
  DEFAULT_PAPER_ENTRY_MODE,
  shouldSkipPeerEnter,
  paperExitPnl,
  persistPaperTrade,
  skippedPaperTrade,
  writePaperCycle,
  PAPER_SKIP,
  type PaperBook,
  type PaperQuote,
  type PaperTradeRequest,
} from "@/lib/paper";
import { paperFillReady } from "@/lib/paper/delays";
import { flattenExpiredPaperPositions } from "@/lib/paper/expiry";
import { invertBinaryBook, resolveBinaryWorkerTrade } from "@/lib/live/binary";
import { liveOppositeCloses } from "@/lib/live/binary-mode";
import { outcomeIsDownToken } from "@/lib/normalize/markets";
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
import { assertPaperWorkerNotLive } from "@/lib/live/gate";

const log = childLogger({ component: "paper-worker" });

const oppositeCloses = liveOppositeCloses("flip");

function orderPayloadAction(raw: unknown): "ENTER" | "EXIT" | null {
  if (!raw || typeof raw !== "object" || !("action" in raw)) return null;
  const action = (raw as { action?: unknown }).action;
  return action === "ENTER" || action === "EXIT" ? action : null;
}

function orderPayloadPositionId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || !("positionId" in raw)) return null;
  const id = (raw as { positionId?: unknown }).positionId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function pruneExpiredPaperPendings(now: Date): Promise<void> {
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

async function paperSlotUsage(): Promise<{ reserved: number; openAndInflight: number }> {
  const [open, inflight, pendings] = await Promise.all([
    prisma.position.findMany({
      where: { mode: TradingMode.PAPER, status: "OPEN" },
      select: { tokenId: true, marketId: true, strategyId: true },
    }),
    prisma.order.findMany({
      where: { mode: TradingMode.PAPER, status: { in: LIVE_INFLIGHT_STATUSES } },
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

async function reservedPaperSlots(): Promise<number> {
  return (await paperSlotUsage()).reserved;
}

async function fillSubmittedPaperOrders(options: {
  now: Date;
  riskState: RiskSnapshot;
  limits: RiskLimits;
}): Promise<{ filled: number; riskState: RiskSnapshot }> {
  const submitted = await prisma.order.findMany({
    where: {
      mode: TradingMode.PAPER,
      status: {
        in: [
          OrderStatus.SUBMITTED,
          OrderStatus.PENDING,
          OrderStatus.PARTIALLY_FILLED,
        ],
      },
    },
    include: {
      signal: { include: { strategy: true } },
      market: {
        include: {
          topic: true,
          outcomes: true,
          snapshots: { orderBy: { observedAt: "desc" }, take: 1 },
        },
      },
      position: true,
    },
  });

  let filled = 0;
  let riskState = options.riskState;

  for (const order of submitted) {
    if (!paperFillReady(order.submittedAt, options.now)) continue;
    const action = orderPayloadAction(order.rawPayload);
    if (!action) continue;
    const snap = order.market.snapshots[0];
    const outcome =
      order.market.outcomes.find((item) => item.tokenId === order.tokenId) ??
      order.market.outcomes[0] ??
      null;
    let bestBid = asNumber(snap?.bestBid);
    let bestAsk = asNumber(snap?.bestAsk);
    let lastPrice = asNumber(snap?.lastPrice) ?? asNumber(snap?.chance);
    const live = await readLiveOrderbook(order.market.venueMarketId);
    if (live) {
      bestBid = asNumber(live.bestBid) ?? bestBid;
      bestAsk = asNumber(live.bestAsk) ?? bestAsk;
    }
    if (outcomeIsDownToken(outcome?.name ?? null)) {
      const inverted = invertBinaryBook({ bestBid, bestAsk, lastPrice });
      bestBid = inverted.bestBid;
      bestAsk = inverted.bestAsk;
      lastPrice = inverted.lastPrice;
    }
    const book: PaperBook = {
      bestBid,
      bestAsk,
      lastPrice,
      liquidity: asNumber(snap?.liquidity),
      bidDepth: asNumber(snap?.bidDepth),
      askDepth: asNumber(snap?.askDepth),
      timeToExpirySec: order.market.topic.endDate
        ? Math.max(0, (order.market.topic.endDate.getTime() - options.now.getTime()) / 1000)
        : null,
      dataAgeMs: snap ? options.now.getTime() - snap.observedAt.getTime() : null,
    };
    const positionId = order.positionId ?? orderPayloadPositionId(order.rawPayload);
    const position =
      order.position ??
      (positionId
        ? await prisma.position.findUnique({ where: { id: positionId } })
        : action === "EXIT"
          ? await prisma.position.findFirst({
              where: {
                mode: TradingMode.PAPER,
                status: "OPEN",
                marketId: order.marketId,
                tokenId: order.tokenId,
              },
            })
          : null);
    // For an EXIT, PAPER mirrors LIVE flattening: the order represents the
    // whole position, but each fill only acts on the shares still remaining.
    const remainingExitShares =
      action === "EXIT" && position ? Math.max(0, Number(position.shares)) : null;
    const exitQuotePrice =
      remainingExitShares != null
        ? bestBid ?? lastPrice ?? (position ? Number(position.avgPrice) : null)
        : null;
    const remainingExitNotional =
      remainingExitShares != null && exitQuotePrice != null && exitQuotePrice > 0
        ? remainingExitShares * exitQuotePrice
        : null;

    const quote: PaperQuote | null = await fetchOfficialPaperQuote({
      tokenId: order.tokenId,
      side: order.side,
      amountUsdt:
        action === "EXIT" && remainingExitNotional != null
          ? remainingExitNotional
          : asNumber(order.requestedAmount) ?? 0,
      amountShares: remainingExitShares ?? undefined,
      slippageBps: options.limits.maxSlippageBps,
    });
    const signal: StrategySignal = order.signal
      ? {
          strategyId: order.signal.strategy?.slug ?? order.signal.strategyId,
          marketId: order.signal.marketId,
          timestamp: order.signal.timestamp,
          direction: order.signal.direction,
          marketProbability: Number(order.signal.marketProbability),
          fairProbability: Number(order.signal.fairProbability),
          grossEdge: Number(order.signal.grossEdge),
          estimatedFees: Number(order.signal.estimatedFees),
          estimatedSlippage: Number(order.signal.estimatedSlippage),
          estimatedPriceImpact: Number(order.signal.estimatedPriceImpact),
          netEdge: Number(order.signal.netEdge),
          confidence: Number(order.signal.confidence),
          reason: order.signal.reason,
          riskChecks: [],
        }
      : {
          strategyId: "paper",
          marketId: order.marketId,
          timestamp: options.now,
          direction: action === "EXIT" ? "EXIT" : "BUY",
          marketProbability: lastPrice ?? 0.5,
          fairProbability: lastPrice ?? 0.5,
          grossEdge: 0,
          estimatedFees: 0,
          estimatedSlippage: 0,
          estimatedPriceImpact: 0,
          netEdge: 0,
          confidence: 1,
          reason: "paper_fill",
          riskChecks: [],
        };
    const request: PaperTradeRequest = {
      mode: TradingMode.PAPER,
      action,
      strategyId: signal.strategyId,
      marketId: order.marketId,
      outcomeId: order.outcomeId ?? undefined,
      tokenId: order.tokenId,
      signal,
      book,
      quote,
      now: options.now,
      // ENTER keeps the original bankroll ticket. EXIT is resized to the
      // actual remaining shares so a partial fill never tries to sell shares
      // that were already closed. The DB order keeps requestedAmount as the
      // original total for cumulative fillPercentage/accounting.
      requestedNotional:
        action === "EXIT" && remainingExitNotional != null
          ? remainingExitNotional
          : asNumber(order.requestedAmount) ?? 0,
      maxPriceImpact: options.limits.maxPriceImpact,
      positionSide: position?.side,
      positionId: position?.id ?? positionId ?? undefined,
      orderSide: order.side,
      idempotencyWindowMs: env.PAPER_IDEMPOTENCY_MS,
    };
    const result = executePaperTrade(request, riskState, options.limits, {
      stage: "fill",
      idempotencyKey: order.idempotencyKey,
    });
    const saved = await persistPaperTrade({ request, result, signal });
    if (result.fill && (result.status === "FILLED" || result.status === "PARTIALLY_FILLED")) {
      filled += 1;
      // Recompute reservations from the database. A partial fill is one
      // position, not a new position on every retry.
      riskState = {
        ...riskState,
        openPositions: await reservedPaperSlots(),
      };
      if (action === "EXIT" && saved?.realizedPnl != null && result.status === "FILLED") {
        const closed = recordClosedTrade(
          riskState,
          saved.realizedPnl,
          options.now,
          options.limits,
        );
        riskState = {
          ...closed.state,
          openPositions: await reservedPaperSlots(),
        };
        await persistRiskSnapshot(riskState);
      }
      if (action === "ENTER") {
        await clearPendingFlip(order.signal?.strategyId ?? "", order.marketId);
      }
    }
    log.info(
      {
        orderId: order.id,
        action,
        status: result.status,
        reason: result.reason,
      },
      "paper delayed fill",
    );
  }

  return { filled, riskState };
}

export { tickFromSnapshot };

export async function runPaperOnce(): Promise<{
  enabled: number;
  considered: number;
  filled: number;
  skip: string | null;
}> {
  log.info(
    {
      liveTradingEnabled: isLiveTradingEnabled(),
      hasWallet: hasPredictionWallet(),
    },
    "paper cycle: PAPER fills only, never placeOrder",
  );

  const enabled = await prisma.strategy.findMany({ where: { enabled: true } });
  if (enabled.length === 0) {
    log.info("no enabled strategies; paper trader is idle (seed defaults are disabled)");
    const cycle = {
      at: new Date().toISOString(),
      enabled: 0,
      considered: 0,
      filled: 0,
      skip: PAPER_SKIP.noEnabledStrategies,
    };
    await writePaperCycle(cycle);
    return cycle;
  }

  if (!hasPredictionWallet()) {
    log.info("BINANCE_PREDICTION_WALLET_ADDRESS empty; getQuote skipped, no fills");
  }

  const markets = await prisma.market.findMany({
    ...tradableMarketQuery(),
    include: {
      topic: true,
      outcomes: true,
      snapshots: { orderBy: { observedAt: "desc" }, take: 60 },
    },
  });

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

  const limits = limitsFromEnv();
  let riskState = await loadRiskState();
  const now = new Date();
  await pruneExpiredPaperPendings(now);
  const settled = await flattenExpiredPaperPositions({
    now,
    riskState,
    limits,
    underlyingsBySymbol,
  });
  riskState = settled.riskState;
  const submittedFilled = await fillSubmittedPaperOrders({
    now,
    riskState,
    limits,
  });
  riskState = submittedFilled.riskState;
  riskState = {
    ...riskState,
    openPositions: await reservedPaperSlots(),
  };
  const entryMode = DEFAULT_PAPER_ENTRY_MODE;
  let considered = 0;
  let filled = settled.filled + submittedFilled.filled;

  for (const market of markets) {
    const picked = selectPrimarySnapshot(market.snapshots, market.outcomes);
    if (!picked) continue;
    const { snapshot: latest, outcome } = picked;
    if (market.topic.endDate && now.getTime() >= market.topic.endDate.getTime()) {
      for (const row of enabled) {
        await clearPendingFlip(row.id, market.id);
      }
      continue;
    }
    if (!isShortCryptoUpDownRow(market)) continue;
    considered += 1;

    let tick = tickFromSnapshot({ ...latest, market, outcome });
    const live = await readLiveOrderbook(market.venueMarketId);
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

    const probability = market.snapshots
      .slice()
      .reverse()
      .flatMap((row) => {
        const value = asNumber(row.chance) ?? asNumber(row.midPrice);
        return value === null ? [] : [{ observedAt: row.observedAt, value }];
      });

    const ctx = buildStrategyContext({
      now,
      tick,
      underlyings: tick.symbol ? (underlyingsBySymbol.get(tick.symbol) ?? []) : [],
      probability,
      quotes: [],
      rollingWindow: 60,
    });

    for (const row of enabled) {
      const params = (row.parameters ?? {}) as Record<string, unknown>;
      const strategy = createStrategy(row.slug, params);
      if (!strategy) continue;
      const signal = strategy.evaluate(ctx);
      let pending = oppositeCloses ? await readPendingFlip(row.id, market.id) : null;
      if (pending && shouldCancelPendingFlip(pending.side, signal?.direction)) {
        await clearPendingFlip(row.id, market.id);
        pending = null;
      }
      const tteSec = ctx.timeToExpirySec;
      const tooCloseToExpiry =
        isExpiredAt(now, market.topic.endDate) ||
        (tteSec != null && tteSec < limits.minTimeToExpirySec);
      if (pending && tooCloseToExpiry) {
        await clearPendingFlip(row.id, market.id);
        pending = null;
      }
      if (!signal && !pending) continue;

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

      const opens = await prisma.position.findMany({
        where: {
          mode: TradingMode.PAPER,
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
      if (!trade) continue;

      const open =
        trade.tokenId === openDown?.tokenId
          ? openDown
          : trade.tokenId === openUp?.tokenId
            ? openUp
            : null;

      const inflight = await prisma.order.findFirst({
        where: {
          mode: TradingMode.PAPER,
          marketId: market.id,
          tokenId: trade.tokenId,
          status: { in: LIVE_INFLIGHT_STATUSES },
          signal: { strategyId: row.id },
        },
        select: { id: true },
      });
      if (inflight) continue;

      if (trade.paperAction === "ENTER" && oppositeCloses) {
        const inflightOnMarket = await prisma.order.findFirst({
          where: {
            mode: TradingMode.PAPER,
            marketId: market.id,
            status: { in: LIVE_INFLIGHT_STATUSES },
            signal: { strategyId: row.id },
          },
          select: { id: true },
        });
        if (openUp || openDown || inflightOnMarket) continue;
      }

      const action = trade.paperAction;
      const tokenId = trade.tokenId;
      if (action === "EXIT" && !open) continue;

      if (action === "ENTER") {
        const [peerOpen, peerInflight, peerPending] = await Promise.all([
          prisma.position.findFirst({
            where: {
              mode: TradingMode.PAPER,
              status: "OPEN",
              marketId: market.id,
              NOT: { strategyId: row.id },
            },
            select: { id: true, strategyId: true },
          }),
          prisma.order.findFirst({
            where: {
              mode: TradingMode.PAPER,
              marketId: market.id,
              status: { in: LIVE_INFLIGHT_STATUSES },
              signal: { strategyId: { not: row.id } },
            },
            select: { id: true },
          }),
          hasPeerPendingFlip(market.id, row.id),
        ]);
        if (
          shouldSkipPeerEnter(entryMode, action, Boolean(peerOpen || peerInflight || peerPending))
        ) {
          log.info(
            {
              slug: row.slug,
              market: market.venueMarketId,
              peerStrategyId: peerOpen?.strategyId,
              entryMode,
            },
            "paper skip duplicate enter: same market already open",
          );
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

      const priced = trade.invertBook
        ? invertBinaryBook({
            bestBid: tick.bestBid,
            bestAsk: tick.bestAsk,
            lastPrice: tick.lastPrice,
          })
        : {
            bestBid: tick.bestBid,
            bestAsk: tick.bestAsk,
            lastPrice: tick.lastPrice,
          };

      const executable = action === "EXIT" ? priced.bestBid : priced.bestAsk;
      const notional =
        action === "EXIT" && open
          ? Number(open.shares) * (executable ?? Number(open.avgPrice))
          : limits.bankrollUsdt * (limits.maxPositionPct / 100);

      const book: PaperBook = {
        bestBid: priced.bestBid,
        bestAsk: priced.bestAsk,
        lastPrice: priced.lastPrice,
        liquidity: tick.liquidity,
        bidDepth: tick.bidDepth,
        askDepth: tick.askDepth,
        timeToExpirySec: ctx.timeToExpirySec,
        dataAgeMs,
      };

      const usage = await paperSlotUsage();
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
          mode: TradingMode.PAPER,
          now,
          strategyId: row.slug,
          marketId: market.id,
          requestedNotional: notional,
          bestBid: priced.bestBid,
          bestAsk: priced.bestAsk,
          lastPrice: priced.lastPrice,
          liquidity: tick.liquidity,
          timeToExpirySec: ctx.timeToExpirySec,
          estimatedSlippageBps: null,
          estimatedPriceImpact: null,
          quoteExpireAt: null,
          dataAgeMs,
        },
        riskState,
        limits,
      );
      if (!pre.allowed) {
        await persistRiskDecision(pre, { marketId: market.id, strategyId: row.id });
        riskState = pre.nextState;
        const reason = pre.checks.find((c) => !c.passed)?.name ?? "risk_rejected";
        const request: PaperTradeRequest = {
          mode: TradingMode.PAPER,
          action,
          strategyId: row.slug,
          marketId: market.id,
          outcomeId: trade.outcomeId,
          tokenId,
          signal: actingSignal,
          book,
          quote: null,
          now,
          requestedNotional: notional,
          maxPriceImpact: limits.maxPriceImpact,
          positionSide: open?.side,
          orderSide: trade.orderSide,
          idempotencyWindowMs: env.PAPER_IDEMPOTENCY_MS,
        };
        await persistPaperTrade({
          request,
          result: skippedPaperTrade(request, reason),
          signal: actingSignal,
        });
        log.info(
          { slug: row.slug, market: market.venueMarketId, reason },
          "paper skipped before getQuote",
        );
        continue;
      }

      const quote: PaperQuote | null = await fetchOfficialPaperQuote({
        tokenId,
        side: trade.orderSide,
        amountUsdt: notional,
        amountShares: action === "EXIT" && open ? Number(open.shares) : undefined,
        slippageBps: limits.maxSlippageBps,
      });

      const request: PaperTradeRequest = {
        mode: TradingMode.PAPER,
        action,
        strategyId: row.slug,
        marketId: market.id,
        outcomeId: trade.outcomeId,
        tokenId,
        signal: actingSignal,
        book,
        quote,
        now,
        requestedNotional: notional,
        maxPriceImpact: limits.maxPriceImpact,
        positionSide: open?.side,
        positionId: open?.id,
        orderSide: trade.orderSide,
        idempotencyWindowMs: env.PAPER_IDEMPOTENCY_MS,
      };

      const result = executePaperTrade(request, riskState, limits, { stage: "submit" });
      if (result.riskDecision) {
        await persistRiskDecision(result.riskDecision, {
          marketId: market.id,
          strategyId: row.id,
        });
        riskState = result.riskDecision.nextState;
      }

      await persistPaperTrade({ request, result, signal: actingSignal });
      if (result.status === "SUBMITTED") {
        filled += 1;
        riskState = {
          ...riskState,
          openPositions: await reservedPaperSlots(),
        };
      }

      log.info(
        {
          slug: row.slug,
          market: market.venueMarketId,
          action,
          binary: trade.binary,
          status: result.status,
          reason: result.reason,
          duplicate: result.duplicate,
        },
        "paper decision",
      );
    }
  }

  const skip =
    considered === 0
      ? markets.length === 0
        ? PAPER_SKIP.noNearExpiry
        : PAPER_SKIP.noPredictionBook
      : filled === 0
        ? PAPER_SKIP.noEntryYet
        : null;
  const cycle = {
    at: new Date().toISOString(),
    enabled: enabled.length,
    considered,
    filled,
    skip,
  };
  await writePaperCycle(cycle);
  log.info(cycle, "paper cycle complete");
  return cycle;
}

export async function startPaperTrader(): Promise<void> {
  assertPaperWorkerNotLive();
  log.info(
    { intervalMs: env.PAPER_LOOP_INTERVAL_MS },
    "starting paper trader (never calls Binance placeOrder)",
  );
  do {
    try {
      await runPaperOnce();
    } catch (error) {
      inc("paper.cycle_error");
      log.error({ err: String(error) }, "paper cycle failed");
      await recordSystemEvent({
        level: SystemEventLevel.ERROR,
        component: "paper-worker",
        message: String(error),
      });
    }
    if (env.COLLECTOR_ONCE) return;
    await sleep(env.PAPER_LOOP_INTERVAL_MS);
  } while (true);
}
