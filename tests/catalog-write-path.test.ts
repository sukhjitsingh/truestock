/**
 * The catalog write paths that the MVP gap audit (docs/mvp-gaps.md) found
 * missing, against a real MariaDB.
 *
 * Two of the three findings covered here were *silent* — no error, no failed
 * request, just a screen confidently reporting a wrong answer:
 *
 *  - Finding A: nothing could write `product_par`, so the reorder list
 *    returned an empty array forever and rendered "Nothing is below its
 *    reorder point". True-looking, and structurally incapable of being false.
 *  - Finding B: a scanned barcode could only ever CREATE a product. Typing
 *    the catalog's own name hit a unique-key error with no way forward;
 *    typing a slightly different one succeeded and duplicated the product.
 *
 * So the assertions here are mostly about what is in the database afterwards,
 * not about what the function returned. A function that returns a plausible
 * object while writing nothing is exactly the failure being tested for.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { db, closePool } from "@/db";
import { product, productBarcode, productPar } from "@/db/schema";
import {
  linkBarcodeToProduct,
  resolveBarcode,
  updateProduct,
  searchProducts,
} from "@/lib/domain/catalog";
import { openCount, incrementCountLine, submitCount, reviewCount, closeCount } from "@/lib/domain/counts";
import { reorderList } from "@/lib/domain/reports";
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

// ---------------------------------------------------------------------------
// Finding B — a scanned barcode can be attached to a product that exists
// ---------------------------------------------------------------------------

describe("linking a barcode to an existing product", () => {
  test("the barcode resolves to that product afterwards", async () => {
    await linkBarcodeToProduct(fx.owner, {
      productId: fx.pricedProductId,
      barcode: "082000774006",
      packLevel: "each",
    });

    // resolveBarcode is the read the counting screen actually makes, so
    // asserting through it proves the whole loop rather than just the insert.
    const resolved = await resolveBarcode(fx.owner, "082000774006");
    expect(resolved).not.toBeNull();
    expect(resolved!.product.id).toBe(fx.pricedProductId);
    expect(resolved!.packLevel).toBe("each");
  });

  test("no second product is created — this was the whole bug", async () => {
    const before = await searchProducts(fx.owner, {
      activeOnly: false,
      limit: 100,
      includeOnHand: false,
    });

    await linkBarcodeToProduct(fx.owner, {
      productId: fx.pricedProductId,
      barcode: "082000774006",
      packLevel: "each",
    });

    const after = await searchProducts(fx.owner, {
      activeOnly: false,
      limit: 100,
      includeOnHand: false,
    });
    expect(after).toHaveLength(before.length);
  });

  test("the first barcode is primary and later ones are not", async () => {
    await linkBarcodeToProduct(fx.owner, {
      productId: fx.pricedProductId,
      barcode: "082000774006",
      packLevel: "each",
    });
    await linkBarcodeToProduct(fx.owner, {
      productId: fx.pricedProductId,
      barcode: "10082000774003",
      packLevel: "case",
    });

    const rows = await db
      .select()
      .from(productBarcode)
      .where(eq(productBarcode.productId, fx.pricedProductId));

    expect(rows).toHaveLength(2);
    // Derived server-side, never taken from the client — two primaries on one
    // product is a state no constraint forbids and nothing would notice.
    expect(rows.filter((r) => r.isPrimary)).toHaveLength(1);
    expect(rows.find((r) => r.barcode === "082000774006")!.isPrimary).toBe(true);
  });

  test("pack_level is stored as given — a case carton is not an each", async () => {
    await linkBarcodeToProduct(fx.owner, {
      productId: fx.pricedProductId,
      barcode: "10082000774003",
      packLevel: "case",
    });

    const resolved = await resolveBarcode(fx.owner, "10082000774003");
    // Getting this wrong miscounts beer silently, by exactly the case size.
    expect(resolved!.packLevel).toBe("case");
  });

  test("a barcode already assigned is refused, and the error names the owner", async () => {
    await linkBarcodeToProduct(fx.owner, {
      productId: fx.pricedProductId,
      barcode: "082000774006",
      packLevel: "each",
    });

    const attempt = linkBarcodeToProduct(fx.owner, {
      productId: fx.secondProductId,
      barcode: "082000774006",
      packLevel: "each",
    });

    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    // Mid-count, "already assigned" without a name is a dead end.
    await expect(attempt).rejects.toThrow(/Tito's Handmade Vodka/);
  });

  test("a cross-tenant productId is refused as NotFound, not as a foreign-key error", async () => {
    // Invariant 9: the answer must not confirm the row is real. The composite
    // tenant FK would also reject this, but as an opaque 1452 — which is a
    // different (and worse) answer than "no such product".
    const attempt = linkBarcodeToProduct(fx.owner, {
      productId: fx.otherProductId,
      barcode: "082000774006",
      packLevel: "each",
    });

    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

    const rows = await db
      .select()
      .from(productBarcode)
      .where(eq(productBarcode.barcode, "082000774006"));
    expect(rows).toHaveLength(0);
  });

  test("two tenants can enrol the same UPC against their own products", async () => {
    await linkBarcodeToProduct(fx.owner, {
      productId: fx.pricedProductId,
      barcode: "082000774006",
      packLevel: "each",
    });
    await linkBarcodeToProduct(fx.otherOwner, {
      productId: fx.otherProductId,
      barcode: "082000774006",
      packLevel: "each",
    });

    // Each tenant resolves the same code to their OWN product. A globally
    // unique barcode would make the first bar to scan a Tito's own that code
    // for every customer.
    const mine = await resolveBarcode(fx.owner, "082000774006");
    const theirs = await resolveBarcode(fx.otherOwner, "082000774006");
    expect(mine!.product.id).toBe(fx.pricedProductId);
    expect(theirs!.product.id).toBe(fx.otherProductId);
  });
});

// ---------------------------------------------------------------------------
// Finding A — par levels are writable, so the reorder list can produce a row
// ---------------------------------------------------------------------------

describe("par levels", () => {
  test("writes an overall (location_id IS NULL) row — the MVP convention", async () => {
    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: 12 });

    const rows = await db
      .select()
      .from(productPar)
      .where(eq(productPar.productId, fx.pricedProductId));

    expect(rows).toHaveLength(1);
    // Null location keeps CLAUDE.md's open question 2 open rather than
    // answering it by accident.
    expect(rows[0].locationId).toBeNull();
    expect(rows[0].parLevel).toBe("12.00");
  });

  test("a second write updates the row rather than adding another", async () => {
    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: 12 });
    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: 18 });

    const rows = await db
      .select()
      .from(productPar)
      .where(eq(productPar.productId, fx.pricedProductId));

    expect(rows).toHaveLength(1);
    expect(rows[0].parLevel).toBe("18.00");
  });

  test("a null par level clears the row", async () => {
    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: 12 });
    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: null });

    const rows = await db
      .select()
      .from(productPar)
      .where(eq(productPar.productId, fx.pricedProductId));
    expect(rows).toHaveLength(0);
  });

  test("omitting par entirely leaves an existing one alone", async () => {
    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: 12 });
    // A caller editing only the name must not silently wipe the par — which
    // is why the schema distinguishes undefined from null.
    await updateProduct(fx.owner, { productId: fx.pricedProductId, name: "Tito's Vodka" });

    const rows = await db
      .select()
      .from(productPar)
      .where(eq(productPar.productId, fx.pricedProductId));
    expect(rows).toHaveLength(1);
    expect(rows[0].parLevel).toBe("12.00");
  });

  test("fractional pars survive — half a keg is a legitimate target", async () => {
    await updateProduct(fx.owner, {
      productId: fx.pricedProductId,
      parLevel: 2.5,
      reorderPoint: 1.25,
    });

    const [row] = await db
      .select()
      .from(productPar)
      .where(eq(productPar.productId, fx.pricedProductId));
    expect(row.parLevel).toBe("2.50");
    expect(row.reorderPoint).toBe("1.25");
  });

  test("a save that changes nothing is not an error", async () => {
    // mysql2 does not set CLIENT_FOUND_ROWS, so `affectedRows` counts rows
    // CHANGED. The previous implementation read 0 as "product not found" and
    // threw. Par levels make "save the form having only touched the par" an
    // ordinary action, so this stopped being theoretical.
    const first = await updateProduct(fx.owner, {
      productId: fx.pricedProductId,
      name: "Tito's Handmade Vodka",
    });
    expect(first.id).toBe(fx.pricedProductId);

    const again = await updateProduct(fx.owner, {
      productId: fx.pricedProductId,
      name: "Tito's Handmade Vodka",
    });
    expect(again.id).toBe(fx.pricedProductId);
  });

  test("a cross-tenant productId is refused", async () => {
    const attempt = updateProduct(fx.owner, {
      productId: fx.otherProductId,
      parLevel: 12,
    });
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

    const rows = await db
      .select()
      .from(productPar)
      .where(eq(productPar.productId, fx.otherProductId));
    expect(rows).toHaveLength(0);
  });

  test("the catalog reports needs_par until one is set", async () => {
    const before = await searchProducts(fx.owner, {
      activeOnly: true,
      limit: 100,
      includeOnHand: true,
    });
    const target = before.find((p) => p.id === fx.pricedProductId)!;
    expect(target.incomplete).toContain("needs_par");

    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: 12 });

    const after = await searchProducts(fx.owner, {
      activeOnly: true,
      limit: 100,
      includeOnHand: true,
    });
    expect(after.find((p) => p.id === fx.pricedProductId)!.incomplete).not.toContain("needs_par");
  });
});

describe("the reorder list", () => {
  /** Closes a count holding `eaches` of one product — reorder reads closed counts only. */
  async function closeCountWith(productId: number, eaches: number) {
    const c = await openCount(fx.owner, { type: "full" });
    await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: eaches,
      newPartialFills: [],
    });
    await submitCount(fx.owner, c.id);
    await reviewCount(fx.owner, c.id);
    await closeCount(fx.owner, c.id);
    return c.id;
  }

  test("produces a row once a par exists and on-hand is below it", async () => {
    await closeCountWith(fx.pricedProductId, 3);
    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: 12 });

    const list = await reorderList(fx.owner);

    // Before finding A was fixed this array was unconditionally empty.
    expect(list.items).toHaveLength(1);
    expect(list.items[0].productId).toBe(fx.pricedProductId);
    expect(list.items[0].onHand).toBe(3);
    expect(list.items[0].parLevel).toBe(12);
    expect(list.items[0].suggestedOrderQty).toBe(9);
  });

  test("distinguishes 'nothing is short' from 'no par exists anywhere'", async () => {
    await closeCountWith(fx.pricedProductId, 30);

    // No par set: structurally incapable of producing a row.
    const withoutPar = await reorderList(fx.owner);
    expect(withoutPar.items).toHaveLength(0);
    expect(withoutPar.productsWithPar).toBe(0);

    // Par set and comfortably met: genuinely nothing to order. Same empty
    // items array, and the screens must not say the same thing about both.
    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: 12 });
    const wellStocked = await reorderList(fx.owner);
    expect(wellStocked.items).toHaveLength(0);
    expect(wellStocked.productsWithPar).toBe(1);
  });

  test("the reorder point, not the par, is the trigger when one is set", async () => {
    await closeCountWith(fx.pricedProductId, 8);
    await updateProduct(fx.owner, {
      productId: fx.pricedProductId,
      parLevel: 12,
      reorderPoint: 6,
    });

    // 8 on hand is below par (12) but above the reorder point (6), so this is
    // deliberately NOT short yet — that distinction is the whole reason a
    // separate reorder point exists.
    const list = await reorderList(fx.owner);
    expect(list.items).toHaveLength(0);
    expect(list.productsWithPar).toBe(1);
  });

  test("another tenant's par never appears", async () => {
    await closeCountWith(fx.pricedProductId, 1);
    await updateProduct(fx.otherOwner, { productId: fx.otherProductId, parLevel: 99 });

    const list = await reorderList(fx.owner);
    expect(list.items.every((i) => i.productId !== fx.otherProductId)).toBe(true);
  });

  test("par rows are scoped to the tenant on read", async () => {
    await updateProduct(fx.otherOwner, { productId: fx.otherProductId, parLevel: 99 });

    const rows = await db
      .select()
      .from(productPar)
      .where(
        and(
          eq(productPar.organizationId, fx.organizationId),
          isNull(productPar.locationId),
        ),
      );
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Slice 4 — inline cost/case-size editing in the catalog table.
//
// This is a UI-only slice (Gate 2 Decision 7): `updateProductAction` and
// `productUpdateSchema` are reused UNCHANGED, one call per cell commit. There
// is no new domain code to exercise here — these tests call `updateProduct`
// directly, the same domain function the existing par-level tests above
// already cover, with the specific per-cell shapes the inline editor sends
// (a single field at a time) and the role split (cost owner-only, case size
// owner+manager) that the client component's column visibility depends on.
// ---------------------------------------------------------------------------

describe("inline cost/case-size editing (per-cell updateProductAction)", () => {
  test("owner's cost edit lands in the database", async () => {
    const updated = await updateProduct(fx.owner, {
      productId: fx.unpricedProductId,
      currentUnitCost: "12.3400",
    });
    expect(updated.currentUnitCost).toBe("12.3400");

    const [row] = await db.select().from(product).where(eq(product.id, fx.unpricedProductId));
    expect(row.currentUnitCost).toBe("12.3400");
  });

  test("manager's cost edit is silently stripped while other fields in the same call still save", async () => {
    const updated = await updateProduct(fx.manager, {
      productId: fx.unpricedProductId,
      name: "House Infusion (Batch 2)",
      currentUnitCost: "9.9900",
    });

    // The name half of the same call landed...
    expect(updated.name).toBe("House Infusion (Batch 2)");
    // ...but a manager's ProductSummary never carries `currentUnitCost` at
    // all (invariant 8) — check the actual row instead of the response.
    expect(updated).not.toHaveProperty("currentUnitCost");

    const [row] = await db.select().from(product).where(eq(product.id, fx.unpricedProductId));
    expect(row.currentUnitCost).toBeNull();
  });

  test("manager's case-size edit lands — case size is owner+manager, cost is owner-only, in the same row", async () => {
    const updated = await updateProduct(fx.manager, {
      productId: fx.pricedProductId,
      caseSize: 24,
      // Sent in the same call as the case-size edit on purpose — a manager's
      // request that also includes a cost field must still save the
      // case-size half, not be refused wholesale.
      currentUnitCost: "1.2300",
    });

    expect(updated.caseSize).toBe(24);

    const [row] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(row.caseSize).toBe(24);
    // The fixture's original cost ("24.5000") is untouched — the manager's
    // "1.2300" never reached the database.
    expect(row.currentUnitCost).toBe("24.5000");
  });

  test("submitting currentUnitCost: null clears the column to NULL, never 0.00", async () => {
    await updateProduct(fx.owner, { productId: fx.pricedProductId, currentUnitCost: null });

    const [row] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(row.currentUnitCost).toBeNull();
  });
});
