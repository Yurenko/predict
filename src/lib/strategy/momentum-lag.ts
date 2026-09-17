import type { Strategy, StrategyContext } from "@/lib/types/domain";
import { outcomeIsDownToken } from "@/lib/normalize/markets";
import {
  bookReady,
  estimateCosts,
  makeSignal,
  numParam,
  timeToExpiryOk,
} from "@/lib/strategy/common";

export { outcomeIsDownToken };

export type SpotWindowSide = "up" | "down";
export type TapeHorizon = "2m" | "5m";

/** 5m contracts use a 2m tape. Longer windows (15m ≈ 900s) use a 5m tape. */
export const FIVE_MINUTE_WINDOW_MAX_SEC = 450;

export function shouldIgnoreTape(options: {
  timeToExpirySec: number | null | undefined;
  ignoreWithinSec: number;
}): boolean {
  const tte = options.timeToExpirySec;
  const within = options.ignoreWithinSec;
  if (tte == null || !(within > 0)) return false;
  return tte <= within;
}

/** @deprecated use shouldIgnoreTape */
export const shouldIgnoreReversal1m = (options: {
  timeToExpirySec: number | null | undefined;
  ignoreReversal1mWithinSec: number;
}) =>
  shouldIgnoreTape({
    timeToExpirySec: options.timeToExpirySec,
    ignoreWithinSec: options.ignoreReversal1mWithinSec,
  });

export function isFiveMinuteWindow(windowDurationSec: number | null | undefined): boolean {
  if (windowDurationSec == null) return true;
  return windowDurationSec <= FIVE_MINUTE_WINDOW_MAX_SEC;
}

/** @deprecated use isFiveMinuteWindow */
export const allowOneMinuteTape = isFiveMinuteWindow;

/** 5m market → 2m tape; 15m market → 5m tape. */
export function tapeHorizon(windowDurationSec: number | null | undefined): TapeHorizon {
  return isFiveMinuteWindow(windowDurationSec) ? "2m" : "5m";
}

export function tapeLookbackSec(horizon: TapeHorizon): number {
  return horizon === "2m" ? 120 : 300;
}

/** Vol scales with sqrt(time) from a 1m baseline. */
export function defaultMinReturn2m(minReturn1m: number): number {
  return minReturn1m * Math.sqrt(2);
}

export function defaultMinReturn5m(minReturn1m: number): number {
  return minReturn1m * Math.sqrt(5);
}

function tapeSign(returnPct: number | null | undefined, minReturn: number): 1 | -1 | 0 {
  if (returnPct == null || Math.abs(returnPct) < minReturn) return 0;
  return returnPct > 0 ? 1 : -1;
}

/**
 * 5m/15m Up/Down settle on spot vs this window's startPrice (the candle open).
 * Recent tape can flip the side if it already reversed against the body:
 * 2m on a 5m window, 5m on a 15m window. Near expiry (same block length),
 * follow the candle.
 */
export function spotWindowSide(options: {
  startPrice: number | null;
  spot: number | null;
  return1m?: number | null;
  return2m?: number | null;
  return5m?: number | null;
  minVsStart: number;
  minReturn1m: number;
  minReturn2m?: number;
  minReturn5m?: number;
  timeToExpirySec?: number | null;
  windowDurationSec?: number | null;
  ignoreReversalWithinSec?: number;
}): { side: SpotWindowSide; vsStart: number; reason: string } | null {
  const { startPrice, spot, minVsStart, minReturn1m } = options;
  if (startPrice === null || spot === null || !(startPrice > 0)) return null;
  const vsStart = (spot - startPrice) / startPrice;
  const candle = Math.abs(vsStart) >= minVsStart ? (vsStart > 0 ? 1 : -1) : 0;
  const horizon = tapeHorizon(options.windowDurationSec);
  const minReturn2m = options.minReturn2m ?? defaultMinReturn2m(minReturn1m);
  const minReturn5m = options.minReturn5m ?? defaultMinReturn5m(minReturn1m);
  const tapeReturn = horizon === "2m" ? (options.return2m ?? null) : (options.return5m ?? null);
  const tapeMin = horizon === "2m" ? minReturn2m : minReturn5m;
  const tape = tapeSign(tapeReturn, tapeMin);
  const tapeLabel = horizon === "2m" ? "2м" : "5м";
  const ignoreReversal = shouldIgnoreTape({
    timeToExpirySec: options.timeToExpirySec,
    ignoreWithinSec: options.ignoreReversalWithinSec ?? tapeLookbackSec(horizon),
  });
  if (tape !== 0 && candle !== 0 && tape !== candle && !ignoreReversal) {
    const side: SpotWindowSide = tape < 0 ? "down" : "up";
    return {
      side,
      vsStart,
      reason: `розворот ${tapeLabel}: вікно ${vsStart >= 0 ? "вище" : "нижче"} старту ${(vsStart * 100).toFixed(3)}%, ${tapeLabel} ${(tapeReturn! * 100).toFixed(3)}% → ${side}`,
    };
  }
  if (candle !== 0) {
    const side: SpotWindowSide = candle < 0 ? "down" : "up";
    const skipped =
      tape !== 0 && tape !== candle && ignoreReversal
        ? `; ${tapeLabel} розворот ігнор (tte ${options.timeToExpirySec}s)`
        : "";
    return {
      side,
      vsStart,
      reason: `спот ${spot.toFixed(2)} vs старт ${startPrice.toFixed(2)} (${(vsStart * 100).toFixed(3)}%) → ${side}${skipped}`,
    };
  }
  if (candle === 0 && tape !== 0) {
    const side: SpotWindowSide = tape < 0 ? "down" : "up";
    return {
      side,
      vsStart,
      reason: `вікно біля старту, ${tapeLabel} ${(tapeReturn! * 100).toFixed(3)}% → ${side}`,
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
 * Bet this window's settlement side from spot vs startPrice.
 * Tape lookback matches the contract: 2m on 5m, 5m on 15m.
 */
export function createMomentumLagStrategy(
  params: Record<string, unknown> = {},
): Strategy {
  const minTimeToExpirySec = numParam(params, "minTimeToExpirySec", 60);
  const minVsStart = numParam(params, "minVsStart", 0.0005);
  const minReturn1m = numParam(params, "minReturn1m", 0.0003);
  const minReturn2m = numParam(params, "minReturn2m", defaultMinReturn2m(minReturn1m));
  const minReturn5m = numParam(params, "minReturn5m", defaultMinReturn5m(minReturn1m));
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
        return2m: context.features.underlyingReturn2m,
        return5m: context.features.underlyingReturn5m,
        minVsStart,
        minReturn1m,
        minReturn2m,
        minReturn5m,
        timeToExpirySec: context.timeToExpirySec,
        windowDurationSec: context.windowDurationSec,
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
      const netEdge = grossEdge - costs.total;
      // Never enter with a negative edge. Price caps alone are not an entry edge:
      // e.g. BUY @ 0.74 with fair=0.70 is a losing trade before execution costs.
      if (netEdge <= 0) return null;
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
