import { describe, expect, it, vi } from "vitest";
import type { W3WPrediction } from "@binance/w3w-prediction";
import { OfficialPredictionAdapter } from "./prediction-adapter";
import { MinIntervalLimiter } from "./rate-limit";

function fakeClient(rest: Record<string, unknown> = {}) {
  return {
    restAPI: rest,
  } as unknown as W3WPrediction;
}

describe("OfficialPredictionAdapter.getQuote", () => {
  it("maps the official quote body and does not send feeRateBps", async () => {
    const getQuote = vi.fn().mockResolvedValue({
      data: async () => ({
        quoteId: "quote-1",
        tokenId: "token-1",
        feeAmount: "1",
        feeRateBps: 175,
        averagePrice: 0.62,
      }),
    });
    const adapter = new OfficialPredictionAdapter(
      fakeClient({ getQuote }),
      new MinIntervalLimiter(0),
    );

    const quote = await adapter.getQuote({
      walletAddress: "0xabc",
      tokenId: "token-1",
      side: "BUY",
      amountIn: "1500000000000000000",
      orderType: "MARKET",
      slippageBps: 1000,
    });

    expect(getQuote).toHaveBeenCalledTimes(1);
    expect(getQuote.mock.calls[0]?.[0]).not.toHaveProperty("feeRateBps");
    expect(quote.feeRateBps).toBe(175);
    expect(quote.raw.quoteId).toBe("quote-1");
  });

  it("refuses to hardcode a feeRateBps request override", async () => {
    const adapter = new OfficialPredictionAdapter(fakeClient(), new MinIntervalLimiter(0));

    await expect(
      adapter.getQuote({
        walletAddress: "0xabc",
        tokenId: "token-1",
        side: "BUY",
        amountIn: "1500000000000000000",
        orderType: "MARKET",
        slippageBps: 1000,
        feeRateBps: 200,
      }),
    ).rejects.toThrow(/feeRateBps/);
  });

  it("refuses placeOrder when live flags are off", async () => {
    const placeOrder = vi.fn();
    const adapter = new OfficialPredictionAdapter(
      { restAPI: { placeOrder } } as unknown as W3WPrediction,
      new MinIntervalLimiter(0),
    );
    await expect(
      adapter.placeOrder({
        walletAddress: "0xabc",
        walletId: "w-1",
        quoteId: "q-1",
        timeInForce: "FOK",
        accountType: "SPOT",
        orderType: "MARKET",
        slippageBps: 50,
      }),
    ).rejects.toThrow(/placeOrder refused/);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("refuses batchRedeem when live flags are off", async () => {
    const batchRedeem = vi.fn();
    const adapter = new OfficialPredictionAdapter(
      { restAPI: { batchRedeem } } as unknown as W3WPrediction,
      new MinIntervalLimiter(0),
    );
    await expect(
      adapter.batchRedeem({
        walletAddress: "0xabc",
        walletId: "w-1",
        tokenIds: ["tok-1"],
      }),
    ).rejects.toThrow(/batchRedeem refused/);
    expect(batchRedeem).not.toHaveBeenCalled();
  });
});
