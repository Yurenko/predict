import { describe, expect, it } from "vitest";
import { MinIntervalLimiter } from "./rate-limit";

describe("MinIntervalLimiter", () => {
  it("spaces calls by the configured interval", async () => {
    const limiter = new MinIntervalLimiter(80);
    const started = Date.now();
    await limiter.wait();
    await limiter.wait();
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });
});
