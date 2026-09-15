import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_BINARY_MODE,
  liveOppositeCloses,
  parseLiveBinaryMode,
  shouldBlockLiveFlipEnter,
} from "./binary-mode";

describe("live binary mode", () => {
  it("defaults to independent so Live does not force-close on every opposite signal", () => {
    expect(DEFAULT_LIVE_BINARY_MODE).toBe("independent");
    expect(parseLiveBinaryMode(null) ?? DEFAULT_LIVE_BINARY_MODE).toBe("independent");
  });

  it("parses independent vs flip", () => {
    expect(parseLiveBinaryMode("independent")).toBe("independent");
    expect(parseLiveBinaryMode("flip")).toBe("flip");
    expect(parseLiveBinaryMode("paper")).toBeNull();
  });

  it("only flip uses opposite-closes", () => {
    expect(liveOppositeCloses("flip")).toBe(true);
    expect(liveOppositeCloses("independent")).toBe(false);
  });

  it("blocks flip ENTER until the prior leg and its EXIT are gone", () => {
    expect(
      shouldBlockLiveFlipEnter({
        mode: "flip",
        action: "ENTER",
        stillOpen: false,
        inflightOnMarket: true,
      }),
    ).toBe(true);
    expect(
      shouldBlockLiveFlipEnter({
        mode: "flip",
        action: "ENTER",
        stillOpen: true,
        inflightOnMarket: false,
      }),
    ).toBe(true);
    expect(
      shouldBlockLiveFlipEnter({
        mode: "flip",
        action: "ENTER",
        stillOpen: false,
        inflightOnMarket: false,
      }),
    ).toBe(false);
    expect(
      shouldBlockLiveFlipEnter({
        mode: "independent",
        action: "ENTER",
        stillOpen: false,
        inflightOnMarket: true,
      }),
    ).toBe(false);
    expect(
      shouldBlockLiveFlipEnter({
        mode: "flip",
        action: "EXIT",
        stillOpen: true,
        inflightOnMarket: true,
      }),
    ).toBe(false);
  });
});
