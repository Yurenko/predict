import { describe, expect, it } from "vitest";
import { parsePaperEntryMode, shouldSkipPeerEnter } from "./entry-mode";

describe("paper entry mode", () => {
  it("parses all vs single", () => {
    expect(parsePaperEntryMode("all")).toBe("all");
    expect(parsePaperEntryMode("single")).toBe("single");
    expect(parsePaperEntryMode("nope")).toBeNull();
  });

  it("skips a peer ENTER only in single mode", () => {
    expect(shouldSkipPeerEnter("single", "ENTER", true)).toBe(true);
    expect(shouldSkipPeerEnter("all", "ENTER", true)).toBe(false);
    expect(shouldSkipPeerEnter("single", "EXIT", true)).toBe(false);
  });
});
