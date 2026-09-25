import { describe, expect, it } from "vitest";
import {
  cryptoWindowDurationSec,
  cryptoWindowKind,
  windowMinVsStart,
  classifyEndDate,
  heldOrTradableMarketWhere,
  isShortCryptoUpDownMarket,
  marketHeadline,
  parseCollectorCategories,
  pickDiscoveredTopics,
  selectHorizonTopics,
  sortTopicsByEndDate,
  tradableMarketWhere,
  uniqueTopicsById,
} from "./horizon";

const now = new Date("2026-09-01T17:00:00.000Z");
const minSec = 60;
const maxSec = 86_400;

function at(offsetSec: number) {
  return now.getTime() + offsetSec * 1000;
}

describe("classifyEndDate", () => {
  it("keeps a match that settles tonight and a 5m up/down", () => {
    expect(classifyEndDate(at(3 * 3600), now, minSec, maxSec)).toBe("in_window");
    expect(classifyEndDate(at(5 * 60), now, minSec, maxSec)).toBe("in_window");
  });

  it("rejects already-expired, too close, and long-dated FDV", () => {
    expect(classifyEndDate(at(-60), now, minSec, maxSec)).toBe("expired");
    expect(classifyEndDate(at(30), now, minSec, maxSec)).toBe("too_soon");
    expect(classifyEndDate(at(30 * 86_400), now, minSec, maxSec)).toBe("too_far");
  });

  it("treats missing endDate as unknown", () => {
    expect(classifyEndDate(null, now, minSec, maxSec)).toBe("unknown");
  });
});

describe("selectHorizonTopics", () => {
  it("skips expired then stops after the first too-far row on END_DATE ASC", () => {
    const listed = [
      { marketTopicId: "1", endDate: at(-120) },
      { marketTopicId: "2", endDate: at(300) },
      { marketTopicId: "3", endDate: at(8 * 3600) },
      { marketTopicId: "4", endDate: at(40 * 86_400) },
      { marketTopicId: "5", endDate: at(90 * 86_400) },
    ];
    const { keep, hitFar } = selectHorizonTopics(listed, now, minSec, maxSec);
    expect(keep.map((row) => String(row.marketTopicId))).toEqual(["2", "3"]);
    expect(hitFar).toBe(true);
  });
});

describe("parseCollectorCategories", () => {
  it("treats blank / all as an unfiltered list", () => {
    expect(parseCollectorCategories("")).toEqual([undefined]);
    expect(parseCollectorCategories("all")).toEqual([undefined]);
  });

  it("splits explicit categories", () => {
    expect(parseCollectorCategories("crypto, sports")).toEqual(["crypto", "sports"]);
  });
});

describe("topic helpers", () => {
  it("reads 5m vs 15m length from dates or the clock range in the title", () => {
    expect(
      cryptoWindowDurationSec({
        startDate: new Date("2026-09-17T05:30:00.000Z"),
        endDate: new Date("2026-09-17T05:35:00.000Z"),
      }),
    ).toBe(300);
    expect(
      cryptoWindowDurationSec({
        startDate: new Date("2026-09-17T05:00:00.000Z"),
        endDate: new Date("2026-09-17T05:15:00.000Z"),
      }),
    ).toBe(900);
    expect(
      cryptoWindowDurationSec({
        title: "BNB Up or Down - September 17, 1:30AM-1:35AM ET",
      }),
    ).toBe(300);
    expect(
      cryptoWindowDurationSec({
        title: "Bitcoin Up or Down - September 16, 2PM-2:15PM ET",
      }),
    ).toBe(900);
    expect(cryptoWindowKind({ windowDurationSec: 86_400 })).toBe("1d");
    expect(cryptoWindowKind({ title: "ETH Up or Down 1d" })).toBe("1d");
    expect(windowMinVsStart("5m")).toBe(0.0005);
    expect(windowMinVsStart("1h")).toBe(0.0008);
    expect(windowMinVsStart("1d")).toBe(0.001);
  });

  it("dedupes and sorts by endDate", () => {
    const rows = uniqueTopicsById(
      sortTopicsByEndDate([
        { marketTopicId: "b", endDate: at(800) },
        { marketTopicId: "a", endDate: at(200) },
        { marketTopicId: "a", endDate: at(200) },
      ]),
    );
    expect(rows.map((row) => String(row.marketTopicId))).toEqual(["a", "b"]);
  });

  it("prefers the full question over the short Binance title", () => {
    expect(
      marketHeadline({
        title: "$500M",
        question: "Will $MarsCoin hit $500M FDV before October?",
      }),
    ).toBe("Will $MarsCoin hit $500M FDV before October?");
    expect(
      marketHeadline({ title: "BTC Up or Down 5m", question: null }),
    ).toBe("BTC Up or Down 5m");
  });

  it("keeps BTC/ETH 5m ahead of 15m when the cap is tight", () => {
    const picked = pickDiscoveredTopics(
      [
        { marketTopicId: "kospi", title: "KOSPI Composite Index Up or Down on September 4, 2026?", endDate: at(3 * 3600) },
        { marketTopicId: "cs", title: "Counter-Strike: 9INE vs Rune Eaters (BO3)", endDate: at(2 * 3600) },
        { marketTopicId: "btc5", title: "BTC Up or Down 5m", symbol: "BTCUSDT", endDate: at(240) },
        { marketTopicId: "eth15", title: "ETH Up or Down 15m", symbol: "ETHUSDT", endDate: at(800) },
        { marketTopicId: "hynix", title: "Will SK hynix Inc close above 1,596,000 KRW on September 4, 2026?", endDate: at(4 * 3600) },
      ],
      2,
    );
    expect(picked.map((row) => String(row.marketTopicId))).toEqual(["btc5", "eth15"]);
  });

  it("keeps 1h and 1d, drops SOL, sports, and stocks", () => {
    const picked = pickDiscoveredTopics(
      [
        { marketTopicId: "btc1h", title: "BTC Up or Down 1h", symbol: "BTCUSDT", endDate: at(3600) },
        { marketTopicId: "eth1d", title: "ETH Up or Down 1d", symbol: "ETHUSDT", endDate: at(8 * 3600) },
        { marketTopicId: "sol5", title: "SOL Up or Down 5m", symbol: "SOLUSDT", endDate: at(240) },
        { marketTopicId: "dota", title: "Dota 2: Team Spirit vs Falcons", endDate: at(1800) },
        { marketTopicId: "bnb15", title: "BNB Up or Down 15m", symbol: "BNBUSDT", endDate: at(700) },
      ],
      20,
    );
    expect(picked.map((row) => String(row.marketTopicId))).toEqual(["bnb15", "btc1h", "eth1d"]);
  });
});

