import type { RiskCheckResult, SignalDirection, StrategyContext, StrategySignal } from "@/lib/types/domain";

export function numParam(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function stringListParam(
  params: Record<string, unknown>,
  key: string,
  fallback: string[],
): string[] {
  const value = params[key];
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === "string");
}

export function clampProb(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(0.99, Math.max(0.01, value));
}

export function sigmoid(x: number): number {
  return clampProb(1 / (1 + Math.exp(-x)));
}

export interface EstimatedCosts {
  fee: number;
  slippage: number;
  impact: number;
  safetyMargin: number;
  total: number;
  feeKnown: boolean;
}

/**
 * Costs in probability points (same units as chance / ask).
 * Never substitutes 200 bps. Missing quote fees stay 0 and feeKnown=false.
 */
export function estimateCosts(
  context: StrategyContext,
  safetyMargin: number,
): EstimatedCosts {
  const quote = context.quote;
  const feeKnown = quote !== null && typeof quote.feeRateBps === "number";
  const fee = feeKnown && quote.feeRateBps !== null ? quote.feeRateBps / 10_000 : 0;
  const slippage =
    quote && typeof quote.slippageBps === "number" ? quote.slippageBps / 10_000 : 0;
  const rawImpact = quote && typeof quote.priceImpact === "number" ? quote.priceImpact : 0;
  const impact = rawImpact >= 0 && rawImpact <= 1 ? rawImpact : 0;
  return {
    fee,
    slippage,
    impact,
    safetyMargin,
    total: fee + slippage + impact + safetyMargin,
    feeKnown,
  };
}

export function bookReady(context: StrategyContext): boolean {
  return context.bestBid !== null && context.bestAsk !== null && context.bestAsk > 0;
}

export function timeToExpiryOk(context: StrategyContext, minSec: number): boolean {
  if (context.timeToExpirySec === null) return true;
  return context.timeToExpirySec >= minSec;
}

export function makeSignal(options: {
  strategyId: string;
  context: StrategyContext;
  direction: SignalDirection;
  fairProbability: number | null;
  grossEdge: number;
  costs: EstimatedCosts;
  confidence: number;
  reason: string;
  extraChecks?: RiskCheckResult[];
}): StrategySignal {
  const netEdge = options.grossEdge - options.costs.total;
  return {
    strategyId: options.strategyId,
    marketId: options.context.marketId,
    outcomeId: options.context.outcomeId,
    timestamp: options.context.now,
    direction: options.direction,
    marketProbability: options.context.marketProbability,
    fairProbability: options.fairProbability,
    grossEdge: options.grossEdge,
    estimatedFees: options.costs.fee,
    estimatedSlippage: options.costs.slippage,
    estimatedPriceImpact: options.costs.impact,
    netEdge,
    confidence: options.confidence,
    reason: options.reason,
    riskChecks: [
      {
        name: "executable_book",
        passed: bookReady(options.context),
        detail: "signals use bestAsk/bestBid, never lastPrice",
      },
      {
        name: "fee_from_quote",
        passed: options.costs.feeKnown,
        detail: options.costs.feeKnown
          ? "feeRateBps taken from quote"
          : "no quote fee; not substituting 200 bps",
      },
      ...(options.extraChecks ?? []),
    ],
  };
}
