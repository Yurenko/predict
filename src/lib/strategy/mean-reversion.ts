import type { Strategy, StrategyContext } from "@/lib/types/domain";
import {
  bookReady,
  estimateCosts,
  makeSignal,
  numParam,
  timeToExpiryOk,
} from "@/lib/strategy/common";

/**
 * Z-score of traded probability vs its own rolling mean/vol.
 * A raw "spread > X" rule is intentionally not used.
 */
export function createMeanReversionStrategy(
  params: Record<string, unknown> = {},
): Strategy {
  const entryZ = numParam(params, "entryZ", 2);
  const exitZ = numParam(params, "exitZ", 0.5);
  const minNetEdge = numParam(params, "minNetEdge", 0.015);
  const minTimeToExpirySec = numParam(params, "minTimeToExpirySec", 60);
  const safetyMargin = numParam(params, "safetyMargin", 0.005);

  return {
    id: "mean-reversion",
    kind: "MEAN_REVERSION",
    evaluate(context: StrategyContext) {
      if (!bookReady(context) || !timeToExpiryOk(context, minTimeToExpirySec)) {
        return null;
      }
      const z = context.features.probabilityZ;
      const mean = context.features.probabilityMean;
      if (z === null || mean === null) {
        return null;
      }

      const ask = context.bestAsk!;
      const bid = context.bestBid!;
      const costs = estimateCosts(context, safetyMargin);
      const buyEdge = mean - ask;
      const sellEdge = bid - mean;
      const confidence = Math.min(0.95, Math.abs(z) / (entryZ * 2));

      if (Math.abs(z) <= exitZ) {
        return makeSignal({
          strategyId: "mean-reversion",
          context,
          direction: "EXIT",
          fairProbability: mean,
          grossEdge: 0,
          costs,
          confidence: 0.2,
          reason: `mean reversion: |z|=${z.toFixed(2)} inside exit band`,
        });
      }

      if (z <= -entryZ && buyEdge - costs.total >= minNetEdge) {
        return makeSignal({
          strategyId: "mean-reversion",
          context,
          direction: "BUY",
          fairProbability: mean,
          grossEdge: buyEdge,
          costs,
          confidence,
          reason: `mean reversion: z=${z.toFixed(2)} below -${entryZ}`,
        });
      }
      if (z >= entryZ && sellEdge - costs.total >= minNetEdge) {
        return makeSignal({
          strategyId: "mean-reversion",
          context,
          direction: "SELL",
          fairProbability: mean,
          grossEdge: sellEdge,
          costs,
          confidence,
          reason: `mean reversion: z=${z.toFixed(2)} above ${entryZ}`,
        });
      }
      return null;
    },
  };
}
