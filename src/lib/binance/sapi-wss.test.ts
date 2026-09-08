import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PREDICTION_ORDERBOOK_AGGREGATED_TOPIC,
  buildSapiSignedQuery,
  buildSapiWssUrl,
  parseOrderbookPayload,
  parseSapiEnvelope,
  restOrderBookToPayload,
  sapiPingMessage,
  sapiSubscribeMessage,
  shouldApplyOrderbookUpdate,
} from "./sapi-wss";

describe("buildSapiSignedQuery", () => {
  it("repeats tokenIds keys the way batch-redeem expects", () => {
    const built = buildSapiSignedQuery({
      apiSecret: "secret",
      timestampMs: 1_753_244_327_210,
      pairs: [
        ["walletAddress", "0xabc"],
        ["walletId", "w-1"],
        ["tokenIds", "aaa"],
        ["tokenIds", "bbb"],
        ["chainId", "56"],
      ],
    });
    expect(built.payload).toBe(
      "chainId=56&timestamp=1753244327210&tokenIds=aaa&tokenIds=bbb&walletAddress=0xabc&walletId=w-1",
    );
    expect(built.query).toContain("tokenIds=aaa&tokenIds=bbb");
    expect(built.query).toContain(`signature=${built.signature}`);
  });
});

describe("buildSapiWssUrl", () => {
  it("signs alphabetically sorted query params with HMAC-SHA256", () => {
    const built = buildSapiWssUrl({
      apiSecret: "secret",
      topic: PREDICTION_ORDERBOOK_AGGREGATED_TOPIC,
      recvWindowMs: 30_000,
      timestampMs: 1_753_244_327_210,
      random: "56724ac693184379ae23ffe5e910063c",
    });

    const expectedPayload =
      "random=56724ac693184379ae23ffe5e910063c&recvWindow=30000&timestamp=1753244327210&topic=web3_prediction_orderbook_data";
    const expectedSignature = createHmac("sha256", "secret")
      .update(expectedPayload)
      .digest("hex");

    expect(built.payload).toBe(expectedPayload);
    expect(built.signature).toBe(expectedSignature);
    expect(built.url).toContain(`signature=${expectedSignature}`);
    expect(built.url.startsWith("wss://api.binance.com/sapi/wss?")).toBe(true);
  });
});

describe("orderbook envelope", () => {
  it("parses stringified data from the SApi TOPIC envelope", () => {
    const envelope = parseSapiEnvelope({
      type: "TOPIC",
      topic: "web3_prediction_orderbook_8859231",
      data: JSON.stringify({
        msgType: "orderbook",
        marketId: 8859231,
        updateTimestampMs: 1717420800123,
        asks: [["0.32", "500"]],
        bids: [["0.31", "800"]],
      }),
    });

    const book = parseOrderbookPayload(envelope?.data);
    expect(book?.marketId).toBe(8859231);
    expect(book?.bids[0]?.[0]).toBe("0.31");
    expect(book?.asks[0]?.[1]).toBe("500");
  });

  it("parses REST {price,size} books and string market ids", () => {
    const book = restOrderBookToPayload("42", {
      timestamp: 1_717_420_800_123,
      bids: [{ price: "0.31", size: "800" }],
      asks: [{ price: "0.32", size: "500" }],
    });
    expect(book?.marketId).toBe(42);
    expect(book?.bids).toEqual([["0.31", "800"]]);
    expect(book?.asks).toEqual([["0.32", "500"]]);
  });

  it("builds SApi subscribe and ping commands", () => {
    expect(sapiSubscribeMessage("web3_prediction_orderbook_data")).toEqual({
      command: "SUBSCRIBE",
      value: ["web3_prediction_orderbook_data"],
    });
    expect(sapiPingMessage()).toEqual({ command: "PING" });
  });

  it("discards out-of-order updates", () => {
    expect(shouldApplyOrderbookUpdate(undefined, 100)).toBe(true);
    expect(shouldApplyOrderbookUpdate(100, 101)).toBe(true);
    expect(shouldApplyOrderbookUpdate(100, 100)).toBe(false);
    expect(shouldApplyOrderbookUpdate(100, 99)).toBe(false);
  });
});
