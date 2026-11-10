/**
 * Pure tests for the product edit form's vendor helpers — no database.
 * Retired vendors: kept on the product that has them, never newly chosen.
 */
import { describe, expect, it } from "bun:test";
import { vendorIdPatch, vendorOptionsFor } from "@/lib/vendor-options";

const vendors = [
  { id: 1, name: "Alpha", active: true },
  { id: 2, name: "Bravo", active: false },
  { id: 3, name: "Charlie", active: false },
];

describe("vendorOptionsFor", () => {
  it('lists active vendors plus the current retired vendor labelled "(retired)"; other retired vendors are excluded', () => {
    expect(vendorOptionsFor(vendors, 2)).toEqual([
      { id: 1, label: "Alpha" },
      { id: 2, label: "Bravo (retired)" },
    ]);
  });

  it("lists active vendors only when the current vendor is active or absent", () => {
    expect(vendorOptionsFor(vendors, 1)).toEqual([{ id: 1, label: "Alpha" }]);
    expect(vendorOptionsFor(vendors, null)).toEqual([{ id: 1, label: "Alpha" }]);
  });
});

describe("vendorIdPatch", () => {
  it("omits vendorId when unchanged, including an untouched retired vendor", () => {
    expect(vendorIdPatch(2, "2")).toEqual({});
    expect(vendorIdPatch(null, "")).toEqual({});
  });

  it("includes vendorId when changed, and null when cleared", () => {
    expect(vendorIdPatch(2, "1")).toEqual({ vendorId: 1 });
    expect(vendorIdPatch(null, "1")).toEqual({ vendorId: 1 });
    expect(vendorIdPatch(2, "")).toEqual({ vendorId: null });
  });
});
