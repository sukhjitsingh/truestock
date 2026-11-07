import { describe, expect, test } from "bun:test";
import { bannerText, rangeFailureView, validateRange } from "@/lib/audit-packet-range";

const TODAY = "2026-11-06";

describe("validateRange", () => {
  test("accepts a valid range", () => {
    expect(validateRange("2026-10-01", "2026-10-31", TODAY)).toBeNull();
  });
  test("names each failure", () => {
    expect(validateRange("", "2026-10-31", TODAY)).toBe("Choose both a start and end date.");
    expect(validateRange("2026-11-02", "2026-11-01", TODAY)).toBe("End date must be on or after the start date.");
    expect(validateRange("2026-11-01", "2026-11-07", TODAY)).toBe("End date cannot be in the future.");
  });
});

describe("rangeFailureView: the end-date message shows once", () => {
  test("a failed range puts the message under the field and not in the banner", () => {
    const v = rangeFailureView("2026-11-01", "2026-11-07", TODAY)!;
    expect(v.fieldErrors.dateTo).toBe("End date cannot be in the future.");
    expect(v.banner).toBeNull();
  });
  test("a valid range yields no failure", () => {
    expect(rangeFailureView("2026-10-01", "2026-10-31", TODAY)).toBeNull();
  });
});

describe("bannerText", () => {
  test("hides a banner that repeats a field error", () => {
    expect(bannerText("X", { dateTo: "X" })).toBeNull();
  });
  test("keeps a banner no field shows", () => {
    expect(bannerText("Server down", { dateTo: "X" })).toBe("Server down");
    expect(bannerText("Server down", {})).toBe("Server down");
    expect(bannerText(null, {})).toBeNull();
  });
});
