import { describe, expect, it } from "vitest";
import { closePriceFromRaw, closedExitPrice } from "./exit-price";

describe("closedExitPrice", () => {
  it("is empty while the position is open", () => {
    expect(
      closedExitPrice({
        status: "OPEN",
        rawPayload: { closePrice: 0.7 },
        executions: [{ executedAt: "2026-09-02T00:00:00Z", price: 0.7 }],
      }),
    ).toBeNull();
  });

  it("prefers the stored closePrice from persist", () => {
    expect(
      closedExitPrice({
        status: "CLOSED",
        rawPayload: { closePrice: 0.12 },
        executions: [
          { executedAt: "2026-09-02T01:00:00Z", price: 0.11 },
          { executedAt: "2026-09-02T00:00:00Z", price: 0.4 },
        ],
      }),
    ).toBe(0.12);
  });

  it("uses the latest execution when closePrice was not stored", () => {
    expect(
      closedExitPrice({
        status: "CLOSED",
        executions: [
          { executedAt: "2026-09-02T00:00:00Z", price: 0.4 },
          { executedAt: "2026-09-02T01:00:00Z", price: 0.22 },
        ],
      }),
    ).toBe(0.22);
  });

  it("allows a settlement fill at 0", () => {
    expect(closePriceFromRaw({ closePrice: 0 })).toBe(0);
    expect(
      closedExitPrice({
        status: "CLOSED",
        rawPayload: { expired: true, closePrice: 0 },
        executions: [{ executedAt: "2026-09-02T01:00:00Z", price: 0 }],
      }),
    ).toBe(0);
  });

  it("does not let a later settlement 0 hide a book exit fill", () => {
    expect(
      closedExitPrice({
        status: "CLOSED",
        rawPayload: { expired: true, closePrice: 0 },
        executions: [
          { executedAt: "2026-09-03T16:18:39Z", price: 0.22 },
          { executedAt: "2026-09-03T16:15:42Z", price: 0.14 },
        ],
      }),
    ).toBe(0.22);
  });
});
