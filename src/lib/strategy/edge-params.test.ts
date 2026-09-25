import { describe, expect, it } from "vitest";
import { edgeBandFromParams, mergeEdgeBand, netEdgeToPct, parseEdgePct } from "./edge-params";

describe("parseEdgePct", () => {
  it("reads 8% from the dashboard percent field", () => {
    expect(parseEdgePct(8)).toBe(0.08);
    expect(parseEdgePct("12.5")).toBe(0.125);
    expect(parseEdgePct(0.08)).toBe(0.08);
    expect(parseEdgePct(101)).toBeNull();
    expect(parseEdgePct("x")).toBeNull();
  });
});

describe("edgeBandFromParams", () => {
  it("prefers strategy JSON over fallbacks", () => {
    expect(edgeBandFromParams({ minNetEdge: 0.08, maxNetEdge: 1 }, 0.03, 0.08)).toEqual({
      minNetEdge: 0.08,
      maxNetEdge: 1,
    });
  });
});

describe("mergeEdgeBand", () => {
  it("keeps other parameters and lifts max if min is higher", () => {
    const merged = mergeEdgeBand(
      { minVsStart: 0.0005, minNetEdge: 0.03, maxNetEdge: 0.08 },
      { minNetEdge: 0.12 },
    );
    expect(merged.minVsStart).toBe(0.0005);
    expect(merged.minNetEdge).toBe(0.12);
    expect(merged.maxNetEdge).toBe(0.12);
  });
});

describe("netEdgeToPct", () => {
  it("shows 8 for 0.08", () => {
    expect(netEdgeToPct(0.08)).toBe(8);
  });
});