describe("isShortCryptoUpDownMarket", () => {
  it("accepts BTC/ETH/BNB 5m, 15m, 1h and 1d, including long Bitcoin titles", () => {
    expect(
      isShortCryptoUpDownMarket({
        title: "BTC Up or Down 5m",
        symbol: "BTCUSDT",
      }),
    ).toBe(true);
    expect(
      isShortCryptoUpDownMarket({
        title: "ETH Up or Down 15m",
        symbol: "ETHUSDT",
      }),
    ).toBe(true);
    expect(
      isShortCryptoUpDownMarket({
        title: "BNB Up or Down 15m",
        question: "BNB Up or Down - September 7, 3AM-3:15AM ET",
        symbol: "BNBUSDT",
      }),
    ).toBe(true);
    expect(
      isShortCryptoUpDownMarket({
        title: "BTC Up or Down 1h",
        symbol: "BTCUSDT",
      }),
    ).toBe(true);
    expect(
      isShortCryptoUpDownMarket({
        title: "ETH Up or Down 1d",
        symbol: "ETHUSDT",
      }),
    ).toBe(true);
    expect(
      isShortCryptoUpDownMarket({
        title: "Bitcoin Up or Down - September 7, 3AM-3:05AM ET",
        symbol: "BTCUSDT",
      }),
    ).toBe(true);
  });

  it("rejects 4h, SOL, and non-crypto", () => {
    expect(isShortCryptoUpDownMarket({ title: "ETH Up or Down 4h", symbol: "ETHUSDT" })).toBe(false);
    expect(isShortCryptoUpDownMarket({ title: "SOL Up or Down 5m", symbol: "SOLUSDT" })).toBe(false);
    expect(
      isShortCryptoUpDownMarket({
        title: "KOSPI Composite Index Up or Down on September 4, 2026?",
      }),
    ).toBe(false);
  });
});

describe("heldOrTradableMarketWhere", () => {
  it("keeps the 24h tradable window and OPEN positions", () => {
    const where = heldOrTradableMarketWhere(now, { mode: "LIVE" });
    expect(where.OR).toEqual([
      tradableMarketWhere(now),
      { positions: { some: { status: "OPEN", mode: "LIVE" } } },
    ]);
  });
});

describe("tradableMarketWhere", () => {
  it("restricts new entries to BTC/ETH/BNB 5m, 15m, 1h and 1d", () => {
    const where = tradableMarketWhere(now);
    expect(where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: expect.objectContaining({
            endDate: expect.objectContaining({
              gte: expect.any(Date),
              lte: expect.any(Date),
            }),
          }),
        }),
        expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({ OR: expect.any(Array) }),
          ]),
        }),
      ]),
    );
  });
});
