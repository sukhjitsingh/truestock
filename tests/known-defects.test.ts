/**
 * KNOWN DEFECTS — behaviour that is wrong today, written down as tests of what
 * is RIGHT, marked `test.failing` so the suite stays green and honest.
 *
 * How `test.failing` works (bun 1.4): the body asserts the CORRECT behaviour.
 * While the defect exists the body throws, and bun reports the test as passing.
 * The day someone fixes the defect the body passes, bun reports a FAILURE, and
 * the fix is not done until the `.failing` is deleted — at which point the test
 * is a permanent regression guard for the invariant. Nothing here changes
 * application behaviour; each entry says what is wrong, where, and which
 * AGENTS.md invariant it breaks. Every entry has a green control beside it
 * (a plain `test`) proving the assertion CAN pass, so a `.failing` cannot be
 * "passing" merely because the scenario is mis-built.
 *
 * Entries:
 *   A. invariant 6  - count writes do not check `product.active`
 *        cause: lib/domain/counts.ts `upsertCountLineRow` (checks only
 *        `location.active`, ~line 313-331; the product lookup at ~line 369
 *        selects cost/case size and never reads `active`).
 *        ALSO: `resolveBarcodeForCount` (lib/domain/catalog.ts ~line 391) does
 *        not join `product` at all, so a retired product's barcode still scans.
 *   B. invariant 2  - `deriveUnitCost` returns a number for a $0, blank or
 *        NEGATIVE net amount instead of null
 *        cause: lib/domain/cost-derivation.ts ~line 87-90 - `rawNet` is only
 *        checked with `Number.isFinite`; quantity and pack size get the
 *        `<= 0` refusal, rawNet does not. `Number("")` is 0, so a blank net
 *        becomes the cost "0.0000".
 *   C. invariant 10 - `productUpdateSchema.wasteFactor` accepts 1 .. 9.999
 *        cause: lib/validation/catalog.ts:141 `.max(9.999)` (the column's
 *        capacity, not the domain's). Theoretical depletion divides by
 *        (1 - waste), so >= 1 is a divide-by-zero or a negative draw.
 *   D. invariant 10 - a keg enrolled at runtime gets waste_factor 0.000
 *        cause: lib/domain/catalog.ts `createProduct` insert (~line 614-627)
 *        omits `wasteFactor`, and no UI sets it anywhere (components/ never
 *        mentions it), so only the 9 SEEDED kegs carry the 0.100 AGENTS.md
 *        promises ("Draft products get 0.100"). JUDGEMENT CALL: if the product
 *        decision is "the owner sets it per keg later", delete this entry and
 *        say so in AGENTS.md instead - but then nothing makes that happen.
 *   E. last-owner guard (not a numbered invariant; it sits beside invariant 11
 *        in lib/domain/users.ts) - read-then-write outside the
 *        transaction
 *        cause: lib/domain/users.ts `setUserActive` ~line 118-153 -
 *        `countActiveOwners` runs on `db` BEFORE `db.transaction`, and nothing
 *        locks the owner rows, so two owners deactivating each other at once
 *        both pass the check. (`setUserRole` has the same shape.)
 *
 * Mutations that must turn this file red: fixing any defect makes its
 * `test.failing` report a failure (the intended signal). Breaking a CONTROL
 * does it too, e.g. lib/domain/counts.ts `upsertCountLineRow`: delete the
 * `existing` branch's partialFills spread, or lib/domain/users.ts: delete the
 * `LAST_OWNER` throw (the E control).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { db, closePool } from "@/db";
import {
  countLine,
  invoice,
  invoiceLine,
  product,
  productBarcode,
  productCostHistory,
  user,
} from "@/db/schema";
import { productUpdateSchema } from "@/lib/validation/catalog";
import { createProduct, deactivateProduct, updateProduct } from "@/lib/domain/catalog";
import { openCount, incrementCountLine, scanCountLine } from "@/lib/domain/counts";
import { approveInvoice } from "@/lib/domain/invoice-approval";
import { deriveUnitCost, type DerivableCostLine } from "@/lib/domain/cost-derivation";
import { setUserActive } from "@/lib/domain/users";
import { DomainError } from "@/lib/domain/errors";
import type { Actor } from "@/lib/authz";
import {
  migrateTestDatabase,
  resetDatabase,
  createFixtures,
  newClientLineId,
  type Fixtures,
} from "./helpers/test-db";

let fx: Fixtures;

beforeAll(async () => {
  await migrateTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fx = await createFixtures();
});

afterAll(async () => {
  await closePool();
});

// ===========================================================================
// A. Invariant 6 - a deactivated product keeps accepting count writes
// ===========================================================================
//
// AGENTS.md: "`active = false` must be enforced on the WRITE path, not only
// excluded from reads ... The `active` check belongs in the write path, ABOVE
// any existing-row lookup so it runs on every write and not just the insert."
// Locations got exactly this fix (the LOCATION_RETIRED guard); products did not.
// Observed today: after `deactivateProduct`, an increment, a first-time write
// and a barcode scan all succeed silently and put a bottle of a retired product
// into the count - and from there into the valuation.

const BARCODE = "036000291452";

async function enrollBarcode(productId: number) {
  await db.insert(productBarcode).values({
    organizationId: fx.organizationId,
    productId,
    barcode: BARCODE,
    packLevel: "each",
    isPrimary: true,
  });
}

function eachDelta(countId: number, productId: number, n = 1) {
  return {
    clientLineId: newClientLineId(),
    countId,
    productId,
    locationId: fx.locationId,
    sealedCaseQtyDelta: 0,
    sealedEachQtyDelta: n,
    newPartialFills: [] as number[],
  };
}

async function linesFor(countId: number, productId: number) {
  return db
    .select()
    .from(countLine)
    .where(and(eq(countLine.countId, countId), eq(countLine.productId, productId)));
}

describe("A. count writes and product.active (invariant 6)", () => {
  test("CONTROL: an ACTIVE product increments its existing line and scans by barcode", async () => {
    await enrollBarcode(fx.pricedProductId);
    const c = await openCount(fx.owner, { type: "full" });
    await incrementCountLine(fx.owner, eachDelta(c.id, fx.pricedProductId));
    await incrementCountLine(fx.owner, eachDelta(c.id, fx.pricedProductId));
    await scanCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      locationId: fx.locationId,
      barcode: BARCODE,
      qty: 1,
    });
    const lines = await linesFor(c.id, fx.pricedProductId);
    expect(lines).toHaveLength(1);
    expect(lines[0].sealedEachQty).toBe(3);
  });

  test("CONTROL: deactivateProduct really does retire the row (so the cases below test a retired product)", async () => {
    await deactivateProduct(fx.owner, fx.pricedProductId);
    const [row] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(row.active).toBe(false);
  });

  test.failing(
    "A1. an existing line of a product deactivated mid-count refuses the next increment",
    async () => {
      const c = await openCount(fx.owner, { type: "full" });
      await incrementCountLine(fx.owner, eachDelta(c.id, fx.pricedProductId)); // 1 each
      await deactivateProduct(fx.owner, fx.pricedProductId);

      // CORRECT: a DomainError (product retired). OBSERVED: resolves, line -> 2.
      await expect(
        incrementCountLine(fx.owner, eachDelta(c.id, fx.pricedProductId)),
      ).rejects.toBeInstanceOf(DomainError);

      const [line] = await linesFor(c.id, fx.pricedProductId);
      expect(line.sealedEachQty).toBe(1);
    },
  );

  test.failing(
    "A2. a product deactivated BEFORE its first write in a count cannot get a first line",
    async () => {
      const c = await openCount(fx.owner, { type: "full" });
      await deactivateProduct(fx.owner, fx.pricedProductId);

      // CORRECT: refused, no row. OBSERVED: a new count_line is inserted.
      await expect(
        incrementCountLine(fx.owner, eachDelta(c.id, fx.pricedProductId)),
      ).rejects.toBeInstanceOf(DomainError);
      expect(await linesFor(c.id, fx.pricedProductId)).toHaveLength(0);
    },
  );

  test.failing(
    "A3. scanning the barcode of a deactivated product is refused (resolveBarcodeForCount ignores product.active)",
    async () => {
      await enrollBarcode(fx.pricedProductId);
      const c = await openCount(fx.owner, { type: "full" });
      await deactivateProduct(fx.owner, fx.pricedProductId);

      // CORRECT: refused (NotFound or a retired-product DomainError).
      // OBSERVED: the scan resolves the barcode and writes a line.
      await expect(
        scanCountLine(fx.owner, {
          clientLineId: newClientLineId(),
          countId: c.id,
          locationId: fx.locationId,
          barcode: BARCODE,
          qty: 1,
        }),
      ).rejects.toBeInstanceOf(DomainError);
      expect(await linesFor(c.id, fx.pricedProductId)).toHaveLength(0);
    },
  );
});

// ===========================================================================
// B. Invariant 2 - deriveUnitCost invents a cost from a $0 / blank / negative net
// ===========================================================================
//
// AGENTS.md invariant 2 and valuation.ts: a cost is either exactly determined or
// NULL - "must never be coerced to 0". Quantity and pack size are refused at
// `<= 0` (cost-derivation.ts ~line 86-88); rawNet is not. Observed:
//   rawNet "-60.00", qty 10, pack 1  ->  "-6.0000"  (a NEGATIVE unit cost)
//   rawNet "0.00"                    ->  "0.0000"
//   rawNet ""  and  " "              ->  "0.0000"   (Number("") === 0)
// A "0.0000" is not NULL: a count line snapshotting it is "priced" at $0 and
// counted in pricedLineCount instead of being excluded, and a negative cost
// makes stock worth negative money.

const productLine = (over: Partial<DerivableCostLine> = {}): DerivableCostLine => ({
  lineType: "product",
  quantity: "10.000",
  packSize: 1,
  rawNet: "60.00",
  ...over,
});

describe("B. deriveUnitCost on a non-positive or blank net amount (invariant 2)", () => {
  test("CONTROL: 60.00 / 10 / 1 is '6.0000', and an unusable QUANTITY already returns null", () => {
    expect(deriveUnitCost(productLine())).toBe("6.0000");
    expect(deriveUnitCost(productLine({ quantity: "" }))).toBeNull();
    expect(deriveUnitCost(productLine({ quantity: "-10.000" }))).toBeNull();
  });

  test.failing("B1. a NEGATIVE net amount is null, not a negative unit cost", () => {
    // OBSERVED: "-6.0000"
    expect(deriveUnitCost(productLine({ rawNet: "-60.00" }))).toBeNull();
  });

  test.failing("B2. a ZERO net amount is null, not '0.0000'", () => {
    // OBSERVED: "0.0000"
    expect(deriveUnitCost(productLine({ rawNet: "0.00" }))).toBeNull();
  });

  test.failing("B3. a BLANK net amount is null, not '0.0000'", () => {
    // OBSERVED: "0.0000" for both
    expect(deriveUnitCost(productLine({ rawNet: "" }))).toBeNull();
    expect(deriveUnitCost(productLine({ rawNet: "   " }))).toBeNull();
  });
});

describe("B. approveInvoice posting a non-positive net amount (invariant 2)", () => {
  /** Puts the fixture's matched line on `rawNet` and the invoice into `reviewed`. */
  async function reviewedInvoiceWithNet(rawNet: string) {
    await db.update(invoice).set({ status: "reviewed" }).where(eq(invoice.id, fx.invoiceId));
    await db
      .update(invoiceLine)
      .set({ packSize: 1, quantity: "10.000", rawNet, rawGross: rawNet })
      .where(eq(invoiceLine.id, fx.matchedInvoiceLineId));
  }

  async function costAndHistory() {
    const [row] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    const history = await db
      .select()
      .from(productCostHistory)
      .where(eq(productCostHistory.productId, fx.pricedProductId));
    return { cost: row.currentUnitCost, historyRows: history.length };
  }

  test("CONTROL: a normal positive net amount posts the derived cost and one history row", async () => {
    await reviewedInvoiceWithNet("60.00");
    const result = await approveInvoice(fx.owner, fx.invoiceId);
    expect(result.costLinesApplied).toBe(1);
    expect(await costAndHistory()).toEqual({ cost: "6.0000", historyRows: 1 });
  });

  test.failing.each([
    ["negative", "-60.00"],
    ["zero", "0.00"],
  ])(
    "B4. a %s net amount on a matched line is skipped: cost unchanged (24.5000), no history row",
    async (_label, rawNet) => {
      await reviewedInvoiceWithNet(rawNet);
      await approveInvoice(fx.owner, fx.invoiceId);

      // CORRECT: same as before approval. OBSERVED for "-60.00": cost
      // "-6.0000" plus a history row; for "0.00": cost "0.0000" plus a row.
      expect(await costAndHistory()).toEqual({ cost: "24.5000", historyRows: 0 });
    },
  );
});

