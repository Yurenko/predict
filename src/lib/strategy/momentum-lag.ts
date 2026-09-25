import type { Strategy, StrategyContext } from "@/lib/types/domain";
import { env } from "@/lib/config/env";
import { cryptoWindowKind, windowMinVsStart } from "@/lib/markets/horizon";
import { outcomeIsDownToken } from "@/lib/normalize/markets";
import { DEFAULT_MAX_ENTRY_ASK, entryAskAllowed, minSellBidForMaxAsk } from "@/lib/risk/entry-ask";
import {
  bookReady,
  estimateCosts,
  makeSignal,
  numParam,
  timeToExpiryOk,
} from "@/lib/strategy/common";

export { outcomeIsDownToken };

export type SpotWindowSide = "up" | "down";
export type TapeHorizon = "2m" | "5m" | "15m";

const FIVE_MINUTE_WINDOW_MAX_SEC = 450;
const FIFTEEN_MINUTE_WINDOW_MAX_SEC = 1_800;

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

export function isHourWindow(windowDurationSec: number | null | undefined): boolean {
  return (windowDurationSec ?? 0) > FIFTEEN_MINUTE_WINDOW_MAX_SEC;
}

/** @deprecated use isFiveMinuteWindow */
export const allowOneMinuteTape = isFiveMinuteWindow;

/** 5m → 2m tape; 15m → 5m tape; 1h → 15m tape. */
export function tapeHorizon(windowDurationSec: number | null | undefined): TapeHorizon {
  if (isFiveMinuteWindow(windowDurationSec)) return "2m";
  if (isHourWindow(windowDurationSec)) return "15m";
  return "5m";
}

export function tapeLookbackSec(horizon: TapeHorizon): number {
  if (horizon === "2m") return 120;
  if (horizon === "15m") return 900;
  return 300;
}

/** Vol scales with sqrt(time) from a 1m baseline. */
export function defaultMinReturn2m(minReturn1m: number): number {
  return minReturn1m * Math.sqrt(2);
}

export function defaultMinReturn5m(minReturn1m: number): number {
  return minReturn1m * Math.sqrt(5);
}

export function defaultMinReturn15m(minReturn1m: number): number {
  return minReturn1m * Math.sqrt(15);
}

function tapeSign(returnPct: number | null | undefined, minReturn: number): 1 | -1 | 0 {
  if (returnPct == null || Math.abs(returnPct) < minReturn) return 0;
  return returnPct > 0 ? 1 : -1;
}

/**
 * 5m/15m/1h/1d Up/Down settle on spot vs this window's startPrice (the candle open).
 * Tape (2m on 5m, 5m on 15m, 15m on 1h/1d) may only confirm the candle.
 * A tape reversal against the open is a skip — consensus with LLM also requires the candle.
 * Near expiry (same block length), follow the candle and ignore tape.
 */
export function spotWindowSide(options: {
  startPrice: number | null;
  spot: number | null;
  return1m?: number | null;
  return2m?: number | null;
  return5m?: number | null;
  return15m?: number | null;
  minVsStart: number;
  minReturn1m: number;
  minReturn2m?: number;
  minReturn5m?: number;
  minReturn15m?: number;
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
  const minReturn15m = options.minReturn15m ?? defaultMinReturn15m(minReturn1m);
  const tapeReturn =
    horizon === "2m"
      ? (options.return2m ?? null)
      : horizon === "15m"
        ? (options.return15m ?? null)
        : (options.return5m ?? null);
  const tapeMin = horizon === "2m" ? minReturn2m : horizon === "15m" ? minReturn15m : minReturn5m;
  const tape = tapeSign(tapeReturn, tapeMin);
  const tapeLabel = horizon === "2m" ? "2м" : horizon === "15m" ? "15м" : "5м";
  const ignoreReversal = shouldIgnoreTape({
    timeToExpirySec: options.timeToExpirySec,
    ignoreWithinSec: options.ignoreReversalWithinSec ?? tapeLookbackSec(horizon),
  });
  if (tape !== 0 && candle !== 0 && tape !== candle && !ignoreReversal) {
    return null;
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
 * Tape may confirm; a reversal against the candle is a skip, not a flip.
 */
export function createMomentumLagStrategy(
  params: Record<string, unknown> = {},
): Strategy {
  const minTimeToExpirySec = numParam(params, "minTimeToExpirySec", 60);
  const minVsStart = numParam(params, "minVsStart", 0.0005);
  const minReturn1m = numParam(params, "minReturn1m", 0.0003);
  const minReturn2m = numParam(params, "minReturn2m", defaultMinReturn2m(minReturn1m));
  const minReturn5m = numParam(params, "minReturn5m", defaultMinReturn5m(minReturn1m));
  const minReturn15m = numParam(params, "minReturn15m", defaultMinReturn15m(minReturn1m));
  const maxBuyAsk = Math.min(
    numParam(params, "maxBuyAsk", env.MAX_ENTRY_ASK || DEFAULT_MAX_ENTRY_ASK),
    env.MAX_ENTRY_ASK || DEFAULT_MAX_ENTRY_ASK,
  );
  const minSellBid = Math.max(
    numParam(params, "minSellBid", minSellBidForMaxAsk(maxBuyAsk)),
    minSellBidForMaxAsk(maxBuyAsk),
  );
  const safetyMargin = numParam(params, "safetyMargin", 0.005);
  const minNetEdge = numParam(params, "minNetEdge", env.EDGE_MIN);
  const maxNetEdge = numParam(params, "maxNetEdge", env.EDGE_MAX);

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
        return15m: context.features.underlyingReturn15m,
        minVsStart: Math.max(
          minVsStart,
          windowMinVsStart(cryptoWindowKind({ windowDurationSec: context.windowDurationSec })),
        ),
        minReturn1m,
        minReturn2m,
        minReturn5m,
        minReturn15m,
        timeToExpirySec: context.timeToExpirySec,
        windowDurationSec: context.windowDurationSec,
      });
      if (!picked) return null;

      const direction = tokenDirection(picked.side, context.outcomeName);
      const ask = context.bestAsk;
      const bid = context.bestBid;
      if (direction === "BUY" && !entryAskAllowed(ask, maxBuyAsk)) return null;
      if (direction === "SELL" && (bid == null || bid < minSellBid)) return null;

      const costs = estimateCosts(context, safetyMargin);
      const fair = picked.side === "up" ? 0.7 : 0.3;
      const tokenFair = outcomeIsDownToken(context.outcomeName) ? 1 - fair : fair;
      const grossEdge = direction === "BUY" ? tokenFair - ask : bid - tokenFair;
      const netEdge = grossEdge - costs.total;
      if (netEdge < minNetEdge || netEdge > maxNetEdge) return null;
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
