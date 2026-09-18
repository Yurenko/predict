import { describe, expect, it } from "vitest";
import {
  parsePendingFlip,
  parsePendingFlipMember,
  pendingFlipDirection,
  pendingFlipFromSignal,
  pendingFlipReservesSlot,
  pendingFlipMarketExpired,
  reservedCountForEnter,
  pendingFlipSignal,
  pendingFlipTtlMs,
  shouldCancelPendingFlip,
} from "./pending-flip";

describe("pending flip intent", () => {
  it("maps stored side onto the binary signal", () => {
    expect(pendingFlipDirection("UP")).toBe("BUY");
    expect(pendingFlipDirection("DOWN")).toBe("SELL");
    expect(pendingFlipFromSignal("BUY")).toBe("UP");
    expect(pendingFlipFromSignal("SELL")).toBe("DOWN");
    expect(pendingFlipFromSignal("EXIT")).toBeNull();
    expect(pendingFlipFromSignal("FLAT")).toBeNull();
  });

  it("keeps the intent when the strategy is silent", () => {
    expect(shouldCancelPendingFlip("DOWN", null)).toBe(false);
    expect(shouldCancelPendingFlip("DOWN", "FLAT")).toBe(false);
    expect(shouldCancelPendingFlip("DOWN", "SELL")).toBe(false);
  });

  it("cancels on EXIT or the opposite side", () => {
    expect(shouldCancelPendingFlip("DOWN", "EXIT")).toBe(true);
    expect(shouldCancelPendingFlip("DOWN", "BUY")).toBe(true);
    expect(shouldCancelPendingFlip("UP", "SELL")).toBe(true);
    expect(shouldCancelPendingFlip("UP", "BUY")).toBe(false);
  });

  it("does not abort a committed flip when the tape flickers the other way", () => {
    expect(shouldCancelPendingFlip("DOWN", "BUY", { committed: true })).toBe(false);
    expect(shouldCancelPendingFlip("DOWN", "EXIT", { committed: true })).toBe(true);
  });

  it("lets a flip ENTER ignore leftover pending keys", () => {
    expect(
      reservedCountForEnter({ reserved: 4, openAndInflight: 0, fulfillsPendingFlip: true }),
    ).toBe(0);
    expect(
      reservedCountForEnter({ reserved: 4, openAndInflight: 2, fulfillsPendingFlip: true }),
    ).toBe(2);
    expect(
      reservedCountForEnter({ reserved: 4, openAndInflight: 2, fulfillsPendingFlip: false }),
    ).toBe(4);
    expect(
      reservedCountForEnter({ reserved: 2, openAndInflight: 2, fulfillsPendingFlip: false }),
    ).toBe(2);
    expect(
      reservedCountForEnter({
        reserved: 1,
        openAndInflight: 1,
        fulfillsPendingFlip: true,
        closingLegStillCounted: true,
      }),
    ).toBe(0);
  });

  it("treats a contract past endDate as no longer flippable", () => {
    const now = new Date("2026-09-07T19:15:00.000Z");
    expect(pendingFlipMarketExpired(new Date("2026-09-07T19:15:00.000Z"), now)).toBe(true);
    expect(pendingFlipMarketExpired(new Date("2026-09-07T19:20:00.000Z"), now)).toBe(false);
    expect(pendingFlipMarketExpired(null, now)).toBe(false);
  });

  it("reserves a slot only after the old leg is gone", () => {
    expect(pendingFlipReservesSlot({ hasOpenOnMarket: true, hasInflightEnterOnMarket: false })).toBe(
      false,
    );
    expect(pendingFlipReservesSlot({ hasOpenOnMarket: false, hasInflightEnterOnMarket: true })).toBe(
      false,
    );
    expect(pendingFlipReservesSlot({ hasOpenOnMarket: false, hasInflightEnterOnMarket: false })).toBe(
      true,
    );
  });

  it("parses redis payload and member keys", () => {
    expect(parsePendingFlipMember("strat-1:mkt-9")).toEqual({
      strategyId: "strat-1",
      marketId: "mkt-9",
    });
    expect(parsePendingFlip('{"strategyId":"s","marketId":"m","side":"DOWN"}')).toMatchObject({
      strategyId: "s",
      marketId: "m",
      side: "DOWN",
    });
    expect(parsePendingFlip("{nope")).toBeNull();
  });

  it("ttls until endDate plus a few seconds", () => {
    const now = new Date("2026-09-06T12:00:00.000Z");
    const end = new Date("2026-09-06T12:10:00.000Z");
    expect(pendingFlipTtlMs(end, now)).toBe(10 * 60 * 1000 + 5_000);
    expect(pendingFlipTtlMs(new Date("2026-09-06T11:00:00.000Z"), now)).toBe(1_000);
  });

  it("builds a pending_flip signal so ENTER can run without a fresh evaluate", () => {
    const signal = pendingFlipSignal({
      strategyId: "fair-value",
      marketId: "eth-15",
      now: new Date("2026-09-06T12:00:00.000Z"),
      side: "DOWN",
    });
    expect(signal.direction).toBe("SELL");
    expect(signal.reason).toBe("pending_flip");
  });
});
