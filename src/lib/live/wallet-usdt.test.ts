import { describe, expect, it } from "vitest";
import { usdtFreeFromFundingAsset, usdtFreeFromSpotAccount } from "./wallet-usdt";

describe("live wallet USDT parse", () => {
  it("reads free USDT from a spot account snapshot", () => {
    expect(
      usdtFreeFromSpotAccount({
        balances: [
          { asset: "BTC", free: "0.1" },
          { asset: "USDT", free: "12.45", locked: "1" },
        ],
      }),
    ).toBeCloseTo(12.45);
    expect(usdtFreeFromSpotAccount({ balances: [] })).toBeNull();
  });

  it("reads funding-asset USDT from an array or data wrapper", () => {
    expect(usdtFreeFromFundingAsset([{ asset: "USDT", free: "3.2" }])).toBeCloseTo(3.2);
    expect(usdtFreeFromFundingAsset({ data: [{ asset: "USDT", free: "8" }] })).toBeCloseTo(8);
  });
});
