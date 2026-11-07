/**
 * Waste factor (AGENTS.md invariant 10): "Draft depletion is grossed up by the
 * waste factor ... Applies to *theoretical depletion only* — never to counted
 * inventory, which is measured as it actually is."
 *
 * Three halves, because the invariant has three ways to rot:
 *
 *   1. COUNTED INVENTORY IS NEVER GROSSED UP. A keg with waste_factor 0.100 and
 *      a half-full tap (`partial_fills [0.5]`) is 0.5 of a keg on the shelf, not
 *      0.5 / 0.9. Asserted through the real write -> close -> read path
 *      (`closeCount`, `getCountTotals`, `getOnHandSnapshot`) and again after the
 *      factor is changed on a closed count's product. A source tripwire pins
 *      that none of the valuation / on-hand / count modules mention waste at all.
 *   2. THE SEEDED FACTORS AGREE. Kegs seed at 0.100 and everything else at
 *      0.000 (AGENTS.md "Schema delta"). `KEG_WASTE_FACTOR` in db/seed.ts is
 *      module-private, so the test reads it out of the source, compares it with
 *      the spec value written here, and then RUNS the real seed in a subprocess
 *      and checks every one of the 97 stored rows against products.csv. A
 *      default and a catalog that drift apart are exactly the "plausible but
 *      wrong" failure the AGENTS.md banner warns about.
 *   3. THEORETICAL DEPLETION IS NOT BUILT YET (Phase 2 variance report), so its
 *      rules are `test.todo` entries — visible in the run output, impossible to
 *      forget, and not faked with a function that does not exist.
 *
 * Mutations that must turn this file red:
 *   - lib/domain/valuation.ts computeLineUnits: divide the partial-fill sum by
 *     (1 - waste) (any waste term in counted units) -> half 1 and the tripwire.
 *   - lib/domain/on-hand.ts getOnHandSnapshot: same change -> half 1.
 *   - db/seed.ts: `const KEG_WASTE_FACTOR = "0.100"` -> `"0.150"` -> half 2.
 *   - db/seed.ts: `unitType === "keg" ?` -> `unitType !== "keg" ?` -> half 2.
 *   - lib/domain/catalog.ts updateProduct: `wasteFactor.toFixed(3)` ->
 *     `toFixed(2)` -> the precision round-trip test.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { count, organization, product } from "@/db/schema";
import { readCsv } from "@/db/csv";
import { updateProduct } from "@/lib/domain/catalog";
import {
  openCount,
  incrementCountLine,
  submitCount,
  reviewCount,
  closeCount,
  getCountTotals,
} from "@/lib/domain/counts";
import { getOnHandSnapshot } from "@/lib/domain/on-hand";
import { computeLineUnits } from "@/lib/domain/valuation";
import {
  migrateTestDatabase,
  resetDatabase,
  createFixtures,
  newClientLineId,
  type Fixtures,
} from "./helpers/test-db";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

// The values AGENTS.md ("Schema delta ... Draft products get 0.100. Bottles and
// wine stay 0.000") and the product table comment promise. Written out here on
// purpose rather than imported: if the seed's constant and this spec value ever
// disagree, one of them is wrong and a human should decide which.
const SPEC_KEG_WASTE = "0.100";
const SPEC_OTHER_WASTE = "0.000";

let fx: Fixtures;

beforeAll(async () => {
  await migrateTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fx = await createFixtures();
});

afterAll(async () => {
  // The seed describe leaves 97 products behind; the next file resets anyway,
  // but this keeps the shared test database tidy.
  await resetDatabase();
  await closePool();
});

// ---------------------------------------------------------------------------
// 1. Counted inventory is never grossed up
// ---------------------------------------------------------------------------

/** Puts a count line with `fills` on `productId` at Back Bar, then closes the count. */
async function countAndClose(lines: Array<{ productId: number; fills: number[] }>) {
  const opened = await openCount(fx.owner, { type: "full" });
  for (const { productId, fills } of lines) {
    await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: opened.id,
      productId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 0,
      newPartialFills: fills,
    });
  }
  await submitCount(fx.owner, opened.id);
  await reviewCount(fx.owner, opened.id);
  const closed = await closeCount(fx.owner, opened.id);
  return { countId: opened.id, closed };
}

async function makeKeg(productId: number, wasteFactor: number) {
  await updateProduct(fx.owner, {
    productId,
    unitType: "keg",
    sizeMl: 58674,
    wasteFactor,
  });
}

