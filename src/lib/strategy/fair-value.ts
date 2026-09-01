import type { Strategy, StrategyContext } from "@/lib/types/domain";
import {
  bookReady,
  clampProb,
  estimateCosts,
  makeSignal,
  numParam,
  sigmoid,
  timeToExpiryOk,
} from "@/lib/strategy/common";

function modelProbability(context: StrategyContext, volPerSqrtHour: number): number | null {
  if (context.startPrice === null || context.underlyingPrice === null) {
    return null;
  }
  if (context.startPrice === 0) return null;
  const moneyness =
    (context.underlyingPrice - context.startPrice) / context.startPrice;
  const hours = Math.max((context.timeToExpirySec ?? 3600) / 3600, 1 / 60);
  const denom = volPerSqrtHour * Math.sqrt(hours);
  if (!(denom > 0)) return null;
  return clampProb(sigmoid(moneyness / denom));
}

/**
 * Compare a simple moneyness/time model to the executable book after costs
 * and a safety margin. Missing start/underlying → no signal (do not invent fair).
 */
export function createFairValueStrategy(
  params: Record<string, unknown> = {},
): Strategy {
  const minNetEdge = numParam(params, "minNetEdge", 0.02);
  const safetyMargin = numParam(params, "safetyMargin", 0.005);
  const minTimeToExpirySec = numParam(params, "minTimeToExpirySec", 60);
  const volPerSqrtHour = numParam(params, "volPerSqrtHour", 0.015);
  const exitEdge = numParam(params, "exitEdge", minNetEdge / 2);

  return {
    id: "fair-value",
    kind: "FAIR_VALUE",
    evaluate(context: StrategyContext) {
      if (!bookReady(context) || !timeToExpiryOk(context, minTimeToExpirySec)) {
        return null;
      }
      const fair = modelProbability(context, volPerSqrtHour);
      if (fair === null) {
        return null;
      }

      const ask = context.bestAsk!;
      const bid = context.bestBid!;
      const costs = estimateCosts(context, safetyMargin);
      const buyEdge = fair - ask;
      const sellEdge = bid - fair;
      const buyNet = buyEdge - costs.total;
      const sellNet = sellEdge - costs.total;
      const gap = Math.abs(fair - (context.marketProbability || ask));
      const confidence = Math.min(0.9, gap * 4);

      if (buyNet >= minNetEdge) {
        return makeSignal({
          strategyId: "fair-value",
          context,
          direction: "BUY",
          fairProbability: fair,
          grossEdge: buyEdge,
          costs,
          confidence,
          reason: `fair ${fair.toFixed(3)} vs ask ${ask.toFixed(3)} after costs`,
        });
      }
      if (sellNet >= minNetEdge) {
        return makeSignal({
          strategyId: "fair-value",
          context,
          direction: "SELL",
          fairProbability: fair,
          grossEdge: sellEdge,
          costs,
          confidence,
          reason: `fair ${fair.toFixed(3)} vs bid ${bid.toFixed(3)} after costs`,
        });
      }
      if (Math.max(buyNet, sellNet) < exitEdge) {
        return makeSignal({
          strategyId: "fair-value",
          context,
          direction: "EXIT",
          fairProbability: fair,
          grossEdge: Math.max(buyEdge, sellEdge),
          costs,
          confidence: 0.2,
          reason: "fair value: net edge below safety band",
        });
      }
      return null;
    },
  };
}
