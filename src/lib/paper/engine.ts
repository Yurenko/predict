import {
  OrderSide,
  OrderStatus,
  OrderType,
  TradingMode,
} from "@prisma/client";
import type { StrategySignal } from "@/lib/types/domain";
import { simulateFill, type FillOk } from "@/lib/backtest/fills";
import type { HistoricalQuote } from "@/lib/backtest/types";
import { evaluateRisk } from "@/lib/risk/evaluate";
import type { RiskDecision, RiskLimits, RiskSnapshot } from "@/lib/risk/types";
import { paperOrderSide } from "@/lib/paper/action";
import { clientOrderIdFromKey, paperIdempotencyKey, timeBucket } from "@/lib/paper/idempotency";
import { assertPaperExecution } from "@/lib/paper/live-gate";
import { transitionOrder } from "@/lib/paper/state-machine";
import { validateQuoteForFill, demoQuoteFromBook, type PaperQuote } from "@/lib/paper/quote-validate";
import { inc } from "@/lib/observability/metrics";

export interface PaperBook {
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  liquidity: number | null;
  bidDepth: number | null;
  askDepth: number | null;
  timeToExpirySec: number | null;
  dataAgeMs: number | null;
}

export interface PaperTradeRequest {
  mode: TradingMode;
  action: "ENTER" | "EXIT";
  strategyId: string;
  marketId: string;
  outcomeId?: string;
  tokenId: string;
  signal: StrategySignal;
  book: PaperBook;
  quote: PaperQuote | null;
  now: Date;
  requestedNotional: number;
  maxPriceImpact: number;
  /** Required for EXIT so we sell a long / buy back a short. */
  positionSide?: OrderSide;
  /** When set, EXIT closes this row instead of the first matching open. */
  positionId?: string;
  idempotencyWindowMs?: number;
}

export interface PaperTradeResult {
  duplicate: boolean;
  clientOrderId: string;
  idempotencyKey: string;
  status: OrderStatus;
  side: OrderSide;
  reason: string;
  fill: FillOk | null;
  riskAllowed: boolean;
  orderType: OrderType;
  riskDecision: RiskDecision | null;
  venueOrderId?: string | null;
}

const seen = new Map<string, PaperTradeResult>();

export function resetPaperIdempotencyCache(): void {
  seen.clear();
}

function toHistoricalQuote(quote: PaperQuote): HistoricalQuote {
  return {
    tokenId: quote.tokenId,
    quotedAt: quote.expireAt ?? new Date(0),
    averagePrice: quote.averagePrice,
    lastPrice: quote.lastPrice,
    chance: quote.chance,
    feeAmount: quote.feeAmount,
    feeRateBps: quote.feeRateBps,
    slippageBps: quote.slippageBps,
    priceImpact: quote.priceImpact,
    minReceive: quote.minReceive,
    expireAt: quote.expireAt,
  };
}

function fail(
  _request: PaperTradeRequest,
  key: string,
  status: OrderStatus,
  reason: string,
  side: OrderSide,
  riskAllowed: boolean,
  riskDecision: RiskDecision | null = null,
): PaperTradeResult {
  const result: PaperTradeResult = {
    duplicate: false,
    clientOrderId: clientOrderIdFromKey(key),
    idempotencyKey: key,
    status,
    side,
    reason,
    fill: null,
    riskAllowed,
    orderType: OrderType.MARKET,
    riskDecision,
  };
  inc("paper.order", { status, reason });
  seen.set(key, result);
  return result;
}

export function skippedPaperTrade(
  request: PaperTradeRequest,
  reason: string,
): PaperTradeResult {
  const side = paperOrderSide(request.action, request.signal.direction, request.positionSide);
  const key = paperIdempotencyKey({
    mode: request.mode,
    strategyId: request.strategyId,
    marketId: request.marketId,
    tokenId: request.tokenId,
    side,
    action: request.action,
    bucketMs: timeBucket(request.now, request.idempotencyWindowMs ?? 5_000),
  });
  return fail(request, key, OrderStatus.FAILED, reason, side, false);
}

function demoFillFromBook(
  request: PaperTradeRequest,
  key: string,
  side: OrderSide,
): ReturnType<typeof validateQuoteForFill> {
  const fillPrice = side === OrderSide.BUY ? request.book.bestAsk : request.book.bestBid;
  if (fillPrice === null || !(fillPrice > 0)) {
    return { ok: false, reason: "no_executable_book" };
  }
  return {
    ok: true,
    fillPrice,
    quote: demoQuoteFromBook({
      quoteId: `paper-demo:${key}`,
      tokenId: request.tokenId,
      fillPrice,
    }),
  };
}

