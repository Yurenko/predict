import { describe, expect, it } from "vitest";
import { clearLiveFlatten, isLiveFlattening, stampLiveFlatten, stampLiveVenueFlat } from "./flatten";

describe("live flatten flag", () => {
  it("marks a submitted EXIT so the next cycle sells leftover shares", () => {
    const stamped = stampLiveFlatten({ closePrice: 0.04 });
    expect(isLiveFlattening(stamped)).toBe(true);
    expect(stamped.closePrice).toBe(0.04);
    expect(isLiveFlattening(clearLiveFlatten(stamped))).toBe(false);
  });

  it("marks a venue-flat leftover as dust without closing the row", () => {
    const stamped = stampLiveVenueFlat({ liveFlatten: true });
    expect(stamped.liveDust).toBe(true);
    expect(stamped.venueSharesGone).toBe(true);
    expect(clearLiveFlatten(stamped).liveDust).toBeUndefined();
  });
});
