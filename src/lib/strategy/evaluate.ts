import type { Strategy, StrategyContext, StrategySignal } from "@/lib/types/domain";
import { createStrategy } from "@/lib/strategy/registry";

/** Research priority: momentum lag first, then mean reversion, then fair value. */
export const researchStrategyOrder = [
  "underlying-momentum-lag",
  "mean-reversion",
  "fair-value",
] as const;

export function evaluateStrategies(
  strategies: Strategy[],
  context: StrategyContext,
): StrategySignal | null {
  for (const strategy of strategies) {
    const signal = strategy.evaluate(context);
    if (signal) return signal;
  }
  return null;
}

export function loadResearchStrategies(
  paramsBySlug: Record<string, Record<string, unknown>> = {},
): Strategy[] {
  return researchStrategyOrder.flatMap((slug) => {
    const strategy = createStrategy(slug, paramsBySlug[slug] ?? {});
    return strategy ? [strategy] : [];
  });
}
