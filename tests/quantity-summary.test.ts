import { describe, test, expect } from "bun:test";
import { describeAddedUnits, describeUnitDelta, UNITS_UNKNOWN } from "@/lib/quantity-summary";

describe("describeAddedUnits", () => {
  test("eaches only, no case size needed", () => {
    expect(describeAddedUnits({ cases: 0, eaches: 3, caseSize: null })).toBe("3 units");
  });

  test("cases multiply by the case size", () => {
    expect(describeAddedUnits({ cases: 2, eaches: 5, caseSize: 24 })).toBe("53 units");
  });

  test("cases of an unknown size are unknown, not 1 each", () => {
    expect(describeAddedUnits({ cases: 2, eaches: 5, caseSize: null })).toBe(UNITS_UNKNOWN);
  });

  test("zero cases of an unknown size is still a known quantity", () => {
    expect(describeAddedUnits({ cases: 0, eaches: 0, caseSize: null })).toBe("0 units");
  });
});

describe("describeUnitDelta", () => {
  test("an unknown delta says so instead of printing +0", () => {
    expect(describeUnitDelta(null)).toBe(UNITS_UNKNOWN);
    expect(describeUnitDelta(null)).not.toContain("+0");
  });

  test("signs a gain and a loss", () => {
    expect(describeUnitDelta(3)).toBe("+3 units");
    expect(describeUnitDelta(-9)).toBe("−9 units");
  });

  test("no change is stated plainly", () => {
    expect(describeUnitDelta(0)).toBe("no change");
  });

  test("fractional units keep display precision, and noise below it is no change", () => {
    expect(describeUnitDelta(0.5)).toBe("+0.5 units");
    expect(describeUnitDelta(-1.25)).toBe("−1.25 units");
    expect(describeUnitDelta(0.001)).toBe("no change");
  });
});
