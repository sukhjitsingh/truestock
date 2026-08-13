/**
 * Pure unit tests for `lib/reorder-format.ts` — no database, no fixtures.
 * Matches the test plan in `docs/plans/phase-1-to-1.5/03-program-design.md`
 * ("### `tests/reorder-format.test.ts` (new, pure — no database)").
 */
import { describe, expect, it } from "bun:test";
import { formatReorderOrderText } from "@/lib/reorder-format";

describe("formatReorderOrderText", () => {
  it("includes the vendor name, the as-of count id and close date, and one line per item with its suggested quantity", () => {
    const text = formatReorderOrderText({
      vendorName: "Southern Glazer's",
      asOfCountId: 1246799,
      asOfClosedAt: "Aug 11, 2026",
      items: [
        { productName: "Tito's Handmade Vodka", suggestedOrderQty: 4 },
        { productName: "Bombay Sapphire Gin", suggestedOrderQty: 3 },
      ],
    });

    expect(text).toContain("Southern Glazer's");
    expect(text).toContain("Count #1246799");
    expect(text).toContain("Aug 11, 2026");

    const lines = text.split("\n");
    expect(lines.some((l) => l.includes("Tito's Handmade Vodka") && l.trim().endsWith("4"))).toBe(
      true,
    );
    expect(
      lines.some((l) => l.includes("Bombay Sapphire Gin") && l.trim().endsWith("3")),
    ).toBe(true);
    expect(text).toContain("2 items");
  });

  it("labels a null asOfClosedAt distinctly rather than omitting the date silently", () => {
    const withDate = formatReorderOrderText({
      vendorName: "Breakthru Beverage",
      asOfCountId: 42,
      asOfClosedAt: "Aug 11, 2026",
      items: [{ productName: "Coors Light", suggestedOrderQty: 7 }],
    });
    const withoutDate = formatReorderOrderText({
      vendorName: "Breakthru Beverage",
      asOfCountId: 42,
      asOfClosedAt: null,
      items: [{ productName: "Coors Light", suggestedOrderQty: 7 }],
    });

    // Not merely "different text" — the null case must carry an explicit
    // label, not just a dangling separator where the date would have been
    // (e.g. "Count #42 · " with nothing after it).
    expect(withoutDate).toContain("close date unknown");
    expect(withoutDate).not.toContain("·  \n");
    expect(withoutDate).not.toBe(withDate);
    expect(withoutDate).not.toContain("Aug 11, 2026");
  });

  it("an empty items array still produces a labeled, non-empty block", () => {
    const text = formatReorderOrderText({
      vendorName: "No Orders Vendor",
      asOfCountId: 7,
      asOfClosedAt: "Aug 11, 2026",
      items: [],
    });

    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("No Orders Vendor");
    expect(text).toContain("Count #7");
    expect(text).toContain("0 items");
  });
});
