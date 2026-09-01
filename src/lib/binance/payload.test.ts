import { describe, expect, it } from "vitest";
import { payloadHash, parseObservedAt, validateTimestamp } from "./payload";

describe("payload helpers", () => {
  it("hashes bigint-safe JSON stably", () => {
    const a = payloadHash({ id: 1n, nested: { ok: true } });
    const b = payloadHash({ id: 1n, nested: { ok: true } });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("rejects timestamps too far in the future", () => {
    const future = new Date(Date.now() + 60_000);
    expect(validateTimestamp(future)).toBeNull();
    expect(parseObservedAt(future.getTime())).toBeNull();
  });

  it("accepts millisecond event times", () => {
    const now = Date.now();
    const parsed = parseObservedAt(now);
    expect(parsed?.getTime()).toBe(now);
  });
});
