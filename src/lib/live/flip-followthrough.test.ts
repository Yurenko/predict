import { describe, expect, it } from "vitest";
import {
  liveFlipExitConfirmResult,
  officialFlipExitStatus,
  shouldImmediateFlipEnter,
  confirmLiveFlipExit,
} from "./flip-followthrough";

describe("shouldImmediateFlipEnter", () => {
  it("runs only after a strategy flip EXIT, not TP/trail", () => {
    expect(
      shouldImmediateFlipEnter({
        oppositeCloses: true,
        exitPlaced: true,
        managementExit: false,
        wantedSide: "DOWN",
      }),
    ).toBe(true);
    expect(
      shouldImmediateFlipEnter({
        oppositeCloses: true,
        exitPlaced: true,
        managementExit: true,
        wantedSide: "DOWN",
      }),
    ).toBe(false);
    expect(
      shouldImmediateFlipEnter({
        oppositeCloses: true,
        exitPlaced: false,
        managementExit: false,
        wantedSide: "DOWN",
      }),
    ).toBe(false);
    expect(
      shouldImmediateFlipEnter({
        oppositeCloses: false,
        exitPlaced: true,
        managementExit: false,
        wantedSide: "DOWN",
      }),
    ).toBe(false);
  });
});

describe("liveFlipExitConfirmResult", () => {
  it("enters as soon as ONGOING shares are gone, without waiting for a FILLED label", () => {
    expect(
      liveFlipExitConfirmResult({
        orderStatus: "FILLED",
        leftoverShares: 0,
        timedOut: false,
      }),
    ).toEqual({ ready: true, failed: false, reason: "filled" });
    expect(
      liveFlipExitConfirmResult({
        orderStatus: "SUBMITTED",
        leftoverShares: 0,
        timedOut: false,
      }),
    ).toEqual({ ready: true, failed: false, reason: "filled" });
    expect(
      liveFlipExitConfirmResult({
        orderStatus: "FILLED",
        leftoverShares: 2.1,
        timedOut: false,
      }),
    ).toEqual({ ready: false, failed: false, reason: "waiting" });
  });

  it("never enters after a failed or cancelled EXIT", () => {
    expect(
      liveFlipExitConfirmResult({
        orderStatus: "FAILED",
        leftoverShares: 3.5,
        timedOut: false,
      }).failed,
    ).toBe(true);
    expect(
      liveFlipExitConfirmResult({
        orderStatus: "CANCELLED",
        leftoverShares: 0,
        timedOut: true,
      }),
    ).toEqual({ ready: false, failed: true, reason: "failed" });
  });

  it("on timeout does not enter while leftover shares remain", () => {
    expect(
      liveFlipExitConfirmResult({
        orderStatus: "SUBMITTED",
        leftoverShares: 1,
        timedOut: true,
      }),
    ).toEqual({ ready: false, failed: false, reason: "timeout" });
  });
});

describe("officialFlipExitStatus", () => {
  it("treats fillPercentage 1 as FILLED", () => {
    expect(
      officialFlipExitStatus({
        status: "OPEN",
        fillPercentage: "1",
        filledShareQty: "3.5",
      }),
    ).toBe("FILLED");
  });
});

describe("confirmLiveFlipExit", () => {
  it("waits until FILLED and zero leftover shares, then is ready", async () => {
    let n = 0;
    const result = await confirmLiveFlipExit({
      venue: {
        queryOrderHistory: async () => {
          n += 1;
          return {
            orders: [
              {
                orderId: "exit-1",
                status: n >= 2 ? "FILLED" : "OPEN",
                fillPercentage: n >= 2 ? "1" : "0",
                filledShareQty: n >= 2 ? "3.5" : "0",
              },
            ],
          };
        },
        queryPositions: async () => ({ positions: [] }),
      },
      walletAddress: "0xabc",
      venueOrderId: "exit-1",
      tokenId: "up",
      timeoutMs: 5_000,
      intervalMs: 1,
      nowMs: () => n * 100,
      wait: async () => undefined,
      readLeftoverShares: async () => (n >= 2 ? 0 : 3.5),
    });
    expect(result.ready).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.reason).toBe("filled");
  });

  it("does not enter when the EXIT fails", async () => {
    const result = await confirmLiveFlipExit({
      venue: {
        queryOrderHistory: async () => ({
          orders: [{ orderId: "exit-1", status: "FAILED" }],
        }),
        queryPositions: async () => ({ positions: [] }),
      },
      walletAddress: "0xabc",
      venueOrderId: "exit-1",
      tokenId: "up",
      timeoutMs: 1_000,
      intervalMs: 1,
      nowMs: () => 0,
      wait: async () => undefined,
      readLeftoverShares: async () => 3.5,
    });
    expect(result.ready).toBe(false);
    expect(result.failed).toBe(true);
  });
});
