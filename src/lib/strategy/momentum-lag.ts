import type { Strategy, StrategyContext } from "@/lib/types/domain";
import {
  bookReady,
  estimateCosts,
  makeSignal,
  numParam,
  sigmoid,
  stringListParam,
  timeToExpiryOk,
} from "@/lib/strategy/common";

function pickMomentumReturn(context: StrategyContext, horizons: string[]): number | null {
  const map: Record<string, number | null> = {
    "1m": context.features.underlyingReturn1m,
    "5m": context.features.underlyingReturn5m,
    "15m": context.features.underlyingReturn15m,
  };
  let best: number | null = null;
  for (const key of horizons) {
    const value = map[key];
    if (value === null || value === undefined) continue;
    if (best === null || Math.abs(value) > Math.abs(best)) best = value;
  }
  return best;
}

/**
 * Hypothesis: the underlying already moved and the prediction book has not
 * fully repriced. Not assumed profitable.
 */
export function createMomentumLagStrategy(
  params: Record<string, unknown> = {},
): Strategy {
  const minNetEdge = numParam(params, "minNetEdge", 0.02);
  const minTimeToExpirySec = numParam(params, "minTimeToExpirySec", 60);
  const minUnderlyingMove = numParam(params, "minUnderlyingMove", 0.001);
  const returnScale = numParam(params, "returnScale", 0.01);
  const safetyMargin = numParam(params, "safetyMargin", 0.005);
  const exitEdge = numParam(params, "exitEdge", minNetEdge / 2);
  const horizons = stringListParam(params, "returns", ["1m", "5m", "15m"]);

  return {
    id: "underlying-momentum-lag",
    kind: "UNDERLYING_MOMENTUM_LAG",
    evaluate(context: StrategyContext) {
      if (!bookReady(context) || !timeToExpiryOk(context, minTimeToExpirySec)) {
        return null;
      }
      const move = pickMomentumReturn(context, horizons);
      if (move === null || Math.abs(move) < minUnderlyingMove) {
        return null;
      }

      const ask = context.bestAsk!;
      const bid = context.bestBid!;
      const fair = sigmoid(move / returnScale);
      const costs = estimateCosts(context, safetyMargin);
      const buyEdge = fair - ask;
      const sellEdge = bid - fair;
      const buyNet = buyEdge - costs.total;
      const sellNet = sellEdge - costs.total;
      const confidence = Math.min(0.9, Math.abs(move) / returnScale / 4);

      if (buyNet >= minNetEdge) {
        return makeSignal({
          strategyId: "underlying-momentum-lag",
          context,
          direction: "BUY",
          fairProbability: fair,
          grossEdge: buyEdge,
          costs,
          confidence,
          reason: `momentum lag: underlying ${move.toFixed(4)} vs ask ${ask.toFixed(4)}`,
        });
      }
      if (sellNet >= minNetEdge) {
        return makeSignal({
          strategyId: "underlying-momentum-lag",
          context,
          direction: "SELL",
          fairProbability: fair,
          grossEdge: sellEdge,
          costs,
          confidence,
          reason: `momentum lag: underlying ${move.toFixed(4)} vs bid ${bid.toFixed(4)}`,
        });
      }
      if (Math.max(buyNet, sellNet) < exitEdge) {
        return makeSignal({
          strategyId: "underlying-momentum-lag",
          context,
          direction: "EXIT",
          fairProbability: fair,
          grossEdge: Math.max(buyEdge, sellEdge),
          costs,
          confidence: 0.2,
          reason: "momentum lag: net edge faded",
        });
      }
      return null;
    },
  };
}
