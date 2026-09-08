import { OrderSide, OrderStatus, OrderType, TradingMode } from "@prisma/client";
import type { FillOk } from "@/lib/backtest/fills";
import { lastAtOrBefore } from "@/lib/backtest/features";
import type { UnderlyingTick } from "@/lib/backtest/types";
import { PositionStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { isExpiredAt, settlementPayoff } from "@/lib/markets/settlement";
import { paperExitPnl, paperOrderSide } from "@/lib/paper/action";
import { paperSettleAt, paperSettlementReady } from "@/lib/paper/delays";
import type { PaperBook, PaperTradeRequest, PaperTradeResult } from "@/lib/paper/engine";
import { persistPaperTrade } from "@/lib/paper/persist";
import { paperIdempotencyKey, clientOrderIdFromKey } from "@/lib/paper/idempotency";
import { asNumber } from "@/lib/normalize/numbers";
import { clearPendingFlip } from "@/lib/live/pending-flip";
import { recordClosedTrade } from "@/lib/risk/state";
import { persistRiskSnapshot } from "@/lib/risk/persist";
import type { RiskLimits, RiskSnapshot } from "@/lib/risk/types";
import type { StrategySignal } from "@/lib/types/domain";

const log = childLogger({ component: "expiry-flatten" });

export function expiryExitPrice(options: {
  startPrice: number | null;
  outcomeName: string | null;
  underlyingPrice: number | null;
  side: "BUY" | "SELL";
  bestBid: number | null;
  bestAsk: number | null;
  chance: number | null;
  avgPrice: number;
}): number {
  const payoff = settlementPayoff(
    { startPrice: options.startPrice, outcomeName: options.outcomeName },
    options.underlyingPrice,
  );
  if (payoff !== null) return payoff;
  if (options.side === "BUY" && options.bestBid !== null && options.bestBid >= 0) {
    return options.bestBid;
  }
  if (options.side === "SELL" && options.bestAsk !== null && options.bestAsk >= 0) {
    return options.bestAsk;
  }
  if (options.chance !== null && options.chance >= 0) return options.chance;
  return options.avgPrice;
}

export function settlementFill(shares: number, price: number): FillOk {
  const qty = Math.max(0, shares);
  return {
    ok: true,
    price,
    shares: qty,
    notional: qty * price,
    fee: 0,
    slippage: 0,
    priceImpact: 0,
    networkCost: 0,
    partial: false,
  };
}

function expirySignal(options: {
  strategyId: string;
  marketId: string;
  now: Date;
  chance: number | null;
}): StrategySignal {
  const probability = options.chance ?? 0.5;
  return {
    strategyId: options.strategyId,
    marketId: options.marketId,
    timestamp: options.now,
    direction: "EXIT",
    marketProbability: probability,
    fairProbability: probability,
    grossEdge: 0,
    estimatedFees: 0,
    estimatedSlippage: 0,
    estimatedPriceImpact: 0,
    netEdge: 0,
    confidence: 1,
    reason: "expired",
    riskChecks: [],
  };
}

export function expiryExitResult(options: {
  mode: TradingMode;
  strategyId: string;
  marketId: string;
  tokenId: string;
  positionSide: OrderSide;
  now: Date;
  fill: FillOk;
}): PaperTradeResult {
  const side = paperOrderSide("EXIT", "EXIT", options.positionSide);
  const key = paperIdempotencyKey({
    mode: options.mode,
    strategyId: options.strategyId,
    marketId: options.marketId,
    tokenId: options.tokenId,
    side,
    action: "EXIT",
    bucketMs: options.now.getTime(),
  });
  return {
    duplicate: false,
    clientOrderId: clientOrderIdFromKey(key),
    idempotencyKey: key,
    status: OrderStatus.FILLED,
    side,
    reason: "expired",
    fill: options.fill,
    riskAllowed: true,
    orderType: OrderType.MARKET,
    riskDecision: null,
  };
}

export async function flattenExpiredPositions(options: {
  mode: TradingMode;
  now: Date;
  riskState: RiskSnapshot;
  limits: RiskLimits;
  underlyingsBySymbol: Map<string, UnderlyingTick[]>;
}): Promise<{ filled: number; riskState: RiskSnapshot }> {
  const open = await prisma.position.findMany({
    where: { mode: options.mode, status: "OPEN" },
    include: {
      strategy: true,
      market: {
        include: {
          topic: true,
          outcomes: true,
          snapshots: { orderBy: { observedAt: "desc" }, take: 1 },
        },
      },
    },
  });

  let filled = 0;
  let riskState = options.riskState;

  for (const row of open) {
    const endDate = row.market.topic.endDate;
    if (!isExpiredAt(options.now, endDate)) continue;

    const snap = row.market.snapshots[0];
    const outcome =
      row.market.outcomes.find((item) => item.tokenId === row.tokenId) ??
      row.market.outcomes[0] ??
      null;
    const symbol = row.market.topic.symbol;
    const underlying = symbol
      ? lastAtOrBefore(options.underlyingsBySymbol.get(symbol) ?? [], endDate ?? options.now)
      : null;
    const shares = asNumber(row.shares) ?? 0;
    const avgPrice = asNumber(row.avgPrice) ?? 0;

    // LIVE: Binance settles the contract. Never invent a FILLED expired SELL.
    if (options.mode === TradingMode.LIVE) {
      log.info(
        { market: row.market.venueMarketId, shares },
        "live expiry: defer close to venue-sync (no synthetic fill)",
      );
      continue;
    }

    const closedAt = endDate ?? options.now;
    const extra: Record<string, unknown> =
      row.rawPayload && typeof row.rawPayload === "object" && !Array.isArray(row.rawPayload)
        ? { ...(row.rawPayload as Record<string, unknown>) }
        : {};
    try {
      await prisma.position.update({
        where: { id: row.id },
        data: {
          status: PositionStatus.CLOSED,
          closedAt,
          rawPayload: {
            ...extra,
            expired: true,
            settleAt: paperSettleAt(closedAt).toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      log.warn({ err: String(error), market: row.market.venueMarketId }, "paper expiry park skipped");
      continue;
    }
    riskState = {
      ...riskState,
      openPositions: Math.max(0, riskState.openPositions - 1),
      openNotional: Math.max(0, riskState.openNotional - shares * avgPrice),
    };
    await persistRiskSnapshot(riskState);
    if (row.strategyId) await clearPendingFlip(row.strategyId, row.marketId);
    log.info(
      { market: row.market.venueMarketId, strategy: row.strategy?.slug ?? "unknown" },
      "paper expired OPEN parked (settlement delayed)",
    );
  }

  return { filled, riskState };
}

async function applyDuePaperSettlements(options: {
  now: Date;
  riskState: RiskSnapshot;
  limits: RiskLimits;
  underlyingsBySymbol: Map<string, UnderlyingTick[]>;
}): Promise<{ filled: number; riskState: RiskSnapshot }> {
  const parked = await prisma.position.findMany({
    where: { mode: TradingMode.PAPER, status: PositionStatus.CLOSED },
    include: {
      strategy: true,
      market: {
        include: {
          topic: true,
          outcomes: true,
          snapshots: { orderBy: { observedAt: "desc" }, take: 1 },
        },
      },
    },
  });

  let filled = 0;
  let riskState = options.riskState;

  for (const row of parked) {
    if (!paperSettlementReady(row.rawPayload, options.now)) continue;

    const endDate = row.market.topic.endDate;
    const snap = row.market.snapshots[0];
    const outcome =
      row.market.outcomes.find((item) => item.tokenId === row.tokenId) ??
      row.market.outcomes[0] ??
      null;
    const symbol = row.market.topic.symbol;
    const underlying = symbol
      ? lastAtOrBefore(options.underlyingsBySymbol.get(symbol) ?? [], endDate ?? options.now)
      : null;
    const shares = asNumber(row.shares) ?? 0;
    const avgPrice = asNumber(row.avgPrice) ?? 0;

    const price = expiryExitPrice({
      startPrice: asNumber(row.market.topic.startPrice),
      outcomeName: outcome?.name ?? null,
      underlyingPrice: underlying?.price ?? null,
      side: row.side,
      bestBid: asNumber(snap?.bestBid),
      bestAsk: asNumber(snap?.bestAsk),
      chance: asNumber(snap?.chance) ?? asNumber(snap?.midPrice),
      avgPrice,
    });
    const fill = settlementFill(shares, price);
    const strategyId = row.strategy?.slug ?? "unknown";
    const signal = expirySignal({
      strategyId,
      marketId: row.marketId,
      now: options.now,
      chance: asNumber(snap?.chance),
    });
    const book: PaperBook = {
      bestBid: price,
      bestAsk: price,
      lastPrice: null,
      liquidity: null,
      bidDepth: null,
      askDepth: null,
      timeToExpirySec: 0,
      dataAgeMs: 0,
    };
    const request: PaperTradeRequest = {
      mode: TradingMode.PAPER,
      action: "EXIT",
      strategyId,
      marketId: row.marketId,
      outcomeId: row.outcomeId ?? undefined,
      tokenId: row.tokenId,
      signal,
      book,
      quote: null,
      now: endDate ?? options.now,
      requestedNotional: Math.max(fill.notional, shares),
      maxPriceImpact: options.limits.maxPriceImpact,
      positionSide: row.side,
      positionId: row.id,
    };
    const result = expiryExitResult({
      mode: TradingMode.PAPER,
      strategyId,
      marketId: row.marketId,
      tokenId: row.tokenId,
      positionSide: row.side,
      now: endDate ?? options.now,
      fill,
    });

    const saved = await persistPaperTrade({ request, result, signal });
    const closedRow = await prisma.position.findUnique({
      where: { id: row.id },
      select: { realizedPnl: true, rawPayload: true },
    });
    if (!saved && !paperSettlementApplied(closedRow?.rawPayload)) {
      log.warn(
        { market: row.market.venueMarketId, persist: saved != null },
        "paper delayed settlement did not apply",
      );
      continue;
    }
    const pnl =
      saved?.realizedPnl ??
      asNumber(closedRow?.realizedPnl) ??
      paperExitPnl({ side: row.side, avgPrice, shares }, fill);
    const closed = recordClosedTrade(riskState, pnl, options.now, options.limits);
    riskState = {
      ...closed.state,
      openPositions: riskState.openPositions,
      openNotional: riskState.openNotional,
    };
    await persistRiskSnapshot(riskState);
    filled += 1;
    log.info(
      {
        market: row.market.venueMarketId,
        strategy: strategyId,
        price,
        pnl,
      },
      "paper position settled after delay",
    );
  }

  return { filled, riskState };
}

function paperSettlementApplied(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const row = raw as Record<string, unknown>;
  return row.settled === true || row.closePrice != null;
}

export async function flattenExpiredPaperPositions(options: {
  now: Date;
  riskState: RiskSnapshot;
  limits: RiskLimits;
  underlyingsBySymbol: Map<string, UnderlyingTick[]>;
}): Promise<{ filled: number; riskState: RiskSnapshot }> {
  const parked = await flattenExpiredPositions({ ...options, mode: TradingMode.PAPER });
  return applyDuePaperSettlements({ ...options, riskState: parked.riskState });
}
