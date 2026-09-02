import { describe, expect, it } from "vitest";
import {
  classifyEndDate,
  marketHeadline,
  parseCollectorCategories,
  selectHorizonTopics,
  sortTopicsByEndDate,
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
    expect(marketHeadline({ title: "BTC Up or Down 5m", question: null })).toBe(
      "BTC Up or Down 5m",
    );
  });
});
