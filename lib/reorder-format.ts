/**
 * Pure plain-text formatter for a vendor's reorder order (spec §9.3, Gate 4
 * slice 6). Dependency-free like `lib/pack-level.ts` — no React, no
 * database — so it is directly unit-testable and importable from the client
 * component that puts this text on the clipboard or in the print DOM.
 *
 * Risk 8 (`02-architecture.md`): a vendor block's props are captured at the
 * last server render. An order copied from a tab left open since before the
 * day's count closed carries yesterday's on-hand numbers with nothing on
 * screen distinguishing it from a fresh one. This module's job is narrow but
 * load-bearing: the as-of count id and close date go in the text itself, so
 * a stale copy is at least labeled, never anonymous — and a *missing* close
 * date (an as-of count with `closedAt` somehow null) is labeled too, rather
 * than silently dropping that half of the line.
 */

export interface ReorderTextItem {
  productName: string;
  suggestedOrderQty: number;
}

export interface ReorderTextInput {
  vendorName: string;
  asOfCountId: number;
  /**
   * ISO date string, already formatted by the caller — this module stays
   * dependency-free (no date library), same rule as `lib/pack-level.ts`.
   * `null` means the as-of count has no recorded close date; labeled
   * explicitly below rather than omitted (Risk 8).
   */
  asOfClosedAt: string | null;
  items: ReorderTextItem[];
}

const UNKNOWN_DATE_LABEL = "close date unknown";

/** Risk 8: a stale copy must be labeled, not silently missing its date. */
export function formatReorderOrderText(input: ReorderTextInput): string {
  const { vendorName, asOfCountId, asOfClosedAt, items } = input;

  const lines: string[] = [
    `Order — ${vendorName}`,
    `Truestock · Count #${asOfCountId} · ${asOfClosedAt ?? UNKNOWN_DATE_LABEL}`,
    "",
  ];

  if (items.length === 0) {
    lines.push("(nothing below par for this vendor)");
  } else {
    // Right-align quantities with a dot-fill, same convention as the Gate 1
    // mockup (docs/plans/phase-1-to-1.5/mockups/reorder-output.html) — a
    // fixed-width monospace column would drift with a longer name and read
    // as broken formatting rather than an aligned list.
    const longest = Math.max(...items.map((item) => item.productName.length));
    for (const item of items) {
      const dots = ".".repeat(Math.max(longest - item.productName.length + 3, 3));
      lines.push(`${item.productName} ${dots} ${item.suggestedOrderQty}`);
    }
  }

  lines.push("");
  lines.push(`${items.length} ${items.length === 1 ? "item" : "items"}`);

  return lines.join("\n");
}
