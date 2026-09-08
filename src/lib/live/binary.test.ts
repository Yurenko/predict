import { OrderSide } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  binaryOrderSide,
  decideLiveBinaryAction,
  invertBinaryBook,
  invertBinaryPrice,
  paperActionFromBinary,
  resolveBinaryWorkerTrade,
  resolveLiveBinaryTarget,
} from "./binary";

const outcomes = [
  { id: "up-row", tokenId: "up-1", name: "Up" },
  { id: "down-row", tokenId: "down-1", name: "Down" },
];

const liveTrade = {
  oppositeCloses: false as const,
  primaryTokenId: "up-1",
  primaryOutcomeId: "up-row",
  outcomes,
};

describe("decideLiveBinaryAction", () => {
  it("opens Down as BUY Down, not a naked SELL of Up", () => {
    expect(
      decideLiveBinaryAction({ direction: "SELL", hasOpen: false, openOutcomeName: null }),
    ).toBe("ENTER_DOWN");
    expect(
      decideLiveBinaryAction({ direction: "BUY", hasOpen: false, openOutcomeName: null }),
    ).toBe("ENTER_UP");
  });

  it("PAPER: exits Up before flipping to Down", () => {
    expect(
      decideLiveBinaryAction({
        direction: "SELL",
        hasOpen: true,
        openOutcomeName: "Up",
      }),
    ).toBe("EXIT");
    expect(
      decideLiveBinaryAction({
        direction: "BUY",
        hasOpen: true,
        openOutcomeName: "Down",
      }),
    ).toBe("EXIT");
  });

  it("LIVE: SELL opens Down beside an existing Up; only EXIT closes Up", () => {
    expect(
      decideLiveBinaryAction({
        direction: "SELL",
        hasOpenUp: true,
        hasOpenDown: false,
        oppositeCloses: false,
      }),
    ).toBe("ENTER_DOWN");
    expect(
      decideLiveBinaryAction({
        direction: "BUY",
        hasOpenUp: true,
        hasOpenDown: false,
        oppositeCloses: false,
      }),
    ).toBe("HOLD");
    expect(
      decideLiveBinaryAction({
        direction: "EXIT",
        hasOpenUp: true,
        hasOpenDown: false,
        oppositeCloses: false,
      }),
    ).toBe("EXIT");
  });

  it("LIVE: BUY opens Up beside an existing Down; extra SELL is skipped", () => {
    expect(
      decideLiveBinaryAction({
        direction: "BUY",
        hasOpenUp: false,
        hasOpenDown: true,
        oppositeCloses: false,
      }),
    ).toBe("ENTER_UP");
    expect(
      decideLiveBinaryAction({
        direction: "SELL",
        hasOpenUp: false,
        hasOpenDown: true,
        oppositeCloses: false,
      }),
    ).toBe("HOLD");
    expect(
      decideLiveBinaryAction({
        direction: "EXIT",
        hasOpenUp: false,
        hasOpenDown: true,
        oppositeCloses: false,
      }),
    ).toBe("EXIT");
  });

  it("holds when already on the wanted token", () => {
    expect(
      decideLiveBinaryAction({
        direction: "BUY",
        hasOpen: true,
        openOutcomeName: "Yes",
      }),
    ).toBe("HOLD");
    expect(
      decideLiveBinaryAction({
        direction: "SELL",
        hasOpen: true,
        openOutcomeName: "No",
      }),
    ).toBe("HOLD");
  });
});

describe("invertBinaryBook", () => {
  it("maps Down bid/ask from the Up book", () => {
    expect(invertBinaryPrice(0.4)).toBeCloseTo(0.6);
    const inverted = invertBinaryBook({ bestBid: 0.46, bestAsk: 0.48, lastPrice: 0.47 });
    expect(inverted.bestBid).toBeCloseTo(0.52);
    expect(inverted.bestAsk).toBeCloseTo(0.54);
    expect(inverted.lastPrice).toBeCloseTo(0.53);
  });
});

