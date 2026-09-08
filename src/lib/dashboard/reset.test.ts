import { describe, expect, it } from "vitest";
import { TradingMode } from "@prisma/client";
import { riskModeAfterLedgerReset } from "./reset";

describe("riskModeAfterLedgerReset", () => {
  it("keeps LIVE risk after clearing the live ledger", () => {
    expect(riskModeAfterLedgerReset(true)).toBe(TradingMode.LIVE);
  });

  it("keeps PAPER risk after clearing the paper ledger", () => {
    expect(riskModeAfterLedgerReset(false)).toBe(TradingMode.PAPER);
  });
});
