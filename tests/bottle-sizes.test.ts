/**
 * The `size_ml` preset lists.
 *
 * Pure functions, no database — but the last block here is the one that
 * matters. A preset list is a *closed* list, and the count leg has no
 * "Other…" escape, so dropping or renumbering an entry does not fail loudly:
 * it quietly makes some existing product unrepresentable in the form that
 * enrolls it. The seed catalog is the only inventory of what is really in the
 * bar, so it is read from disk and every size in it is asserted against the
 * list its own category+unit type resolves to. That test is the guard; the
 * rest is the rule it guards.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SPIRITS_SIZES,
  BEER_SIZES,
  WINE_SIZES,
  KEG_SIZES,
  bottleSizesFor,
  defaultSizeMlFor,
  isPresetSizeMl,
  type BottleSize,
  type SizeContext,
} from "@/lib/bottle-sizes";

const mls = (list: readonly BottleSize[]) => list.map((s) => s.ml);

// ---------------------------------------------------------------------------
// Which list each category gets
// ---------------------------------------------------------------------------

describe("bottleSizesFor", () => {
  test("Spirits gets the spirits list", () => {
    expect(bottleSizesFor({ category: "Spirits", unitType: "bottle" })).toBe(SPIRITS_SIZES);
    expect(mls(SPIRITS_SIZES)).toEqual([50, 200, 375, 500, 700, 750, 1000, 1750]);
  });

  test("Liqueur gets the spirits list — same bottles", () => {
    expect(bottleSizesFor({ category: "Liqueur", unitType: "bottle" })).toBe(SPIRITS_SIZES);
  });

  test("Beer gets the beer list", () => {
    expect(bottleSizesFor({ category: "Beer", unitType: "bottle" })).toBe(BEER_SIZES);
    expect(mls(BEER_SIZES)).toEqual([222, 330, 355, 473, 650, 740]);
  });

  test("Wine gets the wine list", () => {
    expect(bottleSizesFor({ category: "Wine", unitType: "bottle" })).toBe(WINE_SIZES);
    expect(mls(WINE_SIZES)).toEqual([187, 375, 750, 1500]);
  });

  test("NA gets the BEER list, and 355 is in it", () => {
    // The specific orphan this decision avoids: all three seeded NA products
    // are 355 ml cans, and 355 is not a spirits size. On the spirits list they
    // would be unenterable on the phone, which has no "Other…".
    expect(bottleSizesFor({ category: "NA", unitType: "can" })).toBe(BEER_SIZES);
    expect(isPresetSizeMl(355, { category: "NA", unitType: "can" })).toBe(true);
    expect(isPresetSizeMl(355, { category: "Spirits", unitType: "bottle" })).toBe(false);
  });

  test("a keg gets keg sizes even when the category says Spirits", () => {
    // Unit type wins over category. Beer is the category that really has kegs,
    // so a Spirits keg is the case that proves the precedence rather than the
    // coincidence.
    expect(bottleSizesFor({ category: "Spirits", unitType: "keg" })).toBe(KEG_SIZES);
    expect(bottleSizesFor({ category: "Beer", unitType: "keg" })).toBe(KEG_SIZES);
    expect(mls(KEG_SIZES)).toEqual([19533, 29337, 58674]);
  });

  test("category matching is case-insensitive", () => {
    // Nothing enforces the casing — the CSV and the <Select>s agree by
    // convention only, and an import or a hand-edited row can disagree.
    for (const c of ["spirits", "SPIRITS", "SpIrItS"]) {
      expect(bottleSizesFor({ category: c, unitType: "bottle" })).toBe(SPIRITS_SIZES);
    }
    for (const c of ["beer", "BEER"]) {
      expect(bottleSizesFor({ category: c, unitType: "bottle" })).toBe(BEER_SIZES);
    }
    for (const c of ["na", "nA"]) {
      expect(bottleSizesFor({ category: c, unitType: "can" })).toBe(BEER_SIZES);
    }
    for (const c of ["wine", "WINE"]) {
      expect(bottleSizesFor({ category: c, unitType: "bottle" })).toBe(WINE_SIZES);
    }
    for (const c of ["liqueur", "LIQUEUR"]) {
      expect(bottleSizesFor({ category: c, unitType: "bottle" })).toBe(SPIRITS_SIZES);
    }
  });

  test("an unknown category falls back to a non-empty list", () => {
    // An empty dropdown is an unfillable required field, which would strand
    // the enroll form mid-count with no way forward.
    for (const c of ["Cider", "", "seltzer", "Mixer"]) {
      const list = bottleSizesFor({ category: c, unitType: "bottle" });
      expect(list.length).toBeGreaterThan(0);
      expect(list).toBe(SPIRITS_SIZES);
    }
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("defaultSizeMlFor", () => {
  test("each category defaults to the owner's stated size", () => {
    expect(defaultSizeMlFor({ category: "Spirits", unitType: "bottle" })).toBe(750);
    expect(defaultSizeMlFor({ category: "Liqueur", unitType: "bottle" })).toBe(750);
    expect(defaultSizeMlFor({ category: "Beer", unitType: "bottle" })).toBe(355);
    expect(defaultSizeMlFor({ category: "NA", unitType: "can" })).toBe(355);
    expect(defaultSizeMlFor({ category: "Wine", unitType: "bottle" })).toBe(750);
    // The keg default is NOT pinned here — it is chosen from what the bar
    // actually stocks, not from an owner-stated constant, so it is asserted
    // against the seed catalog's modal keg size below instead.
  });

  test("every default is itself a preset of its own list", () => {
    // A default outside its list would render a dropdown with nothing
    // selected on a required field — the form would look filled in and submit
    // nothing.
    const contexts: SizeContext[] = [
      { category: "Spirits", unitType: "bottle" },
      { category: "Liqueur", unitType: "bottle" },
      { category: "Beer", unitType: "bottle" },
      { category: "NA", unitType: "can" },
      { category: "Wine", unitType: "bottle" },
      { category: "Beer", unitType: "keg" },
      { category: "Unknown", unitType: "bottle" },
    ];
    for (const c of contexts) {
      expect(isPresetSizeMl(defaultSizeMlFor(c), c)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Values are integer millilitres, and labels are distinguishable
// ---------------------------------------------------------------------------

describe("the lists themselves", () => {
  const all = [SPIRITS_SIZES, BEER_SIZES, WINE_SIZES, KEG_SIZES];

  test("every value is a positive integer — the column is int(size_ml)", () => {
    for (const list of all) {
      for (const s of list) {
        expect(Number.isInteger(s.ml)).toBe(true);
        expect(s.ml).toBeGreaterThan(0);
      }
    }
  });

  test("no list repeats a value or a label", () => {
    // A duplicate ml would give a <select> two options with the same value,
    // one of which can never be chosen back.
    for (const list of all) {
      expect(new Set(list.map((s) => s.ml)).size).toBe(list.length);
      expect(new Set(list.map((s) => s.label)).size).toBe(list.length);
    }
  });
});

// ---------------------------------------------------------------------------
// The guard: no preset edit may orphan a product that already exists
// ---------------------------------------------------------------------------

describe("the seed catalog", () => {
  /**
   * Parsed by hand rather than through db/seed.ts's `readCsv`, which would
   * pull the database into a pure test. The file has no quoted fields — the
   * header-count assertion below is what notices if that ever stops being
   * true and this naive split starts producing wrong columns.
   */
  function readProducts(): { name: string; category: string; unitType: string; sizeMl: number }[] {
    const path = join(import.meta.dir, "..", "docs", "catalog", "products.csv");
    const raw = readFileSync(path, "utf-8");
    // The precondition for splitting on bare commas. If a quoted field ever
    // lands in this file, fail here rather than silently reading shifted
    // columns and reporting a catalog that does not exist.
    expect(raw).not.toContain('"');

    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const header = lines[0]!.split(",");
    const col = (n: string) => {
      const i = header.indexOf(n);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const [iName, iCat, iUnit, iSize] = [
      col("name"),
      col("category"),
      col("unit_type"),
      col("size_ml"),
    ];

    return lines.slice(1).map((line) => {
      const f = line.split(",");
      expect(f.length).toBe(header.length);
      return {
        name: f[iName]!,
        category: f[iCat]!,
        unitType: f[iUnit]!,
        sizeMl: Number(f[iSize]),
      };
    });
  }

  const products = readProducts();

  test("reads all 97 seeded products", () => {
    // If this number moves, the assertion below is covering a different
    // catalog than the one CLAUDE.md describes and should be re-read, not
    // re-numbered.
    expect(products.length).toBe(97);
  });

  test("every seeded size is a preset for its own category and unit type", () => {
    const orphans = products.filter((p) => !isPresetSizeMl(p.sizeMl, p));
    expect(orphans.map((p) => `${p.name} (${p.category}/${p.unitType}/${p.sizeMl})`)).toEqual([]);
  });

  test("the keg default is the modal keg size actually stocked, not a fixed constant", () => {
    // FINDING 2: the keg default used to be the "canonical"/first-listed
    // 58674 (half barrel), which was wrong for most of this bar's kegs and,
    // being a real keg size, never looked wrong on screen — the worst kind
    // of default per CLAUDE.md. Deriving the expected value from the seed
    // catalog rather than pinning 19533 in isolation means this test starts
    // failing the moment the bar's keg mix changes, instead of staying green
    // while the default quietly drifts out of date again.
    const kegSizes = products.filter((p) => p.unitType === "keg").map((p) => p.sizeMl);
    expect(kegSizes.length).toBeGreaterThan(0);

    const counts = new Map<number, number>();
    for (const ml of kegSizes) counts.set(ml, (counts.get(ml) ?? 0) + 1);
    const [modalMl, modalCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;

    // The modal size must be a clear majority, not a near-tie a future
    // one-keg addition could flip — otherwise this assertion is only
    // incidentally true of today's catalog.
    expect(modalCount).toBeGreaterThan(kegSizes.length / 2);
    expect(defaultSizeMlFor({ category: "Beer", unitType: "keg" })).toBe(modalMl);
  });

  test("the distinct combinations in the catalog are the ones this covers", () => {
    // Named explicitly so a new combination arriving in the seed is a visible
    // decision rather than a row that quietly rides on an existing list.
    const combos = [...new Set(products.map((p) => `${p.category}/${p.unitType}/${p.sizeMl}`))].sort();
    expect(combos).toEqual([
      "Beer/bottle/355",
      "Beer/keg/19533",
      "Beer/keg/29337",
      "Beer/keg/58674",
      "Liqueur/bottle/750",
      "NA/bottle/355",
      "Spirits/bottle/750",
      "Wine/bottle/750",
    ]);
  });
});
