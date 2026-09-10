import {
  OrderStatus,
  OrderType,
  PositionStatus,
  Prisma,
  TradingMode,
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { childLogger } from "@/lib/logger";
import { stampLiveFlatten } from "@/lib/live/flatten";
import { asNumber, fitPgDecimal38 } from "@/lib/normalize/numbers";
import { paperExitPnl } from "@/lib/paper/action";
import type { PaperTradeRequest, PaperTradeResult } from "@/lib/paper/engine";
import type { StrategySignal } from "@/lib/types/domain";

const log = childLogger({ component: "paper-persist" });

export async function persistPaperTrade(options: {
  request: PaperTradeRequest;
  result: PaperTradeResult;
  signal: StrategySignal;
}): Promise<{ realizedPnl: number | null } | null> {
  if (options.result.duplicate) return null;

  try {
    const strategy = await prisma.strategy.findUnique({
      where: { slug: options.request.strategyId },
    });
    const market = await prisma.market.findUnique({
      where: { id: options.request.marketId },
    });
    if (!market) {
      log.warn({ marketId: options.request.marketId }, "paper persist skipped: unknown market");
      return null;
    }

    const existing = await prisma.order.findUnique({
      where: { idempotencyKey: options.result.idempotencyKey },
      include: { executions: true },
    });
    // A PAPER PARTIALLY_FILLED order can receive additional fills. Do not
    // treat the first execution as the end of the order lifecycle.
    if (
      existing &&
      [OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.FAILED, OrderStatus.EXPIRED].includes(
        existing.status,
      )
    ) {
      return { realizedPnl: null };
    }

    let quoteRowId: string | undefined;
    const q = options.request.quote;
    if (q?.quoteId) {
      const savedQuote = await prisma.predictionQuote.upsert({
        where: { quoteId: q.quoteId },
        create: {
          quoteId: q.quoteId,
          marketId: market.id,
          outcomeId: options.request.outcomeId,
          tokenId: options.request.tokenId,
          side: options.result.side,
          orderType: options.request.orderType === "LIMIT" ? OrderType.LIMIT : OrderType.MARKET,
          chance: fitPgDecimal38(q.chance),
          amountIn: fitPgDecimal38(options.request.requestedNotional) ?? 0,
          amountOut: fitPgDecimal38(options.result.fill?.shares) ?? 0,
          averagePrice: fitPgDecimal38(q.averagePrice),
          lastPrice: fitPgDecimal38(q.lastPrice),
          priceImpact: fitPgDecimal38(q.priceImpact),
          feeAmount: fitPgDecimal38(q.feeAmount),
          feeRateBps: q.feeRateBps,
          slippageBps: q.slippageBps,
          minReceive: fitPgDecimal38(q.minReceive),
          expireAt: q.expireAt,
          quotedAt: options.request.now,
        },
        update: {},
      });
      quoteRowId = savedQuote.id;
    }

    let signalId: string | undefined = existing?.signalId ?? undefined;
    if (strategy && !signalId) {
      const saved = await prisma.signal.create({
        data: {
          strategyId: strategy.id,
          marketId: market.id,
          outcomeId: options.request.outcomeId,
          timestamp: options.signal.timestamp,
          direction: options.signal.direction,
          marketProbability: options.signal.marketProbability,
          fairProbability: options.signal.fairProbability,
          grossEdge: options.signal.grossEdge,
          estimatedFees: options.signal.estimatedFees,
          estimatedSlippage: options.signal.estimatedSlippage,
          estimatedPriceImpact: options.signal.estimatedPriceImpact,
          netEdge: options.signal.netEdge,
          confidence: options.signal.confidence,
          reason: options.signal.reason,
          riskChecks: options.signal.riskChecks as unknown as Prisma.InputJsonValue,
          accepted:
            options.result.status === OrderStatus.FILLED ||
            options.result.status === OrderStatus.PARTIALLY_FILLED ||
            options.result.status === OrderStatus.SUBMITTED,
        },
      });
      signalId = saved.id;
    }

    const fill = options.result.fill;
    const order = existing
      ? await prisma.order.update({
          where: { id: existing.id },
          data: {
            status: options.result.status,
            quoteId: quoteRowId ?? existing.quoteId,
            signalId: signalId ?? existing.signalId,
            venueOrderId: options.result.venueOrderId ?? existing.venueOrderId,
            filledUsdtAmount: fill
              ? Number(existing.filledUsdtAmount ?? 0) + fill.notional
              : existing.filledUsdtAmount,
            filledShareQty: fill
              ? Number(existing.filledShareQty ?? 0) + fill.shares
              : existing.filledShareQty,
            fillPercentage: fill
              ? Math.min(
                  1,
                  (Number(existing.filledUsdtAmount ?? 0) + fill.notional) /
                    Math.max(Number(existing.requestedAmount), 1e-12),
                )
              : existing.fillPercentage,
            averagePrice: fill?.price ?? existing.averagePrice,
            marketProviderFee: fill
              ? Number(existing.marketProviderFee ?? 0) + fill.fee
              : existing.marketProviderFee,
            networkFee: fill
              ? Number(existing.networkFee ?? 0) + fill.networkCost
              : existing.networkFee,
            terminalAt:
              options.result.status === OrderStatus.PENDING ||
              options.result.status === OrderStatus.SUBMITTED ||
              options.result.status === OrderStatus.PARTIALLY_FILLED
                ? null
                : options.request.now,
            rawPayload: {
              ...(existing.rawPayload &&
              typeof existing.rawPayload === "object" &&
              !Array.isArray(existing.rawPayload)
                ? (existing.rawPayload as Record<string, unknown>)
                : {}),
              reason: options.result.reason,
              action: options.request.action,
              intent: options.request.exitIntent ?? options.result.reason,
              positionId: options.request.positionId ?? null,
            } as Prisma.InputJsonValue,
          },
        })
      : await prisma.order.create({
          data: {
            mode: options.request.mode,
            clientOrderId: options.result.clientOrderId,
            idempotencyKey: options.result.idempotencyKey,
            venueOrderId: options.result.venueOrderId ?? undefined,
            quoteId: quoteRowId,
            signalId,
            marketId: market.id,
            outcomeId: options.request.outcomeId,
            tokenId: options.request.tokenId,
            side: options.result.side,
            orderType: options.result.orderType,
            status: options.result.status,
            requestedAmount: options.request.requestedNotional,
            slippageBps: q?.slippageBps,
            filledUsdtAmount: fill?.notional ?? null,
            filledShareQty: fill?.shares ?? null,
            fillPercentage: fill
              ? fill.partial
                ? options.request.requestedNotional > 0
                  ? fill.notional / options.request.requestedNotional
                  : 1
                : 1
              : null,
            averagePrice: fill?.price ?? null,
            marketProviderFee: fill?.fee ?? null,
            networkFee: fill?.networkCost ?? null,
            submittedAt: options.request.now,
            terminalAt:
              options.result.status === OrderStatus.PENDING ||
              options.result.status === OrderStatus.SUBMITTED
                ? null
                : options.request.now,
            rawPayload: {
              reason: options.result.reason,
              action: options.request.action,
              intent: options.request.exitIntent ?? options.result.reason,
              positionId: options.request.positionId ?? null,
            } as Prisma.InputJsonValue,
          },
        });

    const openWhere = options.request.positionId
      ? {
          id: options.request.positionId,
          mode: options.request.mode,
          status: PositionStatus.OPEN,
        }
      : {
          mode: options.request.mode,
          status: PositionStatus.OPEN,
          marketId: market.id,
          tokenId: options.request.tokenId,
          ...(strategy ? { strategyId: strategy.id } : {}),
        };

    if (!fill) {
      if (options.request.action === "EXIT" && options.request.mode === TradingMode.LIVE) {
        const pending = await prisma.position.findFirst({ where: openWhere });
        if (pending) {
          await prisma.position.update({
            where: { id: pending.id },
            data: { rawPayload: stampLiveFlatten(pending.rawPayload) as Prisma.InputJsonValue },
          });
        }
      }
      return { realizedPnl: null };
    }

    const open = await prisma.position.findFirst({
      where:
        options.request.positionId && options.result.reason === "expired"
          ? { id: options.request.positionId, mode: options.request.mode }
          : openWhere,
    });

    let positionId = open?.id;
    let realizedPnl: number | null = null;

    if (options.request.action === "ENTER") {
      if (!open) {
        const created = await prisma.position.create({
          data: {
            mode: options.request.mode,
            strategyId: strategy?.id,
            marketId: market.id,
            outcomeId: options.request.outcomeId,
            signalId,
            tokenId: options.request.tokenId,
            side: options.result.side,
            status: PositionStatus.OPEN,
            shares: fill.shares,
            avgPrice: fill.price,
            totalCost: fill.notional + fill.fee + fill.slippage + fill.priceImpact,
            feesPaid: fill.fee,
            slippagePaid: fill.slippage,
            priceImpactPaid: fill.priceImpact,
            networkCostPaid: fill.networkCost,
          },
        });
        positionId = created.id;
      } else {
        const oldShares = Number(open.shares);
        const newShares = oldShares + fill.shares;
        const newAvg =
          newShares > 0
            ? (Number(open.avgPrice) * oldShares + fill.price * fill.shares) / newShares
            : fill.price;
        await prisma.position.update({
          where: { id: open.id },
          data: {
            shares: newShares,
            avgPrice: newAvg,
            totalCost: Number(open.totalCost) + fill.notional + fill.fee + fill.slippage + fill.priceImpact,
            feesPaid: { increment: fill.fee },
            slippagePaid: { increment: fill.slippage },
            priceImpactPaid: { increment: fill.priceImpact },
            networkCostPaid: { increment: fill.networkCost },
          },
        });
      }
    } else if (options.request.action === "EXIT" && open) {
      const openShares = Number(open.shares);
      const closeShares = Math.min(fill.shares, openShares);
      realizedPnl = paperExitPnl(
        {
          side: open.side,
          avgPrice: Number(open.avgPrice),
          shares: openShares,
        },
        { ...fill, shares: closeShares },
      );
      const remaining = Math.max(0, openShares - closeShares);
      const fraction = openShares > 0 ? remaining / openShares : 0;
      const nextStatus = remaining <= 1e-8 ? PositionStatus.CLOSED : PositionStatus.OPEN;
      await prisma.position.update({
        where: { id: open.id },
        data: {
          status: nextStatus,
          closedAt: nextStatus === PositionStatus.CLOSED ? options.request.now : null,
          shares: remaining,
          totalCost: Number(open.totalCost) * fraction,
          realizedPnl: { increment: realizedPnl },
          feesPaid: { increment: fill.fee },
          slippagePaid: { increment: fill.slippage },
          priceImpactPaid: { increment: fill.priceImpact },
          networkCostPaid: { increment: fill.networkCost },
          rawPayload: {
            ...(open.rawPayload && typeof open.rawPayload === "object"
              ? (open.rawPayload as Record<string, unknown>)
              : {}),
            ...(nextStatus === PositionStatus.CLOSED
              ? { closePrice: fill.price }
              : { partialClosePrice: fill.price }),
            ...(options.result.reason === "expired" ? { expired: true, settled: true } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    }

    await prisma.execution.create({
      data: {
        mode: options.request.mode,
        orderId: order.id,
        positionId,
        executedAt: options.request.now,
        price: fill.price,
        shares: fill.shares,
        usdtAmount: fill.notional,
        isPartial: fill.partial,
      },
    });

    if (fill.fee > 0) {
      await prisma.fee.create({
        data: {
          orderId: order.id,
          positionId,
          kind: "market_provider",
          amount: fill.fee,
          bps: q?.feeRateBps,
          observedAt: options.request.now,
        },
      });
    }

    if (positionId) {
      await prisma.order.update({
        where: { id: order.id },
        data: { positionId },
      });
    }

    return { realizedPnl };
  } catch (error) {
    log.warn({ err: String(error) }, "paper persist skipped");
    return null;
  }
}
