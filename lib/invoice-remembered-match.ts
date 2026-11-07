/**
 * Review-screen wording for matches the app made from memory (F6).
 *
 * A line is "remembered" when pre-match found a `vendor_alias` for it, keyed
 * by the supplier's item code (`vendor_alias_code`) or, when the invoice
 * prints no code, by the normalised description (`vendor_alias_desc`). Both
 * mean the same thing to the reviewer: the app guessed, they confirm. Keeping
 * the two methods in one predicate stops a screen from labelling only the
 * code-keyed kind and leaving description-keyed matches looking human-made.
 *
 * Pure and dependency-free so it is testable without a browser and safe to
 * import from client code (matching.ts is Node-only because of its hash).
 */

export const REMEMBERED_MATCH_LABEL = "Remembered match";

export const NO_VENDOR_NOTE =
  "Matches on this invoice will not be remembered, because the upload has no vendor.";

const REMEMBERED_METHODS: ReadonlySet<string> = new Set(["vendor_alias_code", "vendor_alias_desc"]);

/**
 * True while the line still carries the product the alias supplied. Once the
 * reviewer picks something else the match is theirs, not remembered, so the
 * chip must go; `currentProductId` is the dropdown's value ("" for none).
 */
export function isRememberedMatch(
  line: { matchMethod: string; matchedProductId: number | null },
  currentProductId: string,
): boolean {
  return (
    REMEMBERED_METHODS.has(line.matchMethod) &&
    line.matchedProductId != null &&
    currentProductId === String(line.matchedProductId)
  );
}

/** The dropdown's option text for a product: "Name — Brand", or just the name. */
export function productOptionLabel(product: { name: string; brand: string | null }): string {
  return product.brand ? `${product.name} — ${product.brand}` : product.name;
}

/**
 * Text for the pill under a line's description, or null when the line is not
 * (or no longer) a remembered match. Names the product so the reviewer can
 * confirm it without scrolling to the Matched product column. Uses the same
 * label as the dropdown option (no size, no cost), and falls back to the bare
 * label when the product is not in the list, never a blank or an id.
 */
export function rememberedMatchText(
  line: { matchMethod: string; matchedProductId: number | null },
  currentProductId: string,
  products: ReadonlyArray<{ id: number; name: string; brand: string | null }>,
): string | null {
  if (!isRememberedMatch(line, currentProductId)) return null;
  const product = products.find((p) => String(p.id) === currentProductId);
  return product ? `${REMEMBERED_MATCH_LABEL}: ${productOptionLabel(product)}` : REMEMBERED_MATCH_LABEL;
}

/** The sentence to show above the lines, or null when matches can be learned. */
export function noVendorNote(invoice: { vendorId: number | null }, editable: boolean): string | null {
  return editable && invoice.vendorId == null ? NO_VENDOR_NOTE : null;
}
