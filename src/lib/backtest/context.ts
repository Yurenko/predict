import type { HistoricalQuote, MarketTick, UnderlyingTick } from "@/lib/backtest/types";
import { lastAtOrBefore, returnOver, rollingStats } from "@/lib/backtest/features";
import type { StrategyContext } from "@/lib/types/domain";

const MINUTE = 60_000;

export function quoteAsOf(
  quotes: HistoricalQuote[],
  tokenId: string | null,
  now: Date,
): HistoricalQuote | null {
  if (!tokenId) return null;
  const rows = quotes
    .filter((quote) => quote.tokenId === tokenId)
    .map((quote) => ({ ...quote, observedAt: quote.quotedAt }));
  return lastAtOrBefore(rows, now);
}

export function buildStrategyContext(options: {
  now: Date;
  tick: MarketTick;
  underlyings: UnderlyingTick[];
  probability: Array<{ observedAt: Date; value: number }>;
  quotes: HistoricalQuote[];
  rollingWindow: number;
}): StrategyContext {
  const { now, tick } = options;
  if (tick.observedAt.getTime() > now.getTime()) {
    throw new Error("look-ahead blocked: market tick after clock");
  }

  const underlying = tick.symbol
    ? lastAtOrBefore(options.underlyings, now)
    : null;
  if (underlying && underlying.observedAt.getTime() > now.getTime()) {
    throw new Error("look-ahead blocked: underlying after clock");
  }

  const probability = tick.chance ?? tick.midPrice;
  const stats = rollingStats(options.probability, now, options.rollingWindow);
  const quote = quoteAsOf(options.quotes, tick.tokenId, now);

  const timeToExpirySec = tick.endDate
    ? Math.floor((tick.endDate.getTime() - now.getTime()) / 1000)
    : tick.timeToExpirySec;

  return {
    now,
    marketId: tick.marketId,
    outcomeId: tick.outcomeId ?? undefined,
    tokenId: tick.tokenId ?? "",
    marketProbability: probability ?? 0,
    executableProbability: tick.bestAsk,
    lastPrice: tick.lastPrice,
    bestBid: tick.bestBid,
    bestAsk: tick.bestAsk,
    liquidity: tick.liquidity,
    spread: tick.spread,
    timeToExpirySec,
    underlyingSymbol: tick.symbol,
    underlyingPrice: underlying?.price ?? null,
    startPrice: tick.startPrice,
    volume: underlying?.volume ?? null,
    features: {
      underlyingReturn1m: returnOver(options.underlyings, now, MINUTE),
      underlyingReturn5m: returnOver(options.underlyings, now, 5 * MINUTE),
      underlyingReturn15m: returnOver(options.underlyings, now, 15 * MINUTE),
      probabilityMean: stats?.mean ?? null,
      probabilityStd: stats?.std ?? null,
      probabilityZ: stats?.z ?? null,
    },
    quote: quote
      ? {
          averagePrice: quote.averagePrice,
          lastPrice: quote.lastPrice,
          chance: quote.chance,
          feeAmount: quote.feeAmount,
          feeRateBps: quote.feeRateBps,
          slippageBps: quote.slippageBps,
          priceImpact: quote.priceImpact,
          minReceive: quote.minReceive,
          expireAt: quote.expireAt,
        }
      : null,
  };
}
