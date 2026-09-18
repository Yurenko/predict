import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ENTRY_ASK,
  entryAskAllowed,
  shouldClearPendingFlipOnBlockedEnter,
} from "./entry-ask";

describe("entry ask cap", () => {
  it("matches the strategy maxBuyAsk of 0.75", () => {
    expect(DEFAULT_MAX_ENTRY_ASK).toBe(0.75);
    expect(entryAskAllowed(0.75)).toBe(true);
    expect(entryAskAllowed(0.751)).toBe(false);
    expect(entryAskAllowed(0.85)).toBe(false);
    expect(entryAskAllowed(0.32)).toBe(true);
    expect(entryAskAllowed(null)).toBe(false);
  });

  it("drops a pending flip when the ask cap blocked ENTER", () => {
    expect(shouldClearPendingFlipOnBlockedEnter(["max_entry_ask"])).toBe(true);
    expect(shouldClearPendingFlipOnBlockedEnter(["min_time_to_expiry"])).toBe(true);
    expect(shouldClearPendingFlipOnBlockedEnter(["max_positions"])).toBe(false);
  });
});
