/**
 * Idempotent catalog seed.
 *
 * Reads the deterministic CSV extracts in docs/catalog/ (never the .xlsx —
 * see CLAUDE.md) and upserts, by natural key, into:
 *   - location  (natural key: name)
 *   - product   (natural key: name + size_ml — a 750ml and a 1.75L "handle"
 *     of the same brand are different SKUs, per CLAUDE.md's own handle
 *     example; name alone collides across sizes. Enforced in the schema by
 *     product_name_size_ml_unique.)
 *
 * Safe to re-run. On every run each row is looked up by its natural key
 * first; if found, only the descriptive fields sourced from the CSV are
 * refreshed — cost, case_size, vendor, and par data are NEVER written by an
 * update (only ever set once, at insert time, and only where the source
 * actually has a value). That is deliberate: by the time this seed is
 * re-run against a live database, a manager may have entered real costs
 * through the app, and a "seed" step must not silently wipe production data
 * back to NULL. "Idempotent" here means "safe to run again", not "resets
 * everything to the spreadsheet every time."
 *
 * Does NOT seed: User (auth is the backend agent's job), Vendor, ProductPar,
 * ProductBarcode. products.csv's vendor/cost/par/upc columns are blank in
 * the source for all 97 rows, so those stay NULL — there is nothing to
 * invent. Valuation (Count.total_value, reorder math) cannot be
 * meaningfully tested until real costs and pars are entered through the
 * app; the 9 draft kegs are the one exception, seeded with their real
 * wholesale cost from draft-economics.csv.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { closePool, db } from "./index";
import { location, product, productUnitTypeEnum } from "./schema";

// ---------------------------------------------------------------------------
// Minimal CSV reader. Three small, well-formed files don't justify a
// dependency (PapaParse is reserved for the Toast PMIX import, per
// docs/spec.md §11) — but this still parses RFC4180 quoting (commas and ""
// escaped quotes inside quoted fields) since locations.csv uses it, and it
// fails loudly — throws — on any row whose column count doesn't match the
// header, rather than silently importing a shifted row.
// ---------------------------------------------------------------------------

function parseCsv(raw: string): Record<string, string>[] {
  const text = raw.replace(/\r\n/g, "\n");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  if (nonEmpty.length === 0) {
    throw new Error("CSV file has no rows");
  }
  const header = nonEmpty[0];
  return nonEmpty.slice(1).map((cols, idx) => {
    if (cols.length !== header.length) {
      throw new Error(
        `CSV row ${idx + 2} has ${cols.length} columns, expected ${header.length} ` +
          `(header: ${JSON.stringify(header)}, row: ${JSON.stringify(cols)})`,
      );
    }
    const record: Record<string, string> = {};
    header.forEach((key, i) => {
      record[key] = cols[i];
    });
    return record;
  });
}

function readCsv(relativePath: string): Record<string, string>[] {
  const fullPath = path.join(process.cwd(), relativePath);
  const raw = readFileSync(fullPath, "utf-8");
  return parseCsv(raw);
}

function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Locations — docs/catalog/locations.csv (5 rows)
// ---------------------------------------------------------------------------

async function seedLocations() {
  const rows = readCsv("docs/catalog/locations.csv");
  let inserted = 0;
  let updated = 0;

  for (const row of rows) {
    const name = row.location_name?.trim();
    if (!name) {
      throw new Error(`locations.csv: row missing location_name: ${JSON.stringify(row)}`);
    }
    const sortOrder = Number.parseInt(row.sort_order, 10);
    if (Number.isNaN(sortOrder)) {
      throw new Error(`locations.csv: "${name}" has invalid sort_order "${row.sort_order}"`);
    }
    const notes = trimmedOrNull(row.notes);

    // Which input the counting screen offers here (CLAUDE.md: the input-mode
    // switch is "driven entirely by location"). Validated rather than
    // defaulted on a typo — a location that silently fell back to `tenths`
    // would offer a fill pad in the storeroom, which is the one place
    // "quantities only" is a hard rule.
    const countMode = row.count_mode?.trim();
    if (countMode !== "tenths" && countMode !== "quantity") {
      throw new Error(
        `locations.csv: "${name}" has invalid count_mode "${row.count_mode}" (expected "tenths" or "quantity")`,
      );
    }

    const existing = await db
      .select({ id: location.id })
      .from(location)
      .where(eq(location.name, name))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(location).values({ name, sortOrder, countMode, notes });
      inserted++;
    } else {
      await db
        .update(location)
        .set({ sortOrder, countMode, notes })
        .where(eq(location.id, existing[0].id));
      updated++;
    }
  }

  console.log(`  locations: ${inserted} inserted, ${updated} updated (${rows.length} rows in source)`);
}

// ---------------------------------------------------------------------------
// Products — docs/catalog/products.csv (97 rows)
// ---------------------------------------------------------------------------

const KEG_WASTE_FACTOR = "0.100";
const DEFAULT_WASTE_FACTOR = "0.000";

async function seedProducts() {
  const rows = readCsv("docs/catalog/products.csv");
  let inserted = 0;
  let updated = 0;

  for (const row of rows) {
    const name = row.name?.trim();
    if (!name) {
      throw new Error(`products.csv: row missing name: ${JSON.stringify(row)}`);
    }
    const category = row.category?.trim();
    if (!category) {
      throw new Error(`products.csv: "${name}" is missing category`);
    }
    const unitType = row.unit_type?.trim();
    if (!(productUnitTypeEnum as readonly string[]).includes(unitType)) {
      throw new Error(
        `products.csv: "${name}" has unrecognized unit_type "${unitType}" ` +
          `(expected one of ${productUnitTypeEnum.join(", ")})`,
      );
    }
    const sizeMl = Number.parseInt(row.size_ml, 10);
    if (Number.isNaN(sizeMl)) {
      throw new Error(`products.csv: "${name}" has invalid size_ml "${row.size_ml}"`);
    }
    const activeRaw = row.active?.trim();
    if (activeRaw !== "0" && activeRaw !== "1") {
      throw new Error(`products.csv: "${name}" has non-boolean active value "${row.active}"`);
    }
    const active = activeRaw === "1";
    const brand = trimmedOrNull(row.brand);
    const subcategory = trimmedOrNull(row.subcategory);

    const existing = await db
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.name, name), eq(product.sizeMl, sizeMl)))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(product).values({
        name,
        brand,
        category,
        subcategory,
        unitType: unitType as (typeof productUnitTypeEnum)[number],
        sizeMl,
        active,
        wasteFactor: unitType === "keg" ? KEG_WASTE_FACTOR : DEFAULT_WASTE_FACTOR,
        // case_size, vendor_id, current_unit_cost, empty/full weight,
        // shelf_life_days: left at their column defaults (NULL). The source
        // spreadsheet has no data for these yet — see file banner comment.
      });
      inserted++;
    } else {
      // Only descriptive, catalog-sourced fields are refreshed on a re-run.
      // waste_factor is intentionally excluded too: there's no edit UI for
      // it in the MVP, but treating it as insert-only keeps this function's
      // update branch consistent with the "never blindly overwrite" rule
      // applied to cost/case_size/vendor below.
      await db
        .update(product)
        .set({ brand, category, subcategory, unitType: unitType as (typeof productUnitTypeEnum)[number], sizeMl, active })
        .where(eq(product.id, existing[0].id));
      updated++;
    }
  }

  console.log(`  products: ${inserted} inserted, ${updated} updated (${rows.length} rows in source)`);
}

// ---------------------------------------------------------------------------
// Draft keg costs — docs/catalog/draft-economics.csv (9 rows)
//
// The only real cost data anywhere in the source spreadsheet. Matched
// against keg products by name prefix (e.g. "Coors Light" ← beer name
// matches product name "Coors Light Half Barrel"). Ambiguous matches
// (a beer name prefixing more than one keg product) are skipped and logged,
// never guessed.
// ---------------------------------------------------------------------------

async function seedKegCosts() {
  const rows = readCsv("docs/catalog/draft-economics.csv");
  const kegProducts = await db
    .select({ id: product.id, name: product.name, currentUnitCost: product.currentUnitCost })
    .from(product)
    .where(eq(product.unitType, "keg"));

  let set = 0;
  let alreadySet = 0;
  let ambiguous = 0;
  let unmatched = 0;

  for (const row of rows) {
    const beerName = row.Beer?.trim();
    const wholesaleCostRaw = row["Wholesale Cost"];
    const wholesaleCost = Number.parseFloat(wholesaleCostRaw);
    if (!beerName) {
      throw new Error(`draft-economics.csv: row missing Beer name: ${JSON.stringify(row)}`);
    }
    if (Number.isNaN(wholesaleCost)) {
      throw new Error(`draft-economics.csv: "${beerName}" has invalid Wholesale Cost "${wholesaleCostRaw}"`);
    }

    // NOTE: this is a one-directional prefix check (product name starts
    // with beer name), not a two-way match. It's correct for the current 9
    // rows (verified by dry-run), but it isn't cross-checked against the
    // reverse direction — a future keg product whose name happens to prefix
    // an unrelated draft-economics beer name (or vice versa, a beer name
    // that isn't actually a prefix but partially overlaps) could misfire
    // silently instead of tripping the ambiguity guard below. If
    // draft-economics.csv or the keg product list grows, re-run the dry-run
    // match simulation rather than trusting this blindly.
    const candidates = kegProducts.filter((p) => p.name.startsWith(beerName));
    if (candidates.length === 0) {
      console.warn(`  skip (no match): "${beerName}" does not prefix any keg product name`);
      unmatched++;
      continue;
    }
    if (candidates.length > 1) {
      console.warn(
        `  skip (ambiguous): "${beerName}" prefixes multiple keg products: ` +
          candidates.map((c) => c.name).join(", "),
      );
      ambiguous++;
      continue;
    }

    const target = candidates[0];
    if (target.currentUnitCost !== null) {
      // Already has a cost — from an earlier seed run or entered via the
      // app since. Never overwrite.
      alreadySet++;
      continue;
    }
    await db
      .update(product)
      .set({ currentUnitCost: wholesaleCost.toFixed(4) })
      .where(eq(product.id, target.id));
    set++;
  }

  console.log(
    `  draft keg costs: ${set} set, ${alreadySet} already set, ${ambiguous} ambiguous, ${unmatched} unmatched (${rows.length} rows in source)`,
  );
}

// ---------------------------------------------------------------------------

async function main() {
  console.log("Seeding Handlebar catalog from docs/catalog/ ...");
  await seedLocations();
  await seedProducts();
  await seedKegCosts();
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
