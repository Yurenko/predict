import type { Strategy, StrategySignal, StrategyContext } from "@/lib/types/domain";

type Factory = (params: Record<string, unknown>) => Strategy;

const factories = new Map<string, Factory>();

export function registerStrategy(slug: string, factory: Factory): void {
  factories.set(slug, factory);
}

export function createStrategy(
  slug: string,
  params: Record<string, unknown> = {},
): Strategy | null {
  const factory = factories.get(slug);
  return factory ? factory(params) : null;
}

export function registeredStrategySlugs(): string[] {
  return [...factories.keys()];
}

export function createCallbackStrategy(
  id: string,
  evaluate: (context: StrategyContext) => StrategySignal | null,
): Strategy {
  return {
    id,
    kind: "ENGINE_SMOKE",
    evaluate,
  };
}

/**
 * Not a research strategy. Buys the ask when it is below 0.5 minus minNetEdge,
 * exits when the bid reclaims 0.5. Used to smoke-test the Phase 4 engine.
 */
export function createEngineSmokeStrategy(
  params: Record<string, unknown> = {},
): Strategy {
  const minNetEdge =
    typeof params.minNetEdge === "number" ? params.minNetEdge : 0.02;
  const safetyMargin =
    typeof params.safetyMargin === "number" ? params.safetyMargin : 0.005;
  return createCallbackStrategy("engine-smoke", (context) => {
    const ask = context.bestAsk;
    const bid = context.bestBid;
    if (ask === null || bid === null) return null;
    const buyEdge = 0.5 - ask - safetyMargin;
    const payload = (
      direction: StrategySignal["direction"],
      reason: string,
      edge: number,
    ): StrategySignal => ({
      strategyId: "engine-smoke",
      marketId: context.marketId,
      outcomeId: context.outcomeId,
      timestamp: context.now,
      direction,
      marketProbability: context.marketProbability,
      fairProbability: 0.5,
      grossEdge: edge,
      estimatedFees: 0,
      estimatedSlippage: context.spread ?? 0,
      estimatedPriceImpact: 0,
      netEdge: edge,
      confidence: 0.1,
      reason,
      riskChecks: [],
    });

    if (bid >= 0.5) {
      return payload("EXIT", "smoke bid reclaimed 0.5", bid - 0.5);
    }
    if (ask <= 0.5 - minNetEdge) {
      return payload("BUY", "smoke ask below 0.5 - minNetEdge", buyEdge);
    }
    return null;
  });
}

registerStrategy("engine-smoke", createEngineSmokeStrategy);
