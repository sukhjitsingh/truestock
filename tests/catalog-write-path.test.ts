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
import { product, productBarcode, productPar, countLine } from "@/db/schema";
import {
  linkBarcodeToProduct,
  createProduct,
  resolveBarcode,
  updateProduct,
  searchProducts,
} from "@/lib/domain/catalog";
import { openCount, incrementCountLine, scanCountLine, submitCount, reviewCount, closeCount } from "@/lib/domain/counts";
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
    // Stored in the 14-digit standard form (docs/plans/barcode-integrity, Fix 1).
    expect(rows.find((r) => r.barcode === "00082000774006")!.isPrimary).toBe(true);
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

  /** Same, with open bottles: on hand becomes fractional (`[0.5]` is half a bottle). */
  async function closeCountWithFills(productId: number, eaches: number, fills: number[]) {
    const c = await openCount(fx.owner, { type: "full" });
    await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: eaches,
      newPartialFills: fills,
    });
    await submitCount(fx.owner, c.id);
    await reviewCount(fx.owner, c.id);
    await closeCount(fx.owner, c.id);
  }

  // QA 2026-11-08, finding 4: an open bottle made on hand 1.5 and the list
  // suggested ordering "4.5" — and Copy order copied that. Nobody orders half
  // a bottle; the suggestion rounds UP so the order reaches par. On hand
  // itself stays exact.
  test("the suggested order rounds UP to a whole unit when on hand is fractional", async () => {
    await closeCountWithFills(fx.pricedProductId, 1, [0.5]);
    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: 6 });

    const [item] = (await reorderList(fx.owner)).items;
    expect(item.onHand).toBe(1.5);
    expect(item.suggestedOrderQty).toBe(5);
  });

  test("rounding is not thrown off by float noise in summed tenths", async () => {
    // Three open bottles at 0.6, 0.7 and 0.7 sum to 1.9999999999999998 in
    // floating point. A bare Math.ceil(3 − that) gives 2; the true shortfall
    // is exactly 1. Found by searching tenths combinations, 2026-11-08.
    await closeCountWithFills(fx.pricedProductId, 0, [0.6, 0.7, 0.7]);
    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: 3 });

    const [item] = (await reorderList(fx.owner)).items;
    expect(item.suggestedOrderQty).toBe(1);
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

// ---------------------------------------------------------------------------
// docs/plans/barcode-integrity, Fix 4 (slice 3): when a barcode is already
// taken, the refusal names the owning product AND its size. "Already assigned
// to Smirnoff" is useless the moment a second Smirnoff size exists — which is
// exactly when this message matters.
// ---------------------------------------------------------------------------

