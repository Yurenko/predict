import { describe, expect, it } from "vitest";
import { normalizeOrderbook, timeToExpirySec } from "./orderbook";
import { normalizeMarketDetail, pickComplementOutcome, pickPrimaryOutcome } from "./markets";
import { normalizeUnderlyingTicker } from "./underlying";
import { fitPgDecimal38 } from "./numbers";

describe("normalizeOrderbook", () => {
  it("uses the book mid as chance and never fills lastPrice", () => {
    const snapshot = normalizeOrderbook({
      msgType: "orderbook",
      marketId: 42,
      updateTimestampMs: 1_700_000_000_000,
      bids: [
        ["0.40", "10"],
        ["0.39", "20"],
      ],
      asks: [
        ["0.42", "5"],
        ["0.43", "15"],
      ],
    });

    expect(snapshot.lastPrice).toBeNull();
    expect(snapshot.bestBid).toBe("0.4");
    expect(snapshot.bestAsk).toBe("0.42");
    expect(snapshot.midPrice).toBe("0.41");
    expect(snapshot.chance).toBe("0.41");
    expect(snapshot.spread).toBe("0.02");
    expect(snapshot.executableFromBook).toBe(true);
    expect(Number(snapshot.liquidity)).toBeCloseTo(0.4 * 10 + 0.39 * 20 + 0.42 * 5 + 0.43 * 15);
  });

  it("leaves chance empty when mid is not a unit probability", () => {
    const snapshot = normalizeOrderbook({
      msgType: "orderbook",
      marketId: 1,
      updateTimestampMs: 1,
      bids: [["2", "1"]],
      asks: [["3", "1"]],
    });
    expect(snapshot.midPrice).toBe("2.5");
    expect(snapshot.chance).toBeNull();
    expect(snapshot.lastPrice).toBeNull();
  });
});

describe("normalizeMarketDetail", () => {
  it("maps official topic/market/outcome fields and prefers YES as primary", () => {
    const topic = normalizeMarketDetail({
      marketTopicId: 9,
      title: "BTC Up or Down",
      symbol: "BTCUSDT",
      endDate: 1_800_000_000_000,
      variantData: { startPrice: "70000", priceFeedSymbol: "BTCUSDT" },
      markets: [
        {
          marketId: 42,
          title: "BTC 1h",
          outcomes: [
            { tokenId: "no-1", name: "No", index: 1, chance: "0.55" },
            { tokenId: "yes-1", name: "Yes", index: 0, chance: "0.45", price: "0.45" },
          ],
        },
      ],
    });

    expect(topic?.marketTopicId).toBe("9");
    expect(topic?.symbol).toBe("BTCUSDT");
    expect(topic?.markets[0]?.venueMarketId).toBe("42");
    expect(pickPrimaryOutcome(topic?.markets[0]?.outcomes ?? [])?.tokenId).toBe("yes-1");
    expect(pickComplementOutcome(topic?.markets[0]?.outcomes ?? [], "yes-1")?.tokenId).toBe("no-1");
  });
});

describe("normalizeUnderlyingTicker", () => {
  it("marks spot last price as not executable", () => {
    const snapshot = normalizeUnderlyingTicker({
      symbol: "btcusdt",
      price: 79000,
      bid: 78999,
      ask: 79001,
      eventTime: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(snapshot?.symbol).toBe("BTCUSDT");
    expect(snapshot?.executable).toBe(false);
    expect(snapshot?.price).toBe("79000");
  });
});

describe("timeToExpirySec", () => {
  it("is negative-capable seconds until endDate", () => {
    const observed = new Date("2026-09-01T00:00:00.000Z");
    const end = new Date("2026-09-01T00:02:00.000Z");
    expect(timeToExpirySec(end, observed)).toBe(120);
    expect(timeToExpirySec(null, observed)).toBeNull();
  });
});

describe("fitPgDecimal38", () => {
  it("keeps ordinary USDT amounts", () => {
    expect(fitPgDecimal38(1.5)).toBe(1.5);
    expect(fitPgDecimal38(0.96)).toBe(0.96);
  });

  it("scales wei that would overflow Decimal(38,18)", () => {
    expect(fitPgDecimal38(2e20)).toBeCloseTo(200);
    expect(fitPgDecimal38(1e38)).toBeNull();
  });
});
