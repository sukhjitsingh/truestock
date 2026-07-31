/**
 * The one definition of "is this product counted by the case?".
 *
 * Shared rather than local because it is now asked in two places with
 * opposite consequences, and CLAUDE.md is emphatic that only bottled beer is
 * counted both ways:
 *
 *  - `incompleteReasons` (lib/domain/catalog.ts) uses it to decide whether a
 *    missing `case_size` is a gap or is simply correct. A NULL case size on a
 *    spirit, wine or keg is right, not missing data.
 *  - The barcode-link screen (components/count/enroll-form.tsx) uses it to
 *    decide whether to ask each-or-case when binding a scanned code. A bottle
 *    and its case carton carry different codes, and binding a carton's code
 *    as `each` silently miscounts every later scan of it by the case size.
 *
 * Two copies of this rule would be two ideas of what a case is, which is the
 * exact drift `incompleteReasons`' own doc comment warns about. This module
 * is deliberately dependency-free so a client component can import it without
 * dragging in the database.
 *
 * Note it keys off category and unit type, NOT off `case_size` being set.
 * That matters right now: no product has a case size yet (open item 4), so a
 * `caseSize != null` test would answer "no" for all 16 bottled beers — the
 * only products the question is actually about.
 */
export function isCountedByCase(p: {
  category: string;
  unitType: string;
}): boolean {
  // A keg is one unit measured in tenths and never has a case size, even
  // though its category is Beer.
  return p.category.toLowerCase() === "beer" && p.unitType !== "keg";
}