// ===========================================================================
// C. Invariant 10 prerequisite - waste factor >= 1 is accepted
// ===========================================================================
//
// Theoretical depletion is `pour / (1 - waste_factor)`. At 1 that divides by
// zero; above 1 it is a negative draw. `.max(9.999)` merely mirrors
// DECIMAL(4,3)'s capacity (its own comment says it "already bounds this
// correctly" - it bounds the COLUMN, not the meaning). A typo of 10 instead of
// 0.10 passes validation, is stored as 1.000 .. 9.999 and would silently poison
// the Phase 2 variance report.

describe("C. productUpdateSchema.wasteFactor (invariant 10)", () => {
  const parse = (wasteFactor: number) => productUpdateSchema.safeParse({ productId: 1, wasteFactor });

  test("CONTROL: 0, 0.1 and 0.999 are accepted; negatives and non-numbers are rejected", () => {
    expect(parse(0).success).toBe(true);
    expect(parse(0.1).success).toBe(true);
    expect(parse(0.999).success).toBe(true);
    expect(parse(-0.1).success).toBe(false);
    expect(productUpdateSchema.safeParse({ productId: 1, wasteFactor: "0.1" }).success).toBe(false);
  });

  test.failing.each([[1], [1.5], [9.999]])(
    "C1. a waste factor of %p is rejected at the boundary",
    (wasteFactor) => {
      // OBSERVED: success === true for all three.
      expect(parse(wasteFactor).success).toBe(false);
    },
  );
});

