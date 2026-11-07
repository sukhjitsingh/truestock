import { describe, expect, test } from "bun:test";
import { isRememberedMatch, noVendorNote, NO_VENDOR_NOTE } from "@/lib/invoice-remembered-match";

describe("isRememberedMatch", () => {
  test("an item-code alias match counts as remembered", () => {
    expect(isRememberedMatch({ matchMethod: "vendor_alias_code", matchedProductId: 7 }, "7")).toBe(true);
  });
  test("a description alias match counts the same way", () => {
    expect(isRememberedMatch({ matchMethod: "vendor_alias_desc", matchedProductId: 7 }, "7")).toBe(true);
  });
  test("a reviewer's own pick is not remembered", () => {
    expect(isRememberedMatch({ matchMethod: "manual", matchedProductId: 7 }, "7")).toBe(false);
    expect(isRememberedMatch({ matchMethod: "unmatched", matchedProductId: null }, "")).toBe(false);
  });
  test("changing or clearing the product drops the chip", () => {
    expect(isRememberedMatch({ matchMethod: "vendor_alias_desc", matchedProductId: 7 }, "9")).toBe(false);
    expect(isRememberedMatch({ matchMethod: "vendor_alias_code", matchedProductId: 7 }, "")).toBe(false);
  });
});

describe("noVendorNote", () => {
  test("shown for an editable invoice with no vendor", () => {
    expect(noVendorNote({ vendorId: null }, true)).toBe(NO_VENDOR_NOTE);
  });
  test("hidden when a vendor is set or the form is read-only", () => {
    expect(noVendorNote({ vendorId: 3 }, true)).toBeNull();
    expect(noVendorNote({ vendorId: null }, false)).toBeNull();
  });
});
