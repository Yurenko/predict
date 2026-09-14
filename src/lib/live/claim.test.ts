import { describe, expect, it } from "vitest";
import {
  LIVE_CLAIM_DELAY_MS,
  LIVE_CLAIM_STAGGER_MS,
  isClaimInFlight,
  mapVenuePosition,
  mergeVenuePosition,
  pickClaimTokenIds,
  pickSingleClaimToken,
  shouldClaimPosition,
  stampClaimEligibleAt,
  parseClaimState,
} from "./claim";

const now = new Date("2026-09-03T14:12:00.000Z");

function claim(over: Record<string, unknown> = {}) {
  return parseClaimState({
    claim: {
      eligibleAt: new Date(now.getTime() - LIVE_CLAIM_DELAY_MS).toISOString(),
      ...over,
    },
  });
}

describe("shouldClaimPosition", () => {
  it("waits one minute after the expired close", () => {
    expect(
      shouldClaimPosition({
        now,
        expired: true,
        claim: claim({
          eligibleAt: new Date(now.getTime() + 1_000).toISOString(),
        }),
        canClaim: true,
        claimAmount: 1.7,
      }),
    ).toBe(false);
    expect(
      shouldClaimPosition({
        now,
        expired: true,
        claim: claim(),
        canClaim: true,
        claimAmount: 1.7,
      }),
    ).toBe(true);
  });

  it("does not start a second claim while one is pending", () => {
    expect(
      shouldClaimPosition({
        now,
        expired: true,
        claim: claim({
          startedAt: now.toISOString(),
          status: "PENDING",
          txHash: "0xabc",
        }),
        canClaim: true,
        claimAmount: 1.7,
      }),
    ).toBe(false);
    expect(isClaimInFlight(claim({ status: "PENDING", txHash: "0xabc" }), now)).toBe(true);
  });

  it("skips a finished redeem", () => {
    expect(
      shouldClaimPosition({
        now,
        expired: true,
        claim: claim({ status: "CONFIRMED", txHash: "0xabc" }),
        canClaim: true,
        claimAmount: 1.7,
      }),
    ).toBe(false);
  });

  it("manual claim skips the one-minute timer when Binance already lists it", () => {
    expect(
      shouldClaimPosition({
        now,
        expired: true,
        claim: parseClaimState({}),
        canClaim: true,
        claimAmount: 1.7,
        immediate: true,
      }),
    ).toBe(true);
  });

  it("does not claim a book SELL that is not expired", () => {
    expect(
      shouldClaimPosition({
        now,
        expired: false,
        claim: claim(),
        canClaim: true,
        claimAmount: 1.7,
      }),
    ).toBe(false);
  });

  it("retries a failed redeem only after the stagger window", () => {
    const recentFail = shouldClaimPosition({
      now,
      expired: true,
      claim: claim({
        status: "FAILED",
        startedAt: new Date(now.getTime() - 10_000).toISOString(),
      }),
      canClaim: true,
      claimAmount: 1.7,
    });
    const afterWait = shouldClaimPosition({
      now,
      expired: true,
      claim: claim({
        status: "FAILED",
        startedAt: new Date(now.getTime() - LIVE_CLAIM_STAGGER_MS - 1).toISOString(),
      }),
      canClaim: true,
      claimAmount: 1.7,
    });
    expect(recentFail).toBe(false);
    expect(afterWait).toBe(true);
  });
});

describe("stampClaimEligibleAt", () => {
  it("keeps the first timer and does not schedule a second one", () => {
    const first = stampClaimEligibleAt({}, now);
    const again = stampClaimEligibleAt(first, new Date(now.getTime() + 5_000));
    expect(parseClaimState(again).eligibleAt).toBe(now.toISOString());
    expect(again.expired).toBe(true);
  });
});

describe("pickClaimTokenIds", () => {
  it("batches every ready token together", () => {
    expect(pickClaimTokenIds(["a", "b", "a"])).toEqual(["a", "b"]);
  });

  it("falls back to one token after a recent claim", () => {
    expect(pickSingleClaimToken(["a", "b"], now, new Date(now.getTime() + 1_000))).toEqual([]);
    expect(
      pickSingleClaimToken(
        ["a", "b"],
        now,
        new Date(now.getTime() + LIVE_CLAIM_STAGGER_MS + 1),
      ),
    ).toEqual(["a"]);
  });
});

describe("mapVenuePosition", () => {
  it("uses Binance realized PnL (fees already deducted) and claim amount", () => {
    const mapped = mapVenuePosition({
      positionId: 99,
      tokenId: "tok-1",
      shares: "3.71",
      avgPrice: "0.47",
      totalCost: "1.77",
      realizedPnl: "1.55",
      claimAmount: "3.32",
      canClaim: true,
      currentPrice: "1",
      isWinner: true,
    });
    expect(mapped.venuePositionId).toBe("99");
    expect(mapped.realizedPnl).toBeCloseTo(1.55);
    expect(mapped.claimAmount).toBeCloseTo(3.32);
    expect(mapped.closePrice).toBe(1);
    expect(mapped.expired).toBe(true);
    expect(mapped.canClaim).toBe(true);
  });
});

describe("mergeVenuePosition", () => {
  it("treats PENDING_CLAIM as expired and claimable", () => {
    const ongoing = mapVenuePosition({
      tokenId: "tok-1",
      shares: "2",
      positionStatus: "OPEN",
    });
    const pending = mapVenuePosition({
      tokenId: "tok-1",
      shares: "2",
      claimAmount: "2",
    });
    const merged = mergeVenuePosition(ongoing, pending, "PENDING_CLAIM");
    expect(merged.canClaim).toBe(true);
    expect(merged.expired).toBe(true);
    expect(merged.claimAmount).toBeCloseTo(2);
    expect(merged.tradableShares).toBe(0);
  });

  it("keeps ONGOING shares tradable until a settled tab arrives", () => {
    const ongoing = mapVenuePosition({
      tokenId: "tok-1",
      shares: "11.64",
      positionStatus: "OPEN",
    });
    const merged = mergeVenuePosition(undefined, ongoing, "ONGOING");
    expect(merged.tradableShares).toBeCloseTo(11.64);
    expect(merged.expired).toBe(false);
  });
});

it("prefers Binance settled pnl when realizedPnl is zero for a loser", () => {
  const mapped = mapVenuePosition({
    tokenId: "loser",
    shares: "0",
    totalCost: "1.00",
    realizedPnl: "0",
    pnl: "-1.00",
    positionStatus: "SETTLED",
  });
  expect(mapped.realizedPnl).toBeCloseTo(-1);
});

it("maps Binance settlement value separately from the historical pnl", () => {
  const mapped = mapVenuePosition({
    tokenId: "winner",
    shares: "2",
    totalCost: "1.00",
    pnl: "0.20",
    realizedPnl: "0",
    value: "1.20",
    positionStatus: "SETTLED",
  });
  expect(mapped.settlementValue).toBeCloseTo(1.2);
  expect(mapped.realizedPnl).toBeCloseTo(0.2);
});