/**
 * Simulate a paper fill. Never sends a Binance placeOrder.
 * LIVE mode is refused here; Phase 11 owns live submission.
 */
export function executePaperTrade(
  request: PaperTradeRequest,
  riskState: RiskSnapshot,
  limits: RiskLimits,
): PaperTradeResult {
  assertPaperExecution(request.mode);

  const side = paperOrderSide(request.action, request.signal.direction, request.positionSide);

  const key = paperIdempotencyKey({
    mode: request.mode,
    strategyId: request.strategyId,
    marketId: request.marketId,
    tokenId: request.tokenId,
    side,
    action: request.action,
    bucketMs: timeBucket(request.now, request.idempotencyWindowMs ?? 5_000),
  });

  const existing = seen.get(key);
  if (existing) {
    inc("paper.duplicate");
    return { ...existing, duplicate: true };
  }

  const quoteCheck = validateQuoteForFill({
    quote: request.quote,
    side,
    bestBid: request.book.bestBid,
    bestAsk: request.book.bestAsk,
    lastPrice: request.book.lastPrice,
    now: request.now,
  });
  const demoReasons = new Set(["missing_quote", "missing_quote_id", "quote_expired"]);
  const resolvedQuote =
    quoteCheck.ok
      ? quoteCheck
      : demoReasons.has(quoteCheck.reason)
        ? demoFillFromBook(request, key, side)
        : quoteCheck;
  if (!resolvedQuote.ok) {
    const status =
      resolvedQuote.reason === "quote_expired" ? OrderStatus.EXPIRED : OrderStatus.FAILED;
    return fail(request, key, status, resolvedQuote.reason, side, false);
  }
  const usedDemoBook = !quoteCheck.ok;

  const decision = evaluateRisk(
    {
      action: request.action,
      mode: request.mode,
      now: request.now,
      strategyId: request.strategyId,
      marketId: request.marketId,
      requestedNotional: request.requestedNotional,
      bestBid: request.book.bestBid,
      bestAsk: request.book.bestAsk,
      lastPrice: request.book.lastPrice,
      liquidity: request.book.liquidity,
      timeToExpirySec: request.book.timeToExpirySec,
      estimatedSlippageBps: resolvedQuote.quote.slippageBps,
      estimatedPriceImpact: resolvedQuote.quote.priceImpact,
      quoteExpireAt: resolvedQuote.quote.expireAt,
      dataAgeMs: request.book.dataAgeMs,
      proposedFillPrice: resolvedQuote.fillPrice,
    },
    riskState,
    limits,
  );

  if (!decision.allowed) {
    const failed = decision.checks.find((item) => !item.passed);
    return fail(
      request,
      key,
      OrderStatus.FAILED,
      failed?.name ?? "risk_rejected",
      side,
      false,
      decision,
    );
  }

  transitionOrder(OrderStatus.PENDING, OrderStatus.SUBMITTED);

  const fill = simulateFill({
    side,
    requestedNotional: request.requestedNotional,
    bestBid: side === OrderSide.SELL ? resolvedQuote.fillPrice : request.book.bestBid,
    bestAsk: side === OrderSide.BUY ? resolvedQuote.fillPrice : request.book.bestAsk,
    lastPrice: request.book.lastPrice,
    bidDepth: request.book.bidDepth,
    askDepth: request.book.askDepth,
    liquidity: request.book.liquidity,
    quote: toHistoricalQuote(resolvedQuote.quote),
    costs: {
      useQuoteFees: true,
      fallbackFeeRateBps: null,
      simulateSlippage: true,
      simulatePriceImpact: true,
      allowPartialFills: true,
      networkCostUsdt: 0,
    },
    maxPriceImpact: request.maxPriceImpact,
  });

  if (!fill.ok) {
    return fail(request, key, OrderStatus.FAILED, fill.reason, side, true, decision);
  }

  const status = transitionOrder(
    OrderStatus.SUBMITTED,
    fill.partial ? OrderStatus.PARTIALLY_FILLED : OrderStatus.FILLED,
  );

  const result: PaperTradeResult = {
    duplicate: false,
    clientOrderId: clientOrderIdFromKey(key),
    idempotencyKey: key,
    status,
    side,
    reason: fill.partial ? "partial_fill" : usedDemoBook ? "filled_demo_book" : "filled",
    fill,
    riskAllowed: true,
    orderType: OrderType.MARKET,
    riskDecision: decision,
  };
  inc("paper.order", { status, reason: result.reason });
  seen.set(key, result);
  return result;
}
