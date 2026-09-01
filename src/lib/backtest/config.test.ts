import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseBacktestConfig } from "./config";

describe("parseBacktestConfig", () => {
  it("loads the example file without inventing a fee", () => {
    const raw = JSON.parse(
      readFileSync("configs/backtest.example.json", "utf8"),
    ) as unknown;
    const config = parseBacktestConfig(raw);
    expect(config.strategy).toBe("mean-reversion");
    expect(config.costs.fallbackFeeRateBps).toBeNull();
    expect(config.walkForward).toBe(false);
  });
});