describe("the 'already belongs to' refusal names the owner and its size", () => {
  const CODE = "082000000013";

  test("linking a taken barcode names the owner with its size", async () => {
    await linkBarcodeToProduct(fx.owner, { productId: fx.pricedProductId, barcode: CODE, packLevel: "each" });
    const err = await linkBarcodeToProduct(fx.owner, {
      productId: fx.secondProductId,
      barcode: CODE,
      packLevel: "each",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe("This barcode already belongs to Tito's Handmade Vodka 750 ml.");
  });

  test("creating a product with a taken barcode names the owner too, and creates nothing", async () => {
    await linkBarcodeToProduct(fx.owner, { productId: fx.pricedProductId, barcode: CODE, packLevel: "each" });
    const err = await createProduct(fx.owner, {
      name: "Tito's Handmade Vodka",
      category: "Spirits",
      unitType: "bottle",
      sizeMl: 1750,
      barcode: { barcode: CODE, packLevel: "each" },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe("This barcode already belongs to Tito's Handmade Vodka 750 ml.");

    // The product insert and the barcode insert share one transaction.
    const created = await db
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.organizationId, fx.organizationId), eq(product.sizeMl, 1750)));
    expect(created).toHaveLength(0);
  });

  test("a keg owner is named by its keg size", async () => {
    const keg = await createProduct(fx.owner, {
      name: "Blue Moon Sixtel",
      category: "Beer",
      unitType: "keg",
      sizeMl: 19533,
      barcode: { barcode: CODE, packLevel: "each" },
    });
    expect(keg.id).toBeGreaterThan(0);
    const err = await linkBarcodeToProduct(fx.owner, {
      productId: fx.pricedProductId,
      barcode: CODE,
      packLevel: "each",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe("This barcode already belongs to Blue Moon Sixtel (Sixtel keg).");
  });

  test("another tenant's barcode is never named — it is not a conflict at all", async () => {
    // Invariant 9: the message must not leak another tenant's product name.
    // Per-tenant uniqueness means the same code in another org simply succeeds.
    await linkBarcodeToProduct(fx.otherOwner, { productId: fx.otherProductId, barcode: CODE, packLevel: "each" });
    const ok = await linkBarcodeToProduct(fx.owner, { productId: fx.pricedProductId, barcode: CODE, packLevel: "each" });
    expect(ok.id).toBe(fx.pricedProductId);
  });
});

// ---------------------------------------------------------------------------
// docs/plans/barcode-integrity, Fix 1 (slices 6–7): one barcode, one product,
// however the camera writes it down.
//
// The owner's bug (2026-11-05): one bottle's barcode ended up on two sizes.
// The ZXing reader reports a printed UPC-A as its 13-digit EAN-13 form (seen
// through the fake camera: 082000000013 → "0082000000013"), and the unique
// index only refuses an IDENTICAL string — so a second reading looked like a
// new barcode and could be linked to a different product.
//
// Test codes were computed with an independent check-digit / UPC-E
// implementation, not with lib/barcode.ts:
//   UPC-A 082000000013 · EAN-13 0082000000013 · UPC-E 08200103 (→ 082000000013)
//   standard 14-digit form 00082000000013
// ---------------------------------------------------------------------------

describe("one barcode, one product, in any written form", () => {
  const UPC_A = "082000000013";
  const EAN_13 = "0082000000013";
  const UPC_E = "08200103";
  const GTIN_14 = "00082000000013";

  const barcodeRows = (productId: number) =>
    db.select().from(productBarcode).where(eq(productBarcode.productId, productId));

  test("a bottle linked as UPC-A resolves when read as EAN-13", async () => {
    await linkBarcodeToProduct(fx.owner, { productId: fx.pricedProductId, barcode: UPC_A, format: "upc_a", packLevel: "each" });
    const found = await resolveBarcode(fx.owner, EAN_13, "ean_13");
    expect(found?.product.id).toBe(fx.pricedProductId);
  });

  test("…and when read as UPC-E", async () => {
    await linkBarcodeToProduct(fx.owner, { productId: fx.pricedProductId, barcode: UPC_A, format: "upc_a", packLevel: "each" });
    const found = await resolveBarcode(fx.owner, UPC_E, "upc_e");
    expect(found?.product.id).toBe(fx.pricedProductId);
  });

  test("THE BUG: the same code cannot be linked to a second product in another form", async () => {
    await linkBarcodeToProduct(fx.owner, { productId: fx.pricedProductId, barcode: UPC_A, format: "upc_a", packLevel: "each" });
    const err = await linkBarcodeToProduct(fx.owner, {
      productId: fx.secondProductId,
      barcode: EAN_13,
      format: "ean_13",
      packLevel: "each",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe("This barcode already belongs to Tito's Handmade Vodka 750 ml.");
    expect(await barcodeRows(fx.secondProductId)).toHaveLength(0);
  });

  test("creating a new size with the same code in UPC-E form is refused, and creates nothing", async () => {
    await linkBarcodeToProduct(fx.owner, { productId: fx.pricedProductId, barcode: UPC_A, format: "upc_a", packLevel: "each" });
    const err = await createProduct(fx.owner, {
      name: "Tito's Handmade Vodka",
      category: "Spirits",
      unitType: "bottle",
      sizeMl: 200,
      barcode: { barcode: UPC_E, format: "upc_e", packLevel: "each" },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    const made = await db
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.organizationId, fx.organizationId), eq(product.sizeMl, 200)));
    expect(made).toHaveLength(0);
  });

  test("the stored row holds the 14-digit standard form and the format", async () => {
    await linkBarcodeToProduct(fx.owner, { productId: fx.pricedProductId, barcode: UPC_A, format: "upc_a", packLevel: "each" });
    const [row] = await barcodeRows(fx.pricedProductId);
    expect(row.barcode).toBe(GTIN_14);
    expect(row.format).toBe("upc_a");
  });

  test("an unknown format name is stored as null, never as client text", async () => {
    await linkBarcodeToProduct(fx.owner, { productId: fx.pricedProductId, barcode: UPC_A, format: "qr_code", packLevel: "each" });
    const [row] = await barcodeRows(fx.pricedProductId);
    expect(row.format).toBeNull();
  });

  test("an 8-digit code with no format is stored exactly as read — never guessed", async () => {
    await linkBarcodeToProduct(fx.owner, { productId: fx.pricedProductId, barcode: UPC_E, packLevel: "each" });
    const [row] = await barcodeRows(fx.pricedProductId);
    expect(row.barcode).toBe(UPC_E);
  });

  test("rapid scan finds the product whatever the reading", async () => {
    await linkBarcodeToProduct(fx.owner, { productId: fx.pricedProductId, barcode: UPC_A, format: "upc_a", packLevel: "each" });
    const count = await openCount(fx.owner, { type: "spot" });
    const line = await scanCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: count.id,
      barcode: EAN_13,
      format: "ean_13",
      locationId: fx.locationId,
      qty: 1,
    });
    expect(line.productId).toBe(fx.pricedProductId);
    const [stored] = await db.select().from(countLine).where(eq(countLine.countId, count.id));
    expect(stored.sealedEachQty).toBe(1);
  });

  test("two tenants may still hold the same code, in any form", async () => {
    await linkBarcodeToProduct(fx.otherOwner, { productId: fx.otherProductId, barcode: EAN_13, format: "ean_13", packLevel: "each" });
    const mine = await linkBarcodeToProduct(fx.owner, { productId: fx.pricedProductId, barcode: UPC_A, format: "upc_a", packLevel: "each" });
    expect(mine.id).toBe(fx.pricedProductId);
  });

  test("another tenant's code never resolves here, in any form", async () => {
    await linkBarcodeToProduct(fx.otherOwner, { productId: fx.otherProductId, barcode: UPC_A, format: "upc_a", packLevel: "each" });
    expect(await resolveBarcode(fx.owner, EAN_13, "ean_13")).toBeNull();
    expect(await resolveBarcode(fx.owner, UPC_A, "upc_a")).toBeNull();
  });
});
