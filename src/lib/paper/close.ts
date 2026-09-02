import { OrderSide, OrderStatus, OrderType, PositionStatus, TradingMode } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { asNumber } from "@/lib/normalize/numbers";
import { readLiveOrderbook } from "@/lib/ingest/raw-store";
import { paperExitPnl, paperOrderSide } from "@/lib/paper/action";
import { settlementFill } from "@/lib/paper/expiry";
import { persistPaperTrade } from "@/lib/paper/persist";
import { paperIdempotencyKey, clientOrderIdFromKey } from "@/lib/paper/idempotency";
import { limitsFromEnv } from "@/lib/risk/limits";
import { loadRiskState, persistRiskSnapshot } from "@/lib/risk/persist";
import { recordClosedTrade } from "@/lib/risk/state";
import type { PaperBook, PaperTradeRequest, PaperTradeResult } from "@/lib/paper/engine";
import type { StrategySignal } from "@/lib/types/domain";

const log = childLogger({ component: "paper-manual-close" });

export type ManualCloseReason =
  | "not_found"
  | "not_open"
  | "not_paper"
  | "no_book"
  | "persist_failed";

export function manualExitPrice(options: {
  side: "BUY" | "SELL";
  bestBid: number | null;
  bestAsk: number | null;
  chance: number | null;
}): number | null {
  if (options.side === "BUY" && options.bestBid !== null && options.bestBid >= 0) {
    return options.bestBid;
  }
  if (options.side === "SELL" && options.bestAsk !== null && options.bestAsk >= 0) {
    return options.bestAsk;
  }
  if (options.chance !== null && options.chance >= 0) return options.chance;
  return null;
}

function closeSignal(options: {
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
    reason: "manual_close",
    riskChecks: [],
  };
}

function closeResult(options: {
  mode: TradingMode;
  strategyId: string;
  marketId: string;
  tokenId: string;
  positionSide: OrderSide;
  now: Date;
  fill: ReturnType<typeof settlementFill>;
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
    reason: "manual_close",
    fill: options.fill,
    riskAllowed: true,
    orderType: OrderType.MARKET,
    riskDecision: null,
  };
}

export async function closePaperPosition(positionId: string): Promise<
  { ok: true; price: number; pnl: number } | { ok: false; reason: ManualCloseReason }
> {
  const row = await prisma.position.findUnique({
    where: { id: positionId },
    include: {
      strategy: true,
      market: {
        include: {
          snapshots: { orderBy: { observedAt: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.mode !== TradingMode.PAPER) return { ok: false, reason: "not_paper" };
  if (row.status !== PositionStatus.OPEN) return { ok: false, reason: "not_open" };

  const snap = row.market.snapshots[0];
  const live = await readLiveOrderbook(row.market.venueMarketId);
  const bestBid = asNumber(live?.bestBid) ?? asNumber(snap?.bestBid);
  const bestAsk = asNumber(live?.bestAsk) ?? asNumber(snap?.bestAsk);
  const chance = asNumber(snap?.chance) ?? asNumber(snap?.midPrice);
  const price = manualExitPrice({ side: row.side, bestBid, bestAsk, chance });
  if (price === null) return { ok: false, reason: "no_book" };

  const shares = asNumber(row.shares) ?? 0;
  const avgPrice = asNumber(row.avgPrice) ?? 0;
  const fill = settlementFill(shares, price);
  const now = new Date();
  const strategyId = row.strategy?.slug ?? "unknown";
  const signal = closeSignal({ strategyId, marketId: row.marketId, now, chance });
  const book: PaperBook = {
    bestBid: bestBid ?? price,
    bestAsk: bestAsk ?? price,
    lastPrice: null,
    liquidity: asNumber(snap?.liquidity),
    bidDepth: asNumber(snap?.bidDepth),
    askDepth: asNumber(snap?.askDepth),
    timeToExpirySec: snap?.timeToExpirySec ?? null,
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
    now,
    requestedNotional: Math.max(fill.notional, shares),
    maxPriceImpact: limitsFromEnv().maxPriceImpact,
    positionSide: row.side,
    positionId: row.id,
  };
  const result = closeResult({
    mode: TradingMode.PAPER,
    strategyId,
    marketId: row.marketId,
    tokenId: row.tokenId,
    positionSide: row.side,
    now,
    fill,
  });

  const saved = await persistPaperTrade({ request, result, signal });
  if (!saved) return { ok: false, reason: "persist_failed" };

  const pnl =
    saved.realizedPnl ?? paperExitPnl({ side: row.side, avgPrice, shares }, fill);
  const riskState = await loadRiskState();
  const closed = recordClosedTrade(riskState, pnl, now, limitsFromEnv());
  await persistRiskSnapshot({
    ...closed.state,
    openPositions: Math.max(0, riskState.openPositions - 1),
    openNotional: Math.max(0, riskState.openNotional - shares * avgPrice),
  });

  log.info(
    { positionId, market: row.market.venueMarketId, strategy: strategyId, price, pnl },
    "paper position closed from dashboard",
  );
  return { ok: true, price, pnl };
}
