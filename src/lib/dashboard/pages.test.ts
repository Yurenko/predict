import { describe, expect, it } from "vitest";
import { ledgerPageCount, ledgerSkip, parseLedgerPage, parseLedgerPageSize } from "./pages";

describe("ledger pages", () => {
  it("parses and clamps page indexes", () => {
    expect(parseLedgerPage(null)).toBe(1);
    expect(parseLedgerPage("0")).toBe(1);
    expect(parseLedgerPage("3")).toBe(3);
    expect(parseLedgerPageSize("500")).toBe(100);
    expect(ledgerSkip(3, 25)).toBe(50);
    expect(ledgerPageCount(23, 25)).toBe(1);
    expect(ledgerPageCount(26, 25)).toBe(2);
  });
});
