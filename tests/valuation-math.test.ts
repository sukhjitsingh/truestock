/**
 * Valuation math (lib/domain/valuation.ts) and the case-size snapshot that
 * feeds it.
 *
 * Guards AGENTS.md invariant 2 (snapshot cost AND case size onto the count line;
 * a NULL snapshot is "unknown", never 0) and invariant 4 (cases and eaches are
 * stored separately and only combined at valuation time, using the case size
 * that was true when the line was counted).
 *
 *   units          = (cases x case_size_at_count) + eaches + sum(partial_fills)
 *   extended_value = units x unit_cost_at_count
 *
 * Until now only the COST snapshot had a test. The case-size snapshot is the
 * same failure mode with a worse blast radius: a beer line counted as "2 cases"
 * is worth 24 bottles at case_size 12 and 48 at case_size 24, so valuing a
 * historical count from the product's CURRENT case size silently re-prices the
 * whole shelf the day a supplier changes its pack.
 *
 * Mutations that must turn this file red:
 *   - lib/domain/valuation.ts computeLineUnits: delete the
 *     `line.sealedCaseQty > 0 && line.caseSizeAtCount == null` early return
 *     (a NULL case size then silently counts "2 cases" as 0 bottles).
 *   - lib/domain/valuation.ts computeLineValuation: coerce a NULL cost to 0
 *     (`Number(line.unitCostAtCount ?? 0)`) so an unpriced bottle reads as free.
 *   - lib/domain/counts.ts upsertCountLineRow: write `caseSizeAtCount: null`
 *     instead of `productRow.caseSize`, or value a line from the live product.
 *   - lib/domain/valuation.ts summarizeValuation: drop the final
 *     `Math.round(totalValue * 100) / 100`.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { countLine } from "@/db/schema";
import { openCount, incrementCountLine, getCount } from "@/lib/domain/counts";
import { createLocation, updateProduct } from "@/lib/domain/catalog";
import {
  computeLineUnits,
  computeLineValuation,
  summarizeValuation,
  type ValuationLine,
} from "@/lib/domain/valuation";
import {
  migrateTestDatabase,
  resetDatabase,
  createFixtures,
  newClientLineId,
  type Fixtures,
} from "./helpers/test-db";

beforeAll(async () => {
  await migrateTestDatabase();
});

afterAll(async () => {
  await closePool();
});

/** A line with every field defaulted to "nothing counted, nothing known". */
function line(overrides: Partial<ValuationLine> = {}): ValuationLine {
  return {
    sealedCaseQty: 0,
    sealedEachQty: 0,
    partialFills: [],
    unitCostAtCount: null,
    caseSizeAtCount: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

describe("computeLineUnits — the spec formula", () => {
  test("positive control: 2 cases x 12 + 3 eaches + [0.5, 0.25] = 27.75 units", () => {
    const r = computeLineUnits(
      line({ sealedCaseQty: 2, caseSizeAtCount: 12, sealedEachQty: 3, partialFills: [0.5, 0.25] }),
    );
    expect(r.reason).toBeNull();
    // 0.5 and 0.25 are exact in binary, so this can be exact rather than close.
    expect(r.units).toBe(27.75);
  });

  test("cases > 0 with a NULL case size is indeterminate: units null, reason missing_case_size", () => {
    const r = computeLineUnits(line({ sealedCaseQty: 2, caseSizeAtCount: null }));
    expect(r.units).toBeNull();
    expect(r.reason).toBe("missing_case_size");
  });

  test("unknown-size cases exclude the WHOLE line, not just the case term (loose eaches are not reported as the total)", () => {
    // Deliberate: with 2 cases of unknown size the line total is unknowable, so
    // the 3 loose eaches must not be reported as if they were the whole line.
    const r = computeLineUnits(
      line({ sealedCaseQty: 2, caseSizeAtCount: null, sealedEachQty: 3, partialFills: [0.4] }),
    );
    expect(r.units).toBeNull();
  });

  test("zero cases with a NULL case size is NOT indeterminate (liquor has no case size)", () => {
    // The catalog's 62 spirits, 2 liqueurs, 5 wines and 3 NA all have a NULL
    // case_size on purpose (AGENTS.md "The catalog"). If this started returning
    // null, every liquor line in every count would drop out of valuation.
    const r = computeLineUnits(
      line({ sealedCaseQty: 0, caseSizeAtCount: null, sealedEachQty: 3, partialFills: [0.3, 0.8] }),
    );
    expect(r.reason).toBeNull();
    expect(r.units).not.toBeNull();
    expect(r.units!).toBeCloseTo(4.1, 10);
  });

  test("a counted zero is 0 units, not null — 'we looked and there are none' is a measurement", () => {
    const r = computeLineUnits(line());
    expect(r.units).toBe(0);
    expect(r.reason).toBeNull();
  });

  test("cases and eaches stay separate terms: 1 case of 12 and 12 loose eaches value equally but are not the same shape", () => {
    // Invariant 4 at the arithmetic level: the case term is cases x size, the
    // each term is added, and neither is folded into the other beforehand.
    const asCase = computeLineUnits(line({ sealedCaseQty: 1, caseSizeAtCount: 12 }));
    const asEaches = computeLineUnits(line({ sealedEachQty: 12 }));
    expect(asCase.units).toBe(12);
    expect(asEaches.units).toBe(12);
    // ...and changing only the case size moves only the case term.
    const biggerCase = computeLineUnits(line({ sealedCaseQty: 1, caseSizeAtCount: 24, sealedEachQty: 12 }));
    expect(biggerCase.units).toBe(36);
  });
});

describe("computeLineValuation — cost handling", () => {
  test("positive control: cost '24.5000' x 4.1 units = 100.45", () => {
    const v = computeLineValuation(
      line({ sealedEachQty: 3, partialFills: [0.3, 0.8], unitCostAtCount: "24.5000" }),
    );
    expect(v.units!).toBeCloseTo(4.1, 10);
    expect(v.extendedValue).toBe(100.45);
    expect(v.valueExcludedReason).toBeNull();
  });

  test("a NULL cost keeps the units but excludes the value: missing_cost, never $0", () => {
    const v = computeLineValuation(
      line({ sealedEachQty: 3, partialFills: [0.3, 0.8], unitCostAtCount: null }),
    );
    expect(v.units!).toBeCloseTo(4.1, 10);
    expect(v.unitsExcludedReason).toBeNull();
    expect(v.extendedValue).toBeNull();
    expect(v.valueExcludedReason).toBe("missing_cost");
  });

  test("2 cases of an unknown size: units AND value are null, reason missing_case_size", () => {
    const v = computeLineValuation(
      line({ sealedCaseQty: 2, caseSizeAtCount: null, unitCostAtCount: "24.5000" }),
    );
    expect(v.units).toBeNull();
    expect(v.unitsExcludedReason).toBe("missing_case_size");
    // A cost IS known here; the value is still null because the units are not.
    expect(v.extendedValue).toBeNull();
    expect(v.valueExcludedReason).toBe("missing_case_size");
  });

  test("a counted zero with a cost is $0 (priced), which is different from unpriced (null)", () => {
    const priced = computeLineValuation(line({ unitCostAtCount: "24.5000" }));
    const unpriced = computeLineValuation(line({ unitCostAtCount: null }));
    expect(priced.extendedValue).toBe(0);
    expect(unpriced.extendedValue).toBeNull();
  });

  test("the extended value is rounded to cents, the snapshot cost is not", () => {
    // 1 unit at 0.3333 -> 0.33; 3 units at 0.3333 -> 1.00 (0.9999 rounds up).
    expect(computeLineValuation(line({ sealedEachQty: 1, unitCostAtCount: "0.3333" })).extendedValue).toBe(0.33);
    expect(computeLineValuation(line({ sealedEachQty: 3, unitCostAtCount: "0.3333" })).extendedValue).toBe(1);
  });
});

describe("summarizeValuation — totals exclude, they never coerce", () => {
  const priced = line({ sealedEachQty: 2, unitCostAtCount: "10.0000" }); // 2 units, $20.00
  const uncosted = line({ sealedEachQty: 3, partialFills: [0.5] }); // 3.5 units, no cost
  const nullCaseSize = line({ sealedCaseQty: 4, caseSizeAtCount: null, unitCostAtCount: "99.0000" });

  test("one priced line, one uncosted, one with an unknown case size", () => {
    const t = summarizeValuation([priced, uncosted, nullCaseSize]);

    expect(t.pricedLineCount).toBe(1);
    expect(t.excludedLineCount).toBe(2);
    // Only the priced line contributes dollars. The $99 cost on the
    // unknowable-units line must not leak into the total.
    expect(t.totalValue).toBe(20);
    // Units: the uncosted line DOES count (3.5, the units are known); the
    // null-case-size line contributes none.
    expect(t.totalUnits).toBe(5.5);
  });

  test("positive control: the priced line alone is fully included", () => {
    const t = summarizeValuation([priced]);
    expect(t).toEqual({ totalValue: 20, totalUnits: 2, pricedLineCount: 1, excludedLineCount: 0 });
  });

  test("an empty count totals zero with nothing excluded", () => {
    expect(summarizeValuation([])).toEqual({
      totalValue: 0,
      totalUnits: 0,
      pricedLineCount: 0,
      excludedLineCount: 0,
    });
  });

  test("the grand total is rounded to cents so float drift never reaches a dollar figure", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in IEEE-754.
    const t = summarizeValuation([
      line({ sealedEachQty: 1, unitCostAtCount: "0.1000" }),
      line({ sealedEachQty: 1, unitCostAtCount: "0.2000" }),
    ]);
    expect(t.totalValue).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// The case-size snapshot, against a real database
// ---------------------------------------------------------------------------

describe("case_size_at_count snapshot (invariants 2 and 4)", () => {
  let fx: Fixtures;

  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixtures();
  });

  /** One write of "2 cases and 3 eaches" to the priced product at `locationId`. */
  async function countTwoCasesThreeEaches(countId: number, locationId: number) {
    return incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId,
      productId: fx.pricedProductId,
      locationId,
      sealedCaseQtyDelta: 2,
      sealedEachQtyDelta: 3,
      newPartialFills: [],
    });
  }

  test("the first write copies product.caseSize onto the line", async () => {
    await updateProduct(fx.owner, { productId: fx.pricedProductId, caseSize: 24 });
    const c = await openCount(fx.owner, { type: "full" });

    const written = await countTwoCasesThreeEaches(c.id, fx.locationId);

    const [row] = await db.select().from(countLine).where(eq(countLine.id, written.id));
    expect(row.caseSizeAtCount).toBe(24);
    expect(row.unitCostAtCount).toBe("24.5000");
    // (2 x 24) + 3 = 51 units, valued from the snapshots.
    expect(written.units).toBe(51);
    expect(written.extendedValue).toBe(1249.5);
  });

  test("changing product.caseSize afterwards leaves the line's snapshot and computed units unchanged", async () => {
    await updateProduct(fx.owner, { productId: fx.pricedProductId, caseSize: 24 });
    const c = await openCount(fx.owner, { type: "full" });
    const written = await countTwoCasesThreeEaches(c.id, fx.locationId);

    // The supplier changes the pack. The live product now says 12.
    await updateProduct(fx.owner, { productId: fx.pricedProductId, caseSize: 12 });

    const [row] = await db.select().from(countLine).where(eq(countLine.id, written.id));
    expect(row.caseSizeAtCount).toBe(24);

    const detail = await getCount(fx.owner, c.id);
    const fromRead = detail.lines.find((l) => l.id === written.id)!;
    expect(fromRead.caseSizeAtCount).toBe(24);
    // Valued from 24, not from the live 12 (which would give 27 units / $661.50).
    expect(fromRead.units).toBe(51);
    expect(fromRead.extendedValue).toBe(1249.5);
  });

  test("a later scan of the same line increments it and does NOT re-snapshot the case size", async () => {
    await updateProduct(fx.owner, { productId: fx.pricedProductId, caseSize: 24 });
    const c = await openCount(fx.owner, { type: "full" });
    const first = await countTwoCasesThreeEaches(c.id, fx.locationId);

    await updateProduct(fx.owner, { productId: fx.pricedProductId, caseSize: 12 });
    const second = await countTwoCasesThreeEaches(c.id, fx.locationId);

    // Invariant 3: still one line. Invariant 2: still the original snapshot.
    expect(second.id).toBe(first.id);
    const rows = await db.select().from(countLine).where(eq(countLine.countId, c.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].caseSizeAtCount).toBe(24);
    // 4 cases x 24 + 6 eaches.
    expect(second.units).toBe(102);
  });

  test("positive control: a NEW line written after the change snapshots the new case size", async () => {
    await updateProduct(fx.owner, { productId: fx.pricedProductId, caseSize: 24 });
    const c = await openCount(fx.owner, { type: "full" });
    const storeroom = await createLocation(fx.owner, { name: "Storeroom", countMode: "quantity" });
    const early = await countTwoCasesThreeEaches(c.id, fx.locationId);

    await updateProduct(fx.owner, { productId: fx.pricedProductId, caseSize: 12 });
    const late = await countTwoCasesThreeEaches(c.id, storeroom.id);

    expect(late.id).not.toBe(early.id);
    const [earlyRow] = await db.select().from(countLine).where(eq(countLine.id, early.id));
    const [lateRow] = await db.select().from(countLine).where(eq(countLine.id, late.id));
    expect(earlyRow.caseSizeAtCount).toBe(24);
    expect(lateRow.caseSizeAtCount).toBe(12);
    // Without this the two tests above could pass because nothing ever snapshots.
    expect(late.units).toBe(27);
  });

  test("a product with no case size snapshots NULL, and cases make that line indeterminate (not zero)", async () => {
    // fx.pricedProductId has no case_size (liquor).
    const c = await openCount(fx.owner, { type: "full" });

    const written = await countTwoCasesThreeEaches(c.id, fx.locationId);

    const [row] = await db.select().from(countLine).where(eq(countLine.id, written.id));
    expect(row.caseSizeAtCount).toBeNull();
    expect(written.units).toBeNull();
    expect(written.extendedValue).toBeNull();
  });
});