// ===========================================================================
// D. Invariant 10 - a keg enrolled at runtime has no waste factor
// ===========================================================================
//
// AGENTS.md "Draft beer" / "Schema delta": "Draft products get 0.100. Bottles
// and wine stay 0.000", and the banner's lesson is that a plausible-but-wrong
// DEFAULT is the dangerous kind. 0.000 is exactly that: it looks like "no waste"
// and quietly makes every keg added after the seed look ~10% over-supplied in
// the Phase 2 variance report. The seed handles the first nine kegs; scan-to-
// enroll (`createProduct`) and `updateProduct({ unitType: "keg" })` do not.

describe("D. waste factor of a keg enrolled after the seed (invariant 10)", () => {
  const KEG = { name: "Founders All Day IPA", category: "Beer", sizeMl: 19533 } as const;

  async function wasteOf(productId: number) {
    const [row] = await db.select().from(product).where(eq(product.id, productId));
    return row.wasteFactor;
  }

  test("CONTROL: an enrolled BOTTLE is 0.000 (the correct default for non-draft) and an explicit factor sticks", async () => {
    const bottle = await createProduct(fx.owner, {
      name: "Casamigos Blanco",
      category: "Spirits",
      unitType: "bottle",
      sizeMl: 750,
    });
    expect(await wasteOf(bottle.id)).toBe("0.000");

    await updateProduct(fx.owner, { productId: bottle.id, wasteFactor: 0.1 });
    expect(await wasteOf(bottle.id)).toBe("0.100");
  });

  test.failing("D1. enrolling a keg through createProduct stores waste_factor 0.100", async () => {
    const keg = await createProduct(fx.owner, { ...KEG, unitType: "keg" });
    // OBSERVED: "0.000"
    expect(await wasteOf(keg.id)).toBe("0.100");
  });

  test.failing("D2. re-filing an existing bottle as a keg via updateProduct does not leave it at 0.000", async () => {
    await updateProduct(fx.owner, { productId: fx.secondProductId, unitType: "keg", sizeMl: 19533 });
    // OBSERVED: "0.000"
    expect(await wasteOf(fx.secondProductId)).toBe("0.100");
  });
});

