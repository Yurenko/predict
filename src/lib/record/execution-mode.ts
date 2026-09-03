import { PAPER_SKIP } from "@/lib/paper/skip";
import type { PaperCycle } from "@/lib/paper/cycle";

export function liveCycleSkip(
  enabled: number,
  considered: number,
  submitted: number,
): string | null {
  if (enabled === 0) return PAPER_SKIP.noEnabledStrategies;
  if (considered === 0) return PAPER_SKIP.noNearExpiry;
  if (submitted === 0) return PAPER_SKIP.noEntryYet;
  return null;
}

export function cycleFromLiveResult(result: {
  enabled: number;
  considered: number;
  submitted: number;
  skip?: string | null;
  now?: Date;
}): PaperCycle {
  return {
    at: (result.now ?? new Date()).toISOString(),
    enabled: result.enabled,
    considered: result.considered,
    filled: result.submitted,
    skip: result.skip ?? liveCycleSkip(result.enabled, result.considered, result.submitted),
  };
}