describe("counted inventory is measured as it is — never grossed up by waste (invariant 10)", () => {
  test("positive control: the waste factor really is stored on the keg, so a leak into counted units would be visible", async () => {
    await makeKeg(fx.pricedProductId, 0.1);
    const [row] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(row.unitType).toBe("keg");
    expect(row.wasteFactor).toBe("0.100");
    // The control product, left alone, is a plain 0.000.
    const [plain] = await db.select().from(product).where(eq(product.id, fx.secondProductId));
    expect(plain.wasteFactor).toBe("0.000");
  });

  test("a tapped keg at 0.5 with waste 0.100 is 0.5 units and $12.25 — not 0.5 / 0.9 and $13.61", async () => {
    await makeKeg(fx.pricedProductId, 0.1); // cost 24.5000
    const { countId, closed } = await countAndClose([
      { productId: fx.pricedProductId, fills: [0.5] },
    ]);

    const grossedUpUnits = 0.5 / (1 - 0.1); // 0.5555... — what a leak would produce
    const grossedUpValue = Math.round(grossedUpUnits * 24.5 * 100) / 100; // 13.61

    expect(closed.totals.totalUnits).toBe(0.5);
    expect(closed.totals.totalUnits).not.toBe(grossedUpUnits);
    expect(closed.totals.totalValue).toBe(12.25);
    expect(closed.totals.totalValue).not.toBe(grossedUpValue);

    const [stored] = await db.select().from(count).where(eq(count.id, countId));
    expect(stored.totalValue).toBe("12.25");

    const onHand = await getOnHandSnapshot(fx.organizationId);
    expect(onHand.asOfCountId).toBe(countId);
    expect(onHand.byProduct.get(fx.pricedProductId)).toBe(0.5);
  });

  test("a waste-0.100 keg and a waste-0 bottle with identical fills count identically", async () => {
    await makeKeg(fx.pricedProductId, 0.1); // $24.50 -> 0.5 = 12.25
    // secondProductId stays a plain bottle at waste 0.000, $31.25 -> 0.5 = 15.625
    const { closed } = await countAndClose([
      { productId: fx.pricedProductId, fills: [0.5] },
      { productId: fx.secondProductId, fills: [0.5] },
    ]);

    const onHand = await getOnHandSnapshot(fx.organizationId);
    expect(onHand.byProduct.get(fx.pricedProductId)).toBe(0.5);
    expect(onHand.byProduct.get(fx.secondProductId)).toBe(0.5);
    expect(closed.totals.totalUnits).toBe(1);
    // 12.25 + 15.625 = 27.875 -> 27.88. With the keg grossed up it would be 29.24.
    expect(closed.totals.totalValue).toBe(27.88);
  });

  test("changing the waste factor AFTER a count closes changes nothing about that count", async () => {
    await makeKeg(fx.pricedProductId, 0.1);
    const { countId } = await countAndClose([{ productId: fx.pricedProductId, fills: [0.5] }]);

    await makeKeg(fx.pricedProductId, 0.5); // a wildly different factor

    const onHand = await getOnHandSnapshot(fx.organizationId);
    expect(onHand.byProduct.get(fx.pricedProductId)).toBe(0.5);
    const totals = await getCountTotals(fx.owner, countId);
    expect(totals.totalUnits).toBe(0.5);
    expect(totals.totalValue).toBe(12.25);
  });

  test("computeLineUnits takes no waste term: fills sum to the same units for any product", () => {
    // Its parameter type has no waste field, so this cannot be passed one; the
    // assertion is that the fills pass through untouched.
    const base = {
      sealedCaseQty: 0,
      sealedEachQty: 0,
      unitCostAtCount: "24.5000",
      caseSizeAtCount: null,
    };
    expect(computeLineUnits({ ...base, partialFills: [0.5] }).units).toBe(0.5);
    expect(computeLineUnits({ ...base, partialFills: [0.3, 0.8] }).units).toBeCloseTo(1.1, 10);
  });

  test("TRIPWIRE: the counted-inventory modules do not mention waste at all", () => {
    // Today the only code that reads `waste_factor` is the catalog edit path.
    // If one of these files grows a waste term, it is almost certainly gross-up
    // of a measured quantity — the exact mistake invariant 10 forbids. If a
    // legitimate need ever appears, change this test deliberately, in the same
    // commit, with the reason written next to it.
    for (const file of [
      "lib/domain/valuation.ts",
      "lib/domain/on-hand.ts",
      "lib/domain/counts.ts",
      "lib/domain/reports.ts",
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect({ file, mentionsWaste: /waste/i.test(source) }).toEqual({ file, mentionsWaste: false });
    }
  });
});

describe("waste factor storage", () => {
  test.each([
    [0, "0.000"],
    [0.1, "0.100"],
    [0.125, "0.125"],
    [0.3, "0.300"],
  ])("updateProduct stores %p as the DECIMAL(4,3) string %p", async (input, expected) => {
    await updateProduct(fx.owner, { productId: fx.pricedProductId, wasteFactor: input });
    const [row] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(row.wasteFactor).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 2. The seeded factors agree with each other and with the catalog
// ---------------------------------------------------------------------------

describe("seeded waste factors: kegs 0.100, everything else 0.000", () => {
  const seedSource = readFileSync(path.join(REPO_ROOT, "db/seed.ts"), "utf8");
  const csv = readCsv("docs/catalog/products.csv");

  test("db/seed.ts's constants equal the AGENTS.md values", () => {
    const keg = /const KEG_WASTE_FACTOR = "([^"]+)"/.exec(seedSource)?.[1];
    const other = /const DEFAULT_WASTE_FACTOR = "([^"]+)"/.exec(seedSource)?.[1];
    // Fail with a clear message if the constants are renamed, instead of
    // comparing undefined to undefined.
    expect(keg).toBeDefined();
    expect(other).toBeDefined();
    expect(keg).toBe(SPEC_KEG_WASTE);
    expect(other).toBe(SPEC_OTHER_WASTE);
  });

  test("the catalog still has exactly 9 draft kegs and 97 products (what the counts below are measured against)", () => {
    expect(csv).toHaveLength(97);
    expect(csv.filter((r) => r.unit_type.trim() === "keg")).toHaveLength(9);
  });

  test(
    "running the real seed stores 0.100 on every keg and 0.000 on every other product, row for row",
    async () => {
      const url = process.env.DATABASE_URL ?? "";
      // The seed writes. Never let this run against anything but a test database.
      expect(new URL(url).pathname.replace(/^\//, "")).toMatch(/_test$/);

      const run = spawnSync(process.execPath, [path.join(REPO_ROOT, "db/seed.ts")], {
        cwd: REPO_ROOT,
        env: { ...process.env, DATABASE_URL: url },
        encoding: "utf8",
        timeout: 120_000,
      });
      // Surface the seed's own output if it failed; it names the bad row.
      expect({ status: run.status, stderr: run.status === 0 ? "" : run.stderr }).toEqual({
        status: 0,
        stderr: "",
      });

      // Same test, not a second one: beforeEach truncates every table, so a
      // separate test would find the seeded rows already gone.
      const rows = await db
        .select({
          name: product.name,
          sizeMl: product.sizeMl,
          unitType: product.unitType,
          wasteFactor: product.wasteFactor,
        })
        .from(product)
        .innerJoin(organization, eq(organization.id, product.organizationId))
        .where(eq(organization.slug, "truestock"));
      expect(rows).toHaveLength(97);

      const byKey = new Map(rows.map((r) => [`${r.name}|${r.sizeMl}`, r]));
      let kegs = 0;
      for (const row of csv) {
        const stored = byKey.get(`${row.name.trim()}|${Number.parseInt(row.size_ml, 10)}`);
        expect(stored).toBeDefined();
        const isKeg = row.unit_type.trim() === "keg";
        if (isKeg) kegs++;
        expect({
          name: row.name,
          unitType: stored!.unitType as string,
          waste: stored!.wasteFactor,
        }).toEqual({
          name: row.name,
          unitType: row.unit_type.trim(),
          waste: isKeg ? SPEC_KEG_WASTE : SPEC_OTHER_WASTE,
        });
      }
      expect(kegs).toBe(9);
    },
    150_000,
  );
});

// ---------------------------------------------------------------------------
// 3. Theoretical depletion — not built yet (Phase 2 variance report)
// ---------------------------------------------------------------------------
// There is deliberately no function to test: `grep -rn depletion lib/` finds
// nothing. These are the rules it must satisfy the day it exists, written as
// todos so they show up in every test run. AGENTS.md invariant 10 and the
// "Draft Economics" tab are the sources; the numbers below are the owner's own.

// bun's typings want a body on `test.todo`; this one throws, so under
// `bun test --todo` each entry stays a todo instead of flipping to a failure
// ("passing todo") before the depletion function exists.
const notBuilt = (): void => {
  throw new Error("theoretical depletion is not built yet (Phase 2 variance report)");
};

describe("theoretical draft depletion (invariant 10) — pending the Phase 2 variance report", () => {
  test.todo("a 16 oz pour on a waste-0.100 keg draws 16 / (1 - 0.100) = 17.78 oz from the keg", notBuilt);
  test.todo("a 22 oz pour on a waste-0.100 keg draws 24.44 oz from the keg", notBuilt);
  test.todo("a waste-0.000 product's depletion is exactly the pour size — the divisor is 1, nothing is added", notBuilt);
  test.todo(
    "depletion refuses a waste factor >= 1 (pour / (1 - 1) divides by zero; > 1 is a negative draw) instead of returning Infinity or a negative number",
    notBuilt,
  );
  test.todo(
    "the gross-up is applied to theoretical depletion only: the variance report compares it to a counted figure that was never grossed up",
    notBuilt,
  );
});
