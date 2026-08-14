/**
 * `lib/subcategories.ts` — the subcategory vocabulary the catalog UI offers.
 *
 * The interesting test here is the drift one. `subcategory` is free text in
 * the schema and the seed is its real authority; this list only constrains the
 * UI. That means the two can diverge silently in the direction that matters
 * most: the seed files 11 tequilas, the list forgets "Tequila", and the desk
 * simply has no way to file the twelfth. Nothing errors, no test fails, and
 * the filter bar quietly stops being able to describe the bar's own stock.
 *
 * So this asserts the containment that actually protects the user — every
 * (category, subcategory) pair the catalog uses is offerable — rather than
 * equality. The list is allowed to run ahead of the CSV; it is not allowed to
 * fall behind it. That is the same shape as the keg-default lesson in
 * AGENTS.md: derive the default from the seed catalog and assert it, so the
 * two cannot drift apart without something going red.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parseCsv } from "@/db/csv";
import { SUBCATEGORIES_BY_CATEGORY, subcategoryOptions } from "@/lib/subcategories";

const rows = parseCsv(readFileSync("docs/catalog/products.csv", "utf8"));

describe("the vocabulary covers the seed catalog", () => {
  it("offers every (category, subcategory) pair the catalog actually uses", () => {
    const pairs = new Set(
      rows
        .filter((r) => r.subcategory?.trim())
        .map((r) => `${r.category.trim()}|${r.subcategory.trim()}`),
    );

    // Guards against the CSV losing its subcategory column entirely and this
    // test passing on an empty set.
    expect(pairs.size).toBeGreaterThan(5);

    const unofferable = [...pairs].filter((pair) => {
      const [category, subcategory] = pair.split("|");
      return !(SUBCATEGORIES_BY_CATEGORY[category] ?? []).includes(subcategory);
    });

    expect(unofferable).toEqual([]);
  });

  it("names a category for every category in the catalog", () => {
    const categories = new Set(rows.map((r) => r.category.trim()).filter(Boolean));
    const uncovered = [...categories].filter((c) => !(c in SUBCATEGORIES_BY_CATEGORY));
    expect(uncovered).toEqual([]);
  });
});

describe("subcategoryOptions", () => {
  it("returns the category's list", () => {
    expect(subcategoryOptions("Beer")).toEqual(["Bottle", "Draft", "Cider"]);
  });

  it("returns an empty list for a category it does not know, rather than throwing", () => {
    expect(subcategoryOptions("Mixers")).toEqual([]);
  });

  it("appends a stored value the list does not contain, so a select can never drop it", () => {
    // The destructive case: a product seeded with a subcategory outside the
    // list would otherwise have no matching <option>, the select would fall
    // back to its first entry, and the next save would overwrite a real value
    // with a wrong one — with nothing on screen looking edited.
    expect(subcategoryOptions("Spirits", "Mezcal")).toEqual([
      "Whiskey",
      "Vodka",
      "Tequila",
      "Gin",
      "Rum",
      "Brandy",
      "Mezcal",
    ]);
    expect(subcategoryOptions("Mixers", "Tonic")).toEqual(["Tonic"]);
  });

  it("does not duplicate a stored value the list already contains", () => {
    expect(subcategoryOptions("Beer", "Draft")).toEqual(["Bottle", "Draft", "Cider"]);
  });

  it("ignores a null or empty current value", () => {
    expect(subcategoryOptions("Wine", null)).toEqual(["Varietal"]);
    expect(subcategoryOptions("Wine", "")).toEqual(["Varietal"]);
  });
});
