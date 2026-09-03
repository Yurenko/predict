import { describe, expect, it } from "vitest";
import { cycleFromLiveResult, liveCycleSkip } from "@/lib/record/execution-mode";
import { PAPER_SKIP } from "@/lib/paper/skip";

describe("liveCycleSkip", () => {
  it("maps idle live cycles to the same skip codes as paper", () => {
    expect(liveCycleSkip(0, 0, 0)).toBe(PAPER_SKIP.noEnabledStrategies);
    expect(liveCycleSkip(2, 0, 0)).toBe(PAPER_SKIP.noNearExpiry);
    expect(liveCycleSkip(2, 8, 0)).toBe(PAPER_SKIP.noEntryYet);
    expect(liveCycleSkip(2, 8, 1)).toBeNull();
  });
});

describe("cycleFromLiveResult", () => {
  it("stores submitted live orders in the shared cycle snapshot", () => {
    const cycle = cycleFromLiveResult({
      enabled: 3,
      considered: 12,
      submitted: 2,
      now: new Date("2026-09-03T10:00:00.000Z"),
    });
    expect(cycle).toEqual({
      at: "2026-09-03T10:00:00.000Z",
      enabled: 3,
      considered: 12,
      filled: 2,
      skip: null,
    });
  });

  it("keeps an explicit skip (wallet / adapter) over idle heuristics", () => {
    const cycle = cycleFromLiveResult({
      enabled: 0,
      considered: 0,
      submitted: 0,
      skip: "missing_wallet_id",
      now: new Date("2026-09-03T10:00:00.000Z"),
    });
    expect(cycle.skip).toBe("missing_wallet_id");
  });
});
