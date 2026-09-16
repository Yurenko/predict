import { describe, expect, it } from "vitest";
import { officialLiveOrderNeedsApply } from "./reconcile";

function venueOrder(over: Record<string, string> = {}) {
  return {
    orderId: "ord-1",
    status: "FILLED",
    filledShareQty: "3.49",
    filledUsdtAmount: "1",
    marketProviderFee: "0.01",
    networkFee: "0",
    fillPercentage: "1",
    price: "0.2865",
    ...over,
  };
}

describe("officialLiveOrderNeedsApply", () => {
  const local = {
    status: "FILLED",
    filledShareQty: 3.49,
    filledUsdtAmount: 1,
    marketProviderFee: 0.01,
    networkFee: 0,
    vendorOrderId: "v-1",
    fillPercentage: 1,
    averagePrice: 0.2865,
  };

  it("skips a transaction when Binance reports the same cumulative fill", () => {
    expect(officialLiveOrderNeedsApply(local, venueOrder({ vendorOrderId: "v-1" }))).toBe(false);
  });

  it("applies when shares increase", () => {
    expect(officialLiveOrderNeedsApply(local, venueOrder({ filledShareQty: "4.1" }))).toBe(true);
  });

  it("applies when status changes", () => {
    expect(
      officialLiveOrderNeedsApply(
        { ...local, status: "SUBMITTED", filledShareQty: 0, filledUsdtAmount: 0, fillPercentage: 0 },
        venueOrder(),
      ),
    ).toBe(true);
  });
});
