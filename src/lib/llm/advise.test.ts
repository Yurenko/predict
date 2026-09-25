import { describe, expect, it } from "vitest";
import {
  candleSide,
  decideEntryAdvice,
  decideHeldAdvice,
  edgeInBand,
  entryAdvicePrompt,
  heldAdvicePrompt,
  heldContractMark,
  isLocalLlmBaseUrl,
  parseLlmAdvice,
} from "./advise";

describe("isLocalLlmBaseUrl", () => {
  it("treats Ollama on localhost as keyless", () => {
    expect(isLocalLlmBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalLlmBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalLlmBaseUrl("https://api.openai.com/v1")).toBe(false);
  });
});

describe("parseLlmAdvice", () => {
  it("reads a JSON object even with extra text", () => {
    expect(parseLlmAdvice('here {"action":"CLOSE","direction":"down","reason":"wick"}')).toEqual({
      action: "CLOSE",
      direction: "down",
      reason: "wick",
    });
    expect(parseLlmAdvice("not json")).toBeNull();
  });
});

describe("heldContractMark", () => {
  it("uses bid for Up and inverted ask for Down", () => {
    expect(heldContractMark({ isDown: false, bestBid: 0.47, bestAsk: 0.49 })).toBe(0.47);
    expect(heldContractMark({ isDown: true, bestBid: 0.47, bestAsk: 0.49 })).toBeCloseTo(0.51);
  });
});

describe("candleSide", () => {
  it("reads up/down from coin open vs now, not from token mark", () => {
    expect(candleSide({ underlyingOpen: 100, underlyingNow: 100.1 })).toBe("up");
    expect(candleSide({ underlyingOpen: 100, underlyingNow: 99.9 })).toBe("down");
    expect(candleSide({ underlyingOpen: 100, underlyingNow: 100.01 })).toBeNull();
  });
});

describe("edgeInBand", () => {
  it("keeps 3–8% and drops the rest", () => {
    expect(edgeInBand(0.03, 0.03, 0.08)).toBe(true);
    expect(edgeInBand(0.05, 0.03, 0.08)).toBe(true);
    expect(edgeInBand(0.08, 0.03, 0.08)).toBe(true);
    expect(edgeInBand(0.02, 0.03, 0.08)).toBe(false);
    expect(edgeInBand(0.12, 0.03, 0.08)).toBe(false);
  });
});

describe("decideEntryAdvice", () => {
  const agree = {
    proposedDown: false,
    underlyingOpen: 100,
    underlyingNow: 100.3,
    netEdge: 0.09,
    edgeMin: 0.08,
    edgeMax: 1,
  };

  it("enters only when signal, candle and LLM all match inside the edge band", () => {
    expect(
      decideEntryAdvice({
        ...agree,
        advice: { action: "ENTER", direction: "up", reason: "signal up candle up" },
      }).allow,
    ).toBe(true);
  });

  it("skips when LLM is missing, skips, or disagrees", () => {
    expect(decideEntryAdvice({ ...agree, advice: null }).allow).toBe(false);
    expect(
      decideEntryAdvice({
        ...agree,
        advice: { action: "SKIP", direction: "up", reason: "wait" },
      }).allow,
    ).toBe(false);
    expect(
      decideEntryAdvice({
        ...agree,
        advice: { action: "ENTER", direction: "down", reason: "wrong token" },
      }).allow,
    ).toBe(false);
  });

  it("skips when netEdge is below 8%", () => {
    expect(
      decideEntryAdvice({
        ...agree,
        netEdge: 0.02,
        advice: { action: "ENTER", direction: "up", reason: "ok" },
      }).allow,
    ).toBe(false);
  });

  it("skips when the signal token disagrees with the candle vs open", () => {
    expect(
      decideEntryAdvice({
        ...agree,
        proposedDown: true,
        advice: { action: "ENTER", direction: "down", reason: "agree" },
      }).reason,
    ).toMatch(/signal down vs candle up/);
  });
});

describe("decideHeldAdvice", () => {
  it("does not close on a still-agreeing candle", () => {
    expect(
      decideHeldAdvice({
        isDown: true,
        underlyingOpen: 100,
        underlyingNow: 99.8,
      }).close,
    ).toBe(false);
  });

  it("closes when the candle has flipped against the held token", () => {
    expect(
      decideHeldAdvice({
        isDown: false,
        underlyingOpen: 100,
        underlyingNow: 99.7,
      }).kind,
    ).toBe("CANDLE_CLOSE");
    expect(
      decideHeldAdvice({
        isDown: true,
        underlyingOpen: 100,
        underlyingNow: 100.3,
      }).kind,
    ).toBe("CANDLE_CLOSE");
  });
});

describe("heldAdvicePrompt", () => {
  it("includes open vs current prices", () => {
    const prompt = heldAdvicePrompt({
      window: "1h",
      heldSide: "Up",
      signalSide: "up",
      candleSide: "up",
      netEdge: 0.05,
      edgeMin: 0.03,
      edgeMax: 0.08,
      contractEntry: 0.13,
      contractMark: 0.47,
      underlyingOpen: 725.4,
      underlyingNow: 728.1,
      timeToExpirySec: 1400,
      return2m: 0.001,
      return5m: 0.002,
      return15m: 0.003,
    });
    expect(prompt).toMatch(/underlyingOpen/);
    expect(prompt).toMatch(/0.13/);
    expect(prompt).toMatch(/0.47/);
    expect(prompt).toMatch(/Confirm or skip/);
    expect(prompt).not.toMatch(/reason":"short"/);
    expect(prompt).not.toMatch(/edge 5pct/);
  });
});

describe("entryAdvicePrompt", () => {
  it("does not seed a conflicting skip example", () => {
    const prompt = entryAdvicePrompt({
      window: "15m",
      signalSide: "Up",
      candleSide: "up",
      netEdge: 0.09,
      edgeMin: 0.08,
      edgeMax: 1,
      ask: 0.44,
      underlyingOpen: 2685.59,
      underlyingNow: 2687.36,
      timeToExpirySec: 240,
      return2m: 0.001,
      return5m: 0.002,
      return15m: 0.003,
    });
    expect(prompt).toMatch(/Confirm or skip/);
    expect(prompt).toMatch(/Copy candleSide/);
    expect(prompt).not.toMatch(/edge 5pct/);
    expect(prompt).not.toMatch(/signal up candle down/);
  });
});