// ===========================================================================
// E. Last-owner guard - two owners can deactivate each other at the same time
// ===========================================================================
//
// `setUserActive` reads "how many OTHER active owners are there?" on `db`, then
// opens a transaction and writes. A (acting on B) counts owners excluding B ->
// {A} = 1. B (acting on A) counts owners excluding A -> {B} = 1. Both pass, both
// commit, the organization has ZERO active owners and nobody can reactivate
// anyone. The sequential guard works (control below); only the interleaving
// breaks it. A fix is to take the check inside the transaction behind
// `SELECT ... FOR UPDATE` on the org's owner rows.
//
// Reproducibility: the two reads are issued back to back before either write
// begins, so this reproduces on the first attempt in practice; the bounded loop
// exists so a lucky scheduling does not turn a real defect into a flaky pass.

describe("E. last-owner guard under concurrency", () => {
  async function secondOwner(): Promise<Actor> {
    const [row] = await db
      .insert(user)
      .values({
        name: "Second Owner",
        email: `owner2-${crypto.randomUUID()}@test.local`,
        emailVerified: true,
        role: "owner",
        active: true,
        organizationId: fx.organizationId,
      })
      .$returningId();
    return { userId: row.id, role: "owner", organizationId: fx.organizationId };
  }

  async function activeOwnerCount(): Promise<number> {
    const rows = await db
      .select({ id: user.id })
      .from(user)
      .where(
        and(eq(user.organizationId, fx.organizationId), eq(user.role, "owner"), eq(user.active, true)),
      );
    return rows.length;
  }

  test("CONTROL: sequentially, the second deactivation is refused with LAST_OWNER and one owner survives", async () => {
    const a = fx.owner;
    const b = await secondOwner();

    await setUserActive(a, { userId: b.userId, active: false }); // A removes B: fine
    await expect(setUserActive(b, { userId: a.userId, active: false })).rejects.toMatchObject({
      code: "LAST_OWNER",
    });
    expect(await activeOwnerCount()).toBe(1);
  });

  test.failing(
    "E1. A and B deactivating each other concurrently never leaves the organization with zero active owners",
    async () => {
      const a = fx.owner;
      const b = await secondOwner();

      for (let attempt = 1; attempt <= 20; attempt++) {
        await db
          .update(user)
          .set({ active: true })
          .where(inArray(user.id, [a.userId, b.userId]));

        await Promise.allSettled([
          setUserActive(a, { userId: b.userId, active: false }),
          setUserActive(b, { userId: a.userId, active: false }),
        ]);

        // CORRECT: at least one owner remains after every attempt.
        // OBSERVED: 0 active owners (typically on attempt 1).
        expect(await activeOwnerCount()).toBeGreaterThanOrEqual(1);
      }
    },
    60_000,
  );
});
