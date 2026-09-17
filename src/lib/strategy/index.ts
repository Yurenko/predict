export {
  createCallbackStrategy,
  createEngineSmokeStrategy,
  createStrategy,
  registerStrategy,
  registeredStrategySlugs,
} from "@/lib/strategy/registry";
export {
  createMomentumLagStrategy,
  allowOneMinuteTape,
  defaultMinReturn2m,
  defaultMinReturn5m,
  isFiveMinuteWindow,
  shouldIgnoreReversal1m,
  shouldIgnoreTape,
  spotWindowSide,
  tapeHorizon,
  tapeLookbackSec,
} from "@/lib/strategy/momentum-lag";
export { createMeanReversionStrategy } from "@/lib/strategy/mean-reversion";
export { createFairValueStrategy } from "@/lib/strategy/fair-value";
export { evaluateStrategies, loadResearchStrategies, researchStrategyOrder } from "@/lib/strategy/evaluate";

import { registerStrategy } from "@/lib/strategy/registry";
import { createMomentumLagStrategy } from "@/lib/strategy/momentum-lag";
import { createMeanReversionStrategy } from "@/lib/strategy/mean-reversion";
import { createFairValueStrategy } from "@/lib/strategy/fair-value";

registerStrategy("underlying-momentum-lag", createMomentumLagStrategy);
registerStrategy("mean-reversion", createMeanReversionStrategy);
registerStrategy("fair-value", createFairValueStrategy);
