import {
  registeredStrategySlugs,
  researchStrategyOrder,
} from "@/lib/strategy";
import { childLogger } from "@/lib/logger";

const log = childLogger({ component: "strategy-worker" });

export async function describeStrategies(): Promise<void> {
  log.info(
    {
      researchOrder: researchStrategyOrder,
      registered: registeredStrategySlugs(),
      enabledDefault: false,
    },
    "research strategies are pluggable and disabled until a walk-forward backtest says otherwise",
  );
}
