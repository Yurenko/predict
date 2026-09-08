import {
  OrderSide,
  OrderStatus,
  OrderType,
  TradingMode,
} from "@prisma/client";
import type { PlaceOrderParams } from "@/lib/binance/prediction-adapter";
import { evaluateRisk } from "@/lib/risk/evaluate";
import type { RiskLimits, RiskSnapshot } from "@/lib/risk/types";
import { paperOrderSide } from "@/lib/paper/action";
import { clientOrderIdFromKey, paperIdempotencyKey, timeBucket } from "@/lib/paper/idempotency";
import { validateQuoteForFill } from "@/lib/paper/quote-validate";
import type { PaperTradeRequest, PaperTradeResult } from "@/lib/paper/engine";
import { assertLiveExecution } from "@/lib/live/gate";
import { buildLimitPlaceOrder, buildMarketPlaceOrder } from "@/lib/live/place";
import { LIVE_MIN_ORDER_USDT, maxLiveEnterNotional } from "@/lib/live/notional";
import { inc } from "@/lib/observability/metrics";

export interface LiveVenue {
  placeOrder(params: PlaceOrderParams): Promise<{ orderId?: string }>;
}

export interface LiveTradeContext {
  walletAddress: string;
  walletId: string;
  accountType: "SPOT" | "FUNDING";
}

export interface LiveTradeResult extends PaperTradeResult {
  venueOrderId: string | null;
  placed: boolean;
}

const seen = new Map<string, LiveTradeResult>();

export function resetLiveIdempotencyCache(): void {
  seen.clear();
}

function fail(
  key: string,
  status: OrderStatus,
  reason: string,
  side: OrderSide,
  riskAllowed: boolean,
  riskDecision: LiveTradeResult["riskDecision"] = null,
): LiveTradeResult {
  const result: LiveTradeResult = {
    duplicate: false,
    clientOrderId: clientOrderIdFromKey(key, "live"),
    idempotencyKey: key,
    status,
    side,
    reason,
    fill: null,
    riskAllowed,
    orderType: OrderType.MARKET,
    riskDecision,
    venueOrderId: null,
    placed: false,
  };
  inc("live.order", { status, reason });
  seen.set(key, result);
  return result;
}

/**
 * Submit a live MARKET/FOK order via official placeOrder after getQuote + risk.
 * Does not simulate a fill. Fill quantities come later from queryOrderHistory.
 */
export async function executeLiveTrade(
  request: PaperTradeRequest,
  riskState: RiskSnapshot,
  limits: RiskLimits,
  venue: LiveVenue,
  ctx: LiveTradeContext,
): Promise<LiveTradeResult> {
  assertLiveExecution(request.mode);

  const side = paperOrderSide(
    request.action,
    request.signal.direction,
    request.positionSide,
    request.orderSide,
  );

  const key = paperIdempotencyKey({
    mode: TradingMode.LIVE,
    strategyId: request.strategyId,
    marketId: request.marketId,
    tokenId: request.tokenId,
    side,
    action: request.action,
    bucketMs: timeBucket(request.now, request.idempotencyWindowMs ?? 5_000),
    extra: request.idempotencySalt,
  });

  const existing = seen.get(key);
  if (existing) {
    inc("live.duplicate");
    return { ...existing, duplicate: true };
  }

  if (request.action === "ENTER" && request.requestedNotional < LIVE_MIN_ORDER_USDT) {
    return fail(key, OrderStatus.FAILED, "below_market_min_amount", side, false);
  }

  if (request.action === "ENTER") {
    const maxOrder = maxLiveEnterNotional(limits);
    if (request.requestedNotional > maxOrder + 1e-9) {
      return fail(key, OrderStatus.FAILED, "above_max_position", side, false);
    }
  }

  const quoteCheck = validateQuoteForFill({
    quote: request.quote,
    side,
    bestBid: request.book.bestBid,
    bestAsk: request.book.bestAsk,
    lastPrice: request.book.lastPrice,
    now: request.now,
  });
  if (!quoteCheck.ok) {
    const status =
      quoteCheck.reason === "quote_expired" ? OrderStatus.EXPIRED : OrderStatus.FAILED;
    return fail(key, status, quoteCheck.reason, side, false);
  }

  if (!ctx.walletAddress.trim() || !ctx.walletId.trim()) {
    return fail(key, OrderStatus.FAILED, "missing_wallet_id", side, false);
  }

  const decision = evaluateRisk(
    {
      action: request.action,
      mode: TradingMode.LIVE,
      now: request.now,
      strategyId: request.strategyId,
      marketId: request.marketId,
      requestedNotional: request.requestedNotional,
      bestBid: request.book.bestBid,
      bestAsk: request.book.bestAsk,
      lastPrice: request.book.lastPrice,
      liquidity: request.book.liquidity,
      timeToExpirySec: request.book.timeToExpirySec,
      estimatedSlippageBps: quoteCheck.quote.slippageBps,
      estimatedPriceImpact: quoteCheck.quote.priceImpact,
      quoteExpireAt: quoteCheck.quote.expireAt,
      dataAgeMs: request.book.dataAgeMs,
      proposedFillPrice: quoteCheck.fillPrice,
    },
    riskState,
    limits,
  );

  if (!decision.allowed) {
    const failed = decision.checks.find((item) => !item.passed);
    return fail(key, OrderStatus.FAILED, failed?.name ?? "risk_rejected", side, false, decision);
  }

  const slippageBps = quoteCheck.quote.slippageBps ?? limits.maxSlippageBps;
  const limitPrice = request.priceLimit ?? request.quote?.priceLimit ?? null;
  const useLimit = request.action === "EXIT" && request.orderType === "LIMIT" && limitPrice != null && limitPrice > 0;
  const body = useLimit
    ? buildLimitPlaceOrder({
        walletAddress: ctx.walletAddress,
        walletId: ctx.walletId,
        quoteId: quoteCheck.quote.quoteId,
        slippageBps,
        accountType: ctx.accountType,
        priceLimit: limitPrice,
      })
    : buildMarketPlaceOrder({
        walletAddress: ctx.walletAddress,
        walletId: ctx.walletId,
        quoteId: quoteCheck.quote.quoteId,
        slippageBps,
        accountType: ctx.accountType,
      });

  try {
    const placed = await venue.placeOrder(body);
    if (!placed.orderId) {
      return fail(key, OrderStatus.FAILED, "missing_venue_order_id", side, true, decision);
    }
    const result: LiveTradeResult = {
      duplicate: false,
      clientOrderId: clientOrderIdFromKey(key, "live"),
      idempotencyKey: key,
      status: OrderStatus.SUBMITTED,
      side,
      reason: request.exitIntent ?? "submitted",
      fill: null,
      riskAllowed: true,
      orderType: useLimit ? OrderType.LIMIT : OrderType.MARKET,
      riskDecision: decision,
      venueOrderId: placed.orderId,
      placed: true,
    };
    inc("live.order", { status: result.status, reason: result.reason });
    seen.set(key, result);
    return result;
  } catch (error) {
    return fail(key, OrderStatus.FAILED, String(error), side, true, decision);
  }
}
