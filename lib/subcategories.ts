/**
 * The subcategory vocabulary, per category.
 *
 * `product.subcategory` is a free-text column, not an enum, and it is
 * populated by the seed from `docs/catalog/products.csv`. That made it a
 * write-once field in practice: the seed set it, no screen in the app could,
 * and so every product enrolled by scanning a barcode had — and kept — a null
 * subcategory forever. This list is what gives the desk a way to set one, and
 * it is derived from the catalog rather than invented:
 *
 *   awk -F, 'NR>1 {print $3"|"$4}' docs/catalog/products.csv | sort -u
 *
 * **Keep it in step with that file rather than growing it speculatively.** The
 * catalog is the founding bar's real stock list; a subcategory nothing is
 * filed under is a filter pill that always returns an empty table. Adding one
 * is fine when the bar actually starts carrying the thing — inventing five in
 * advance is how a filter bar stops being trustworthy.
 *
 * The column stays free-text on purpose. Making it an enum would turn every
 * new spirit type into a migration, and the seed — which is the authority on
 * what this bar stocks — would then be able to write a value the schema
 * rejects. This list constrains the UI, not the data.
 */
export const SUBCATEGORIES_BY_CATEGORY: Record<string, readonly string[]> = {
  Spirits: ["Whiskey", "Vodka", "Tequila", "Gin", "Rum", "Brandy"],
  Beer: ["Bottle", "Draft", "Cider"],
  Wine: ["Varietal"],
  Liqueur: ["Liqueur"],
  NA: ["NA Beer"],
};

/**
 * Options for a category's subcategory select, including any value the product
 * already carries.
 *
 * The second argument is what stops this from being destructive. A product
 * seeded with a subcategory outside the list above — or one added to the CSV
 * later — must not silently lose it because the select had no matching
 * `<option>` and fell back to the first one. Passing the current value in
 * guarantees the control can always represent what is stored, which is the
 * same rule the size select follows with its "Other…" escape hatch.
 */
export function subcategoryOptions(
  category: string,
  current?: string | null,
): readonly string[] {
  const base = SUBCATEGORIES_BY_CATEGORY[category] ?? [];
  if (current && !base.includes(current)) return [...base, current];
  return base;
}
