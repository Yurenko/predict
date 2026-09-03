import type { Strategy, StrategyContext } from "@/lib/types/domain";
import {
  bookReady,
  estimateCosts,
  makeSignal,
  numParam,
  timeToExpiryOk,
} from "@/lib/strategy/common";

export type SpotWindowSide = "up" | "down";

export function outcomeIsDownToken(name: string | null | undefined): boolean {
  const key = (name ?? "").trim().toLowerCase();
  return key === "no" || key === "down";
}

/**
 * 5m/15m Up/Down settle on spot vs this window's startPrice (the candle open).
 * Follow that candle. If the last 1m has already reversed against the body,
 * follow the 1m (rise already happened → now down, and vice versa).
 */
export function spotWindowSide(options: {
  startPrice: number | null;
  spot: number | null;
  return1m: number | null;
  minVsStart: number;
  minReturn1m: number;
}): { side: SpotWindowSide; vsStart: number; reason: string } | null {
  const { startPrice, spot, return1m, minVsStart, minReturn1m } = options;
  if (startPrice === null || spot === null || !(startPrice > 0)) return null;
  const vsStart = (spot - startPrice) / startPrice;
  const candle = Math.abs(vsStart) >= minVsStart ? (vsStart > 0 ? 1 : -1) : 0;
  const tape =
    return1m !== null && Math.abs(return1m) >= minReturn1m ? (return1m > 0 ? 1 : -1) : 0;
  if (tape !== 0 && candle !== 0 && tape !== candle) {
    const side: SpotWindowSide = tape < 0 ? "down" : "up";
    return {
      side,
      vsStart,
      reason: `розворот 1м: вікно ${vsStart >= 0 ? "вище" : "нижче"} старту ${(vsStart * 100).toFixed(3)}%, 1м ${(return1m! * 100).toFixed(3)}% → ${side}`,
    };
  }
  if (candle !== 0 && (tape === 0 || tape === candle)) {
    const side: SpotWindowSide = candle < 0 ? "down" : "up";
    return {
      side,
      vsStart,
      reason: `спот ${spot.toFixed(2)} vs старт ${startPrice.toFixed(2)} (${(vsStart * 100).toFixed(3)}%) → ${side}`,
    };
  }
  if (candle === 0 && tape !== 0) {
    const side: SpotWindowSide = tape < 0 ? "down" : "up";
    return {
      side,
      vsStart,
      reason: `вікно біля старту, 1м ${(return1m! * 100).toFixed(3)}% → ${side}`,
    };
  }
  return null;
}

function tokenDirection(
  windowSide: SpotWindowSide,
  outcomeName: string | null | undefined,
): "BUY" | "SELL" {
  const downToken = outcomeIsDownToken(outcomeName);
  if (windowSide === "up") return downToken ? "SELL" : "BUY";
  return downToken ? "BUY" : "SELL";
}

/**
 * Bet the 5m/15m settlement side from the live candle (spot vs startPrice),
 * not a mix of 1m/5m/15m lookbacks that do not match this window.
 */
export function createMomentumLagStrategy(
  params: Record<string, unknown> = {},
): Strategy {
  const minTimeToExpirySec = numParam(params, "minTimeToExpirySec", 60);
  const minVsStart = numParam(params, "minVsStart", 0.0005);
  const minReturn1m = numParam(params, "minReturn1m", 0.0003);
  const maxBuyAsk = numParam(params, "maxBuyAsk", 0.75);
  const minSellBid = numParam(params, "minSellBid", 0.25);
  const safetyMargin = numParam(params, "safetyMargin", 0.005);

  return {
    id: "underlying-momentum-lag",
    kind: "UNDERLYING_MOMENTUM_LAG",
    evaluate(context: StrategyContext) {
      if (!bookReady(context) || !timeToExpiryOk(context, minTimeToExpirySec)) {
        return null;
      }
      const picked = spotWindowSide({
        startPrice: context.startPrice,
        spot: context.underlyingPrice,
        return1m: context.features.underlyingReturn1m,
        minVsStart,
        minReturn1m,
      });
      if (!picked) return null;

      const direction = tokenDirection(picked.side, context.outcomeName);
      const ask = context.bestAsk!;
      const bid = context.bestBid!;
      if (direction === "BUY" && ask > maxBuyAsk) return null;
      if (direction === "SELL" && bid < minSellBid) return null;

      const costs = estimateCosts(context, safetyMargin);
      const fair = picked.side === "up" ? 0.7 : 0.3;
      const tokenFair = outcomeIsDownToken(context.outcomeName) ? 1 - fair : fair;
      const grossEdge = direction === "BUY" ? tokenFair - ask : bid - tokenFair;
      return makeSignal({
        strategyId: "underlying-momentum-lag",
        context,
        direction,
        fairProbability: tokenFair,
        grossEdge,
        costs,
        confidence: Math.min(0.85, Math.abs(picked.vsStart) / 0.01),
        reason: picked.reason,
      });
    },
  };
}
