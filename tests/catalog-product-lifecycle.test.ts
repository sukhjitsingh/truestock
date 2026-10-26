/**
 * Product lifecycle through the domain layer: create (scan-to-enroll), update,
 * deactivate and the by-id read. tests/catalog-write-path.test.ts covers
 * barcode linking, par levels and inline cost edits; nothing exercised
 * `createProduct`, `deactivateProduct` or `getProductsByIds` directly.
 *
 * Guards AGENTS.md invariant 6 (a product is deactivated, never deleted;
 * history that references it survives), invariant 8 (cost is owner-only on the
 * WRITE side of enroll and on every read), invariant 9 (a foreign vendorId /
 * productId is NotFound and writes nothing) and the "enroll must not
 * half-succeed" property (a barcode collision leaves no orphan product).
 *
 * Mutations that must turn this file red:
 *   - lib/domain/catalog.ts createProduct: `allowCost ? input.currentUnitCost
 *     : undefined` -> `input.currentUnitCost` (manager enroll stores a cost).
 *   - lib/domain/catalog.ts createProduct: delete the `assertVendorOwned` call.
 *   - lib/domain/catalog.ts createProduct: move the barcode insert out of the
 *     transaction (a barcode collision then leaves the product behind).
 *   - lib/domain/catalog.ts deactivateProduct: `.set({ active: false })` ->
 *     `db.delete(product)` (history FK fails or the row vanishes).
 *   - lib/domain/catalog.ts deactivateProduct: drop the organization predicate.
 *   - lib/domain/catalog.ts getProductsByIds: add `eq(product.active, true)`
 *     (a retired-but-matched product renders as "not entered").
 *   - lib/domain/catalog.ts selectProducts: return `currentUnitCost` on the
 *     non-cost branch.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import {
  countLine,
  invoice,
  invoiceLine,
  product,
  productBarcode,
  productCostHistory,
} from "@/db/schema";
import {
  createProduct,
  deactivateProduct,
  getProductsByIds,
  updateProduct,
} from "@/lib/domain/catalog";
import { openCount, incrementCountLine, getCountTotals } from "@/lib/domain/counts";
import { approveInvoice } from "@/lib/domain/invoice-approval";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";
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

const NEW_PRODUCT = {
  name: "Espolon Blanco",
  category: "Spirits",
  unitType: "bottle" as const,
  sizeMl: 750,
};

async function rowByName(organizationId: number, name: string, sizeMl: number) {
  const rows = await db
    .select()
    .from(product)
    .where(
      and(
        eq(product.organizationId, organizationId),
        eq(product.name, name),
        eq(product.sizeMl, sizeMl),
      ),
    );
  return rows;
}

// ---------------------------------------------------------------------------
// createProduct (scan-to-enroll)
// ---------------------------------------------------------------------------

describe("createProduct — cost is an owner-only write (invariant 8)", () => {
  test("positive control: an owner's cost is stored and returned", async () => {
    const made = await createProduct(fx.owner, { ...NEW_PRODUCT, currentUnitCost: "21.5000" });
    expect(made.currentUnitCost).toBe("21.5000");
    const [row] = await rowByName(fx.organizationId, NEW_PRODUCT.name, 750);
    expect(row.currentUnitCost).toBe("21.5000");
    expect(row.active).toBe(true);
  });

  test.each([["manager"], ["staff"]] as const)(
    "a %s's cost is silently dropped — the product is still created, with NULL cost and none in the response",
    async (who) => {
      const made = await createProduct(fx[who], { ...NEW_PRODUCT, currentUnitCost: "21.5000" });

      expect("currentUnitCost" in made).toBe(false);
      expect(JSON.stringify(made)).not.toContain("21.5");
      const [row] = await rowByName(fx.organizationId, NEW_PRODUCT.name, 750);
      expect(row.currentUnitCost).toBeNull();
      expect(row.organizationId).toBe(fx.organizationId);
    },
  );
});

describe("createProduct — collisions and ownership leave nothing behind", () => {
  test("positive control: the same name at a DIFFERENT size is a different product (a 1.75L handle)", async () => {
    await createProduct(fx.owner, NEW_PRODUCT);
    const handle = await createProduct(fx.owner, { ...NEW_PRODUCT, sizeMl: 1750 });
    expect(handle.sizeMl).toBe(1750);
    expect(await rowByName(fx.organizationId, NEW_PRODUCT.name, 750)).toHaveLength(1);
    expect(await rowByName(fx.organizationId, NEW_PRODUCT.name, 1750)).toHaveLength(1);
  });

  test("the same name and size is a ConflictError that names the product — not a raw duplicate-key error", async () => {
    await createProduct(fx.owner, NEW_PRODUCT);
    const err = await createProduct(fx.owner, NEW_PRODUCT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toContain("Espolon Blanco");
    expect((err as Error).message).toContain("750");
    expect(await rowByName(fx.organizationId, NEW_PRODUCT.name, 750)).toHaveLength(1);
  });

  test("a DEACTIVATED product still holds its name and size — enrolling it again conflicts instead of forking history", async () => {
    // Deliberate: the unique index does not look at `active`, and a second row
    // would split one bottle's count history across two product ids.
    const first = await createProduct(fx.owner, NEW_PRODUCT);
    await deactivateProduct(fx.owner, first.id);
    await expect(createProduct(fx.owner, NEW_PRODUCT)).rejects.toBeInstanceOf(ConflictError);
    expect(await rowByName(fx.organizationId, NEW_PRODUCT.name, 750)).toHaveLength(1);
  });

  test("the unique index is per tenant: another tenant may enroll a name and size this tenant already has", async () => {
    // The fixtures give tenant 1 a "Bulleit Bourbon" 750 ml and tenant 2 does
    // not have one. Tenant 1 enrolling it again conflicts...
    const bulleit = {
      name: "Bulleit Bourbon",
      category: "Spirits",
      unitType: "bottle" as const,
      sizeMl: 750,
    };
    await expect(createProduct(fx.owner, bulleit)).rejects.toBeInstanceOf(ConflictError);
    // ...but tenant 2 enrolling the same name and size succeeds, as its own row.
    const theirs = await createProduct(fx.otherOwner, bulleit);
    expect(theirs.id).not.toBe(fx.secondProductId);
    const [row] = await db.select().from(product).where(eq(product.id, theirs.id));
    expect(row.organizationId).toBe(fx.otherOrganizationId);
    // And tenant 1's own row is untouched.
    const [mine] = await db.select().from(product).where(eq(product.id, fx.secondProductId));
    expect(mine.organizationId).toBe(fx.organizationId);
    expect(mine.currentUnitCost).toBe("31.2500");
  });

  test("a barcode already on another product is a ConflictError naming that product, and NO product is created", async () => {
    await db.insert(productBarcode).values({
      organizationId: fx.organizationId,
      productId: fx.pricedProductId,
      barcode: "012345678905",
      packLevel: "each",
      isPrimary: true,
    });

    const err = await createProduct(fx.owner, {
      ...NEW_PRODUCT,
      barcode: { barcode: "012345678905", packLevel: "each" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toContain("Tito's Handmade Vodka");
    // The transaction rolled the product insert back with the barcode insert.
    expect(await rowByName(fx.organizationId, NEW_PRODUCT.name, 750)).toHaveLength(0);
  });

  test("a cross-tenant vendorId is NotFound and creates nothing (invariant 9)", async () => {
    await expect(
      createProduct(fx.owner, { ...NEW_PRODUCT, vendorId: fx.otherVendorId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await rowByName(fx.organizationId, NEW_PRODUCT.name, 750)).toHaveLength(0);
  });

  test("positive control: the tenant's OWN vendor is accepted", async () => {
    const made = await createProduct(fx.owner, { ...NEW_PRODUCT, vendorId: fx.vendorId });
    expect(made.vendorId).toBe(fx.vendorId);
  });
});

describe("updateProduct — foreign ids and collisions change nothing", () => {
  test("a cross-tenant vendorId is NotFound and the product is untouched", async () => {
    await expect(
      updateProduct(fx.owner, { productId: fx.pricedProductId, vendorId: fx.otherVendorId, name: "Renamed" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const [row] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(row.name).toBe("Tito's Handmade Vodka"); // the rename in the same call did not land either
    expect(row.vendorId).toBeNull();
  });

  test("another tenant's product id is NotFound and that product is untouched", async () => {
    const [before] = await db.select().from(product).where(eq(product.id, fx.otherProductId));
    await expect(
      updateProduct(fx.owner, { productId: fx.otherProductId, name: "Hijacked", currentUnitCost: "1.0000" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const [after] = await db.select().from(product).where(eq(product.id, fx.otherProductId));
    expect(after).toEqual(before);
  });

  test("renaming onto another product's name and size is a ConflictError and the row keeps its name", async () => {
    await expect(
      updateProduct(fx.owner, { productId: fx.pricedProductId, name: "Bulleit Bourbon" }),
    ).rejects.toBeInstanceOf(ConflictError);
    const [row] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(row.name).toBe("Tito's Handmade Vodka");
  });
});

// ---------------------------------------------------------------------------
// deactivateProduct (invariant 6)
// ---------------------------------------------------------------------------

describe("deactivateProduct — retire, never delete (invariant 6)", () => {
  test("the row, its cost, its count lines and its cost history all survive; only `active` flips", async () => {
    // Real history, built through the real paths rather than inserted by hand.
    const c = await openCount(fx.owner, { type: "full" });
    await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 2,
      newPartialFills: [],
    });
    await db.update(invoice).set({ status: "reviewed" }).where(eq(invoice.id, fx.invoiceId));
    await db
      .update(invoiceLine)
      .set({ packSize: 1, quantity: "10.000", rawNet: "60.00", rawGross: "60.00" })
      .where(eq(invoiceLine.id, fx.matchedInvoiceLineId));
    await approveInvoice(fx.owner, fx.invoiceId);

    const totalsBefore = await getCountTotals(fx.owner, c.id);
    const [rowBefore] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(rowBefore.active).toBe(true);
    expect(rowBefore.currentUnitCost).toBe("6.0000");

    await deactivateProduct(fx.owner, fx.pricedProductId);

    const [rowAfter] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    // `updated_at` is ON UPDATE CURRENT_TIMESTAMP at one-second resolution, so it
    // legitimately moves when `active` flips. Comparing it would fail whenever the
    // deactivate lands in a later second than the last write, which a slow
    // database makes likely. Every other column must be byte-identical.
    const withoutUpdatedAt = (r: typeof rowBefore) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "updatedAt"));
    expect(withoutUpdatedAt(rowAfter)).toEqual(withoutUpdatedAt({ ...rowBefore, active: false }));
    expect(
      await db.select().from(countLine).where(eq(countLine.productId, fx.pricedProductId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(productCostHistory)
        .where(eq(productCostHistory.productId, fx.pricedProductId)),
    ).toHaveLength(1);
    // And the count it appears in is valued exactly as before.
    expect(await getCountTotals(fx.owner, c.id)).toEqual(totalsBefore);
  });

  test("deactivating an already-deactivated product succeeds again — a double-tap or a retried request is not an error", async () => {
    await deactivateProduct(fx.owner, fx.pricedProductId);
    await deactivateProduct(fx.owner, fx.pricedProductId);
    const [row] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(row.active).toBe(false);
  });

  test("another tenant's product id is NotFound and that product stays active", async () => {
    await expect(deactivateProduct(fx.owner, fx.otherProductId)).rejects.toBeInstanceOf(NotFoundError);
    const [row] = await db.select().from(product).where(eq(product.id, fx.otherProductId));
    expect(row.active).toBe(true);
  });

  test("a product id that does not exist anywhere is NotFound", async () => {
    await expect(deactivateProduct(fx.owner, 999_999)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// getProductsByIds
// ---------------------------------------------------------------------------

describe("getProductsByIds — an exact-id lookup that survives retirement", () => {
  test("positive control: an owner gets the tenant's own products by id, cost included", async () => {
    const rows = await getProductsByIds(fx.owner, [fx.pricedProductId, fx.secondProductId]);
    expect(rows.map((r) => r.id).sort()).toEqual([fx.pricedProductId, fx.secondProductId].sort());
    const priced = rows.find((r) => r.id === fx.pricedProductId);
    expect(priced?.currentUnitCost).toBe("24.5000");
  });

  test("a DEACTIVATED product is still returned (a past invoice match must still resolve to a name)", async () => {
    await deactivateProduct(fx.owner, fx.pricedProductId);
    const rows = await getProductsByIds(fx.owner, [fx.pricedProductId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(false);
    expect(rows[0].name).toBe("Tito's Handmade Vodka");
  });

  test("another tenant's id is dropped — the answer is identical to an id that does not exist", async () => {
    const mixed = await getProductsByIds(fx.owner, [fx.pricedProductId, fx.otherProductId, 999_999]);
    expect(mixed.map((r) => r.id)).toEqual([fx.pricedProductId]);
    expect(await getProductsByIds(fx.owner, [fx.otherProductId])).toEqual([]);
    expect(await getProductsByIds(fx.owner, [999_999])).toEqual([]);
  });

  test("an empty id list is an empty result, not an invalid `IN ()` query", async () => {
    expect(await getProductsByIds(fx.owner, [])).toEqual([]);
  });

  test.each([["manager"], ["staff"]] as const)(
    "a %s gets the same rows with NO cost field anywhere in the payload (invariant 8)",
    async (who) => {
      const rows = await getProductsByIds(fx[who], [fx.pricedProductId, fx.secondProductId]);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect("currentUnitCost" in row).toBe(false);
      }
      const json = JSON.stringify(rows);
      expect(json).not.toContain("24.5");
      expect(json).not.toContain("31.25");
      expect(json.toLowerCase()).not.toContain("cost");
    },
  );
});
