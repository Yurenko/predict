import { OrderSide, OrderStatus, OrderType, TradingMode } from "@prisma/client";
import type { FillOk } from "@/lib/backtest/fills";
import { lastAtOrBefore } from "@/lib/backtest/features";
import type { UnderlyingTick } from "@/lib/backtest/types";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { isExpiredAt, settlementPayoff } from "@/lib/markets/settlement";
import { paperExitPnl, paperOrderSide } from "@/lib/paper/action";
import type { PaperBook, PaperTradeRequest, PaperTradeResult } from "@/lib/paper/engine";
import { persistPaperTrade } from "@/lib/paper/persist";
import { paperIdempotencyKey, clientOrderIdFromKey } from "@/lib/paper/idempotency";
import { asNumber } from "@/lib/normalize/numbers";
import { recordClosedTrade } from "@/lib/risk/state";
import { persistRiskSnapshot } from "@/lib/risk/persist";
import type { RiskLimits, RiskSnapshot } from "@/lib/risk/types";
import type { StrategySignal } from "@/lib/types/domain";

const log = childLogger({ component: "paper-expiry" });

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

export async function flattenExpiredPaperPositions(options: {
  now: Date;
  riskState: RiskSnapshot;
  limits: RiskLimits;
  underlyingsBySymbol: Map<string, UnderlyingTick[]>;
}): Promise<{ filled: number; riskState: RiskSnapshot }> {
  const open = await prisma.position.findMany({
    where: { mode: TradingMode.PAPER, status: "OPEN" },
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
    const pnl =
      saved?.realizedPnl ??
      paperExitPnl({ side: row.side, avgPrice, shares }, fill);
    const closed = recordClosedTrade(riskState, pnl, options.now, options.limits);
    riskState = {
      ...closed.state,
      openPositions: Math.max(0, riskState.openPositions - 1),
      openNotional: Math.max(0, riskState.openNotional - shares * avgPrice),
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
      "paper position settled at expiry",
    );
  }

  return { filled, riskState };
}