describe("resolveLiveBinaryTarget", () => {
  it("buys the Down token on ENTER_DOWN", () => {
    expect(
      resolveLiveBinaryTarget({
        action: "ENTER_DOWN",
        primaryTokenId: "up-1",
        primaryOutcomeId: "up-row",
        outcomes,
      }),
    ).toEqual({ tokenId: "down-1", outcomeId: "down-row", invertBook: true });
  });

  it("sells the held token on EXIT", () => {
    expect(
      resolveLiveBinaryTarget({
        action: "EXIT",
        primaryTokenId: "up-1",
        outcomes,
        openTokenId: "down-1",
      }),
    ).toEqual({ tokenId: "down-1", outcomeId: "down-row", invertBook: true });
  });
});

describe("resolveBinaryWorkerTrade", () => {
  it("turns a SELL signal into BUY Down with no open position", () => {
    const trade = resolveBinaryWorkerTrade({
      direction: "SELL",
      hasOpen: false,
      primaryTokenId: "up-1",
      primaryOutcomeId: "up-row",
      outcomes,
    });
    expect(trade).toMatchObject({
      binary: "ENTER_DOWN",
      paperAction: "ENTER",
      tokenId: "down-1",
      invertBook: true,
      orderSide: OrderSide.BUY,
    });
    expect(paperActionFromBinary("ENTER_DOWN")).toBe("ENTER");
    expect(binaryOrderSide("ENTER_DOWN")).toBe(OrderSide.BUY);
    expect(binaryOrderSide("EXIT")).toBe(OrderSide.SELL);
  });

  it("does not EXIT when this strategy has no position (other strategies may still be in the market)", () => {
    expect(
      resolveBinaryWorkerTrade({
        direction: "EXIT",
        hasOpen: false,
        primaryTokenId: "up-1",
        primaryOutcomeId: "up-row",
        outcomes,
      }),
    ).toBeNull();
  });

  it("flip: SELL closes Up first; Down waits until that leg is gone", () => {
    const closing = resolveBinaryWorkerTrade({
      direction: "SELL",
      hasOpenUp: true,
      hasOpenDown: false,
      openUpTokenId: "up-1",
      oppositeCloses: true,
      primaryTokenId: "up-1",
      primaryOutcomeId: "up-row",
      outcomes,
    });
    expect(closing).toMatchObject({
      binary: "EXIT",
      paperAction: "EXIT",
      tokenId: "up-1",
      orderSide: OrderSide.SELL,
    });
    const opening = resolveBinaryWorkerTrade({
      direction: "SELL",
      hasOpenUp: false,
      hasOpenDown: false,
      oppositeCloses: true,
      primaryTokenId: "up-1",
      primaryOutcomeId: "up-row",
      outcomes,
    });
    expect(opening).toMatchObject({
      binary: "ENTER_DOWN",
      paperAction: "ENTER",
      tokenId: "down-1",
      orderSide: OrderSide.BUY,
    });
  });

  it("LIVE: SELL does not reduce an Up stack; it can open Down", () => {
    const trade = resolveBinaryWorkerTrade({
      ...liveTrade,
      direction: "SELL",
      hasOpenUp: true,
      hasOpenDown: false,
      openUpTokenId: "up-1",
    });
    expect(trade).toMatchObject({
      binary: "ENTER_DOWN",
      paperAction: "ENTER",
      tokenId: "down-1",
      orderSide: OrderSide.BUY,
    });
  });

  it("LIVE: EXIT sells the full Up stack, not a Down entry", () => {
    const trade = resolveBinaryWorkerTrade({
      ...liveTrade,
      direction: "EXIT",
      hasOpenUp: true,
      hasOpenDown: true,
      openUpTokenId: "up-1",
      openDownTokenId: "down-1",
    });
    expect(trade).toMatchObject({
      binary: "EXIT",
      paperAction: "EXIT",
      tokenId: "up-1",
      orderSide: OrderSide.SELL,
    });
  });

  it("LIVE: BUY does not flatten leftover Up shares", () => {
    expect(
      resolveBinaryWorkerTrade({
        ...liveTrade,
        direction: "BUY",
        hasOpenUp: true,
        hasOpenDown: false,
        openUpTokenId: "up-1",
      }),
    ).toBeNull();
  });
});
