import { describe, expect, it } from "vitest";
import {
  LIVE_CLAIM_AFTER_CLOSE_MS,
  LIVE_INVENTORY_TABS,
  liveOverlayWriteNeeded,
  livePositionTabs,
  liveReconcileWriteNeeded,
  shouldArmLiveClaimAfterClose,
  shouldAssignLiveVenuePositionId,
  shouldRefreshLiveAccountAfterCycle,
} from "./sync-scope";

describe("live sync scope", () => {
  it("keeps ENDED off the trading inventory path", () => {
    expect(LIVE_INVENTORY_TABS).toEqual(["ONGOING", "PENDING_CLAIM"]);
    expect(livePositionTabs(false)).toEqual(["ONGOING", "PENDING_CLAIM"]);
    expect(livePositionTabs(true)).toEqual(["ONGOING", "PENDING_CLAIM", "ENDED"]);
  });

  it("does not stamp a venuePositionId already owned by another row", () => {
    expect(shouldAssignLiveVenuePositionId({ rowId: "open", ownerId: null })).toBe(true);
    expect(shouldAssignLiveVenuePositionId({ rowId: "open", ownerId: "open" })).toBe(true);
    expect(shouldAssignLiveVenuePositionId({ rowId: "open", ownerId: "closed" })).toBe(false);
  });

  it("skips order writes when Binance reports the same cumulative fill", () => {
    expect(
      liveReconcileWriteNeeded({
        currentStatus: "FILLED",
        nextStatus: "FILLED",
        hasFillDelta: false,
        previousShares: 3.49,
        cumulativeShares: 3.49,
        previousNotional: 1,
        cumulativeNotional: 1,
        previousFee: 0.01,
        cumulativeFee: 0.01,
        previousNetwork: 0,
        cumulativeNetwork: 0,
        vendorOrderIdChanged: false,
        fillPctChanged: false,
        averagePriceChanged: false,
      }),
    ).toBe(false);
    expect(
      liveReconcileWriteNeeded({
        currentStatus: "SUBMITTED",
        nextStatus: "FILLED",
        hasFillDelta: false,
        previousShares: 0,
        cumulativeShares: 0,
        previousNotional: 0,
        cumulativeNotional: 0,
        previousFee: 0,
        cumulativeFee: 0,
        previousNetwork: 0,
        cumulativeNetwork: 0,
        vendorOrderIdChanged: false,
        fillPctChanged: false,
        averagePriceChanged: false,
      }),
    ).toBe(true);
  });

  it("only re-syncs the account after a close, not after ENTER", () => {
    expect(shouldRefreshLiveAccountAfterCycle({ closed: 0 })).toBe(false);
    expect(shouldRefreshLiveAccountAfterCycle({ closed: 1 })).toBe(true);
  });

  it("arms one delayed claim after a close and never on a dry tick", () => {
    expect(shouldArmLiveClaimAfterClose({ closed: 0 })).toBe(false);
    expect(shouldArmLiveClaimAfterClose({ closed: 1 })).toBe(true);
    expect(LIVE_CLAIM_AFTER_CLOSE_MS).toBe(30_000);
  });

  it("skips overlay writes when inventory numbers already match", () => {
    const current = {
      status: "OPEN",
      shares: 3.5,
      avgPrice: 0.28,
      totalCost: 1,
      realizedPnl: 0,
      unrealizedPnl: -0.75,
      venuePositionId: "vp-1",
      closedAt: null,
    };
    expect(liveOverlayWriteNeeded(current, { shares: 3.5, avgPrice: 0.28, unrealizedPnl: -0.75 })).toBe(
      false,
    );
    expect(liveOverlayWriteNeeded(current, { shares: 3.51 })).toBe(true);
    expect(liveOverlayWriteNeeded(current, { status: "CLOSED" })).toBe(true);
    expect(liveOverlayWriteNeeded(current, { rawPayload: { venueAvgPrice: 0.28 } })).toBe(true);
  });
});
