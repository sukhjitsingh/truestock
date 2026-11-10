/**
 * Retire a vendor (#49) — Slice 1: the schema column, the guard, and the four
 * guarded writes (docs/plans/vendor-retire/03-program-design.md §4).
 *
 * `deactivateVendor` does not exist yet (Slice 2), so every test retires a
 * vendor with a direct `UPDATE vendor SET active = false`.
 *
 * Invariants touched: 6 (refuse a retired vendor on the WRITE path, above any
 * existing-row lookup), 9 (a cross-tenant or missing vendor id stays NotFound,
 * never "retired"), 1/2-style immutability is untouched.
 *
 * Owner decision 4: an invoice already in review is NOT guarded. The submit /
 * approve / alias / reject tests below assert those paths SUCCEED.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { invoice, product, productPar, productCostHistory, vendor, vendorAlias, invoiceLine } from "@/db/schema";
import { assignVendorToProducts, createProduct, listVendors, updateProduct } from "@/lib/domain/catalog";
import { createInvoiceForUpload, listInvoicesForOwner, updateInvoiceStatus } from "@/lib/domain/invoices";
import { approveInvoice } from "@/lib/domain/invoice-approval";
import { submitInvoiceReview } from "@/lib/domain/invoice-lines";
import { previewAuditPacket } from "@/lib/domain/audit-packets";
import { reorderList } from "@/lib/domain/reports";
import { assertVendorActive } from "@/lib/domain/vendor-active";
import { NotFoundError, VendorRetiredError } from "@/lib/domain/errors";
import { openCount, incrementCountLine, submitCount, reviewCount, closeCount } from "@/lib/domain/counts";
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

async function retire(vendorId: number): Promise<void> {
  await db.update(vendor).set({ active: false }).where(eq(vendor.id, vendorId));
}

async function productRow(id: number) {
  const [row] = await db.select().from(product).where(eq(product.id, id));
  return row;
}

function uploadInput(vendorId: number, shaChar = "a") {
  return {
    vendorId,
    source: "pdf" as const,
    contentType: "application/pdf",
    fileSha256: shaChar.repeat(64),
    fileSizeBytes: 100,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The four guarded writes
// ---------------------------------------------------------------------------

describe("each guarded write refuses a retired vendor with VENDOR_RETIRED and writes nothing", () => {
  test("createProduct — no product row inserted", async () => {
    await retire(fx.vendorId);
    const before = await db.select().from(product).where(eq(product.organizationId, fx.organizationId));

    const attempt = createProduct(fx.owner, {
      name: "New Gin",
      category: "Spirits",
      unitType: "bottle",
      sizeMl: 750,
      vendorId: fx.vendorId,
    });
    await expect(attempt).rejects.toBeInstanceOf(VendorRetiredError);
    await expect(attempt).rejects.toMatchObject({ code: "VENDOR_RETIRED" });
    await expect(attempt).rejects.toThrow(/Test Distributor is retired/);

    const after = await db.select().from(product).where(eq(product.organizationId, fx.organizationId));
    expect(after).toHaveLength(before.length);
    expect(after.some((p) => p.name === "New Gin")).toBe(false);
  });

  test("updateProduct with vendorId — name and par in the same patch are not saved", async () => {
    await retire(fx.vendorId);
    const before = await productRow(fx.pricedProductId);

    const attempt = updateProduct(fx.owner, {
      productId: fx.pricedProductId,
      name: "Renamed",
      parLevel: 9,
      vendorId: fx.vendorId,
    });
    await expect(attempt).rejects.toBeInstanceOf(VendorRetiredError);

    const after = await productRow(fx.pricedProductId);
    expect(after.name).toBe(before.name);
    expect(after.vendorId).toBeNull();
    const pars = await db.select().from(productPar).where(eq(productPar.productId, fx.pricedProductId));
    expect(pars).toHaveLength(0);
  });

  test("assignVendorToProducts — no product changed, with several ids", async () => {
    await retire(fx.vendorId);

    const attempt = assignVendorToProducts(fx.owner, {
      productIds: [fx.pricedProductId, fx.secondProductId, fx.unpricedProductId],
      vendorId: fx.vendorId,
    });
    await expect(attempt).rejects.toBeInstanceOf(VendorRetiredError);

    for (const id of [fx.pricedProductId, fx.secondProductId, fx.unpricedProductId]) {
      expect((await productRow(id)).vendorId).toBeNull();
    }
  });

  test("createInvoiceForUpload — no invoice row", async () => {
    await retire(fx.vendorId);
    const before = await db.select().from(invoice).where(eq(invoice.organizationId, fx.organizationId));

    await expect(createInvoiceForUpload(fx.owner, uploadInput(fx.vendorId))).rejects.toBeInstanceOf(
      VendorRetiredError,
    );

    const after = await db.select().from(invoice).where(eq(invoice.organizationId, fx.organizationId));
    expect(after).toHaveLength(before.length);
  });
});

// ---------------------------------------------------------------------------
// Guard ordering (invariant 6: above any existing-row lookup) and tenancy
// ---------------------------------------------------------------------------

describe("guard runs above other lookups", () => {
  test("updateProduct with a retired vendor and a nonexistent product throws VENDOR_RETIRED, not NotFound(Product)", async () => {
    await retire(fx.vendorId);
    const attempt = updateProduct(fx.owner, { productId: 999_999, vendorId: fx.vendorId, name: "x" });
    await expect(attempt).rejects.toBeInstanceOf(VendorRetiredError);
  });

  test("assignVendorToProducts with a retired vendor and a foreign product id throws VENDOR_RETIRED", async () => {
    await retire(fx.vendorId);
    const attempt = assignVendorToProducts(fx.owner, {
      productIds: [fx.otherProductId],
      vendorId: fx.vendorId,
    });
    await expect(attempt).rejects.toBeInstanceOf(VendorRetiredError);
  });

  test("companion: a cross-tenant vendor id with a nonexistent product is still NotFound(Vendor), never 'retired'", async () => {
    await retire(fx.otherVendorId);

    const upd = updateProduct(fx.owner, { productId: 999_999, vendorId: fx.otherVendorId, name: "x" });
    await expect(upd).rejects.toBeInstanceOf(NotFoundError);
    await expect(upd).rejects.toThrow(/Vendor not found/);

    const assign = assignVendorToProducts(fx.owner, {
      productIds: [999_999],
      vendorId: fx.otherVendorId,
    });
    await expect(assign).rejects.toThrow(/Vendor not found/);

    await expect(
      createProduct(fx.owner, {
        name: "Probe",
        category: "Spirits",
        unitType: "bottle",
        sizeMl: 750,
        vendorId: fx.otherVendorId,
      }),
    ).rejects.toThrow(/Vendor not found/);

    await expect(createInvoiceForUpload(fx.owner, uploadInput(fx.otherVendorId, "b"))).rejects.toThrow(
      /Vendor not found/,
    );

    // The other tenant's row is untouched by any of the above.
    const [row] = await db.select().from(vendor).where(eq(vendor.id, fx.otherVendorId));
    expect(row.active).toBe(false); // only our own direct UPDATE above
  });

  test("assertVendorActive: nonexistent id is NotFound; active vendor returns {id, name}", async () => {
    await db.transaction(async (tx) => {
      await expect(assertVendorActive(tx, fx.organizationId, 999_999)).rejects.toBeInstanceOf(NotFoundError);
      expect(await assertVendorActive(tx, fx.organizationId, fx.vendorId)).toEqual({
        id: fx.vendorId,
        name: "Test Distributor",
      });
    });
  });
});

describe("clearing and leaving the vendor out", () => {
  test("clearing the vendor (vendorId: null) is allowed for updateProduct and assignVendorToProducts, even when the current vendor is retired", async () => {
    await assignVendorToProducts(fx.owner, {
      productIds: [fx.pricedProductId, fx.secondProductId],
      vendorId: fx.vendorId,
    });
    await retire(fx.vendorId);

    await updateProduct(fx.owner, { productId: fx.pricedProductId, vendorId: null });
    expect((await productRow(fx.pricedProductId)).vendorId).toBeNull();

    await assignVendorToProducts(fx.owner, { productIds: [fx.secondProductId], vendorId: null });
    expect((await productRow(fx.secondProductId)).vendorId).toBeNull();
  });

  test("a save that leaves vendorId out succeeds for a product linked to a retired vendor, and the link is kept", async () => {
    await assignVendorToProducts(fx.owner, { productIds: [fx.pricedProductId], vendorId: fx.vendorId });
    await retire(fx.vendorId);

    await updateProduct(fx.owner, { productId: fx.pricedProductId, name: "Titos Renamed", parLevel: 6 });

    const row = await productRow(fx.pricedProductId);
    expect(row.name).toBe("Titos Renamed");
    expect(row.vendorId).toBe(fx.vendorId);
  });

  test("retiring keeps products linked", async () => {
    await assignVendorToProducts(fx.owner, {
      productIds: [fx.pricedProductId, fx.secondProductId],
      vendorId: fx.vendorId,
    });
    await retire(fx.vendorId);
    expect((await productRow(fx.pricedProductId)).vendorId).toBe(fx.vendorId);
    expect((await productRow(fx.secondProductId)).vendorId).toBe(fx.vendorId);
  });
});

// ---------------------------------------------------------------------------
// Owner decision 4: invoices already in review complete normally
// ---------------------------------------------------------------------------

async function submitAndApproveFixtureInvoice() {
  await db.update(invoiceLine).set({ vendorItemCode: "SKU-RETIRE-1" }).where(eq(invoiceLine.id, fx.invoiceLineId));
  await submitInvoiceReview(fx.owner, fx.invoiceId, [
    { id: fx.invoiceLineId, matchedProductId: fx.pricedProductId },
  ]);
}

describe("an invoice in review whose vendor is retired is not held", () => {
  test("can be submitted and approved, and its costs post", async () => {
    await retire(fx.vendorId);

    await submitAndApproveFixtureInvoice();
    const [reviewed] = await db.select().from(invoice).where(eq(invoice.id, fx.invoiceId));
    expect(reviewed.status).toBe("reviewed");

    await approveInvoice(fx.owner, fx.invoiceId);
    const [approved] = await db.select().from(invoice).where(eq(invoice.id, fx.invoiceId));
    expect(approved.status).toBe("approved");

    const history = await db
      .select()
      .from(productCostHistory)
      .where(eq(productCostHistory.sourceInvoiceId, fx.invoiceId));
    expect(history.length).toBeGreaterThan(0);
  });

  test("alias learning still records aliases for that invoice", async () => {
    await retire(fx.vendorId);
    await submitAndApproveFixtureInvoice();

    const aliases = await db
      .select()
      .from(vendorAlias)
      .where(and(eq(vendorAlias.organizationId, fx.organizationId), eq(vendorAlias.vendorId, fx.vendorId)));
    expect(aliases.some((a) => a.vendorItemCode === "SKU-RETIRE-1" && a.productId === fx.pricedProductId)).toBe(
      true,
    );
  });

  test("rejectInvoice on an invoice of a retired vendor still works", async () => {
    await retire(fx.vendorId);
    const res = await updateInvoiceStatus(
      fx.owner,
      fx.invoiceId,
      ["needs_review", "reviewed"],
      "rejected",
      { rejectionReason: "wrong vendor" },
    );
    expect(res.status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// Concurrency: the guard is a locking read
// ---------------------------------------------------------------------------

describe("race: the guard is a locking read", () => {
  test("retire in an open tx makes a concurrent product write block, then fail", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));

    const retiring = db.transaction(async (tx) => {
      await tx.update(vendor).set({ active: false }).where(eq(vendor.id, fx.vendorId));
      locked();
      await hold;
    });
    await lockedP;

    let settled = false;
    const write = updateProduct(fx.owner, {
      productId: fx.pricedProductId,
      name: "Raced Rename",
      vendorId: fx.vendorId,
    }).then(
      () => {
        settled = true;
        return null;
      },
      (e: unknown) => {
        settled = true;
        return e;
      },
    );

    let err: unknown;
    try {
      await sleep(500);
      expect(settled).toBe(false); // blocked on the vendor row lock, not decided by a stale snapshot
    } finally {
      // Always release, so a failed assertion cannot leave a transaction
      // holding the vendor row and cascade timeouts through later tests.
      release();
      await retiring;
      err = await write;
    }
    expect(err).toBeInstanceOf(VendorRetiredError);

    const row = await productRow(fx.pricedProductId);
    expect(row.name).not.toBe("Raced Rename");
    expect(row.vendorId).toBeNull();
  });

  test("mirror: a writer holding the lock first makes the retire wait, and every later write is refused", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));

    const writer = db.transaction(async (tx) => {
      await assertVendorActive(tx, fx.organizationId, fx.vendorId);
      locked();
      await hold;
      await tx.update(product).set({ vendorId: fx.vendorId }).where(eq(product.id, fx.pricedProductId));
    });
    await lockedP;

    let retireSettled = false;
    const retiring = retire(fx.vendorId).then(() => {
      retireSettled = true;
    });

    try {
      await sleep(500);
      expect(retireSettled).toBe(false);
    } finally {
      release();
      await writer;
      await retiring;
    }

    // The in-flight write landed before the retire; every write after it is refused.
    expect((await productRow(fx.pricedProductId)).vendorId).toBe(fx.vendorId);
    await expect(
      updateProduct(fx.owner, { productId: fx.secondProductId, vendorId: fx.vendorId }),
    ).rejects.toBeInstanceOf(VendorRetiredError);
    expect((await productRow(fx.secondProductId)).vendorId).toBeNull();
  });
});

describe("success metric", () => {
  test("nothing gains the retired vendor after retirement", async () => {
    await assignVendorToProducts(fx.owner, { productIds: [fx.pricedProductId], vendorId: fx.vendorId });
    await retire(fx.vendorId);

    const counts = async () => ({
      products: (await db.select().from(product).where(eq(product.vendorId, fx.vendorId))).length,
      invoices: (await db.select().from(invoice).where(eq(invoice.vendorId, fx.vendorId))).length,
    });
    const atRetirement = await counts();

    const attempts: Array<() => Promise<unknown>> = [
      () =>
        createProduct(fx.owner, {
          name: "Late Gin",
          category: "Spirits",
          unitType: "bottle",
          sizeMl: 750,
          vendorId: fx.vendorId,
        }),
      () => updateProduct(fx.owner, { productId: fx.secondProductId, vendorId: fx.vendorId }),
      () => assignVendorToProducts(fx.owner, { productIds: [fx.unpricedProductId], vendorId: fx.vendorId }),
      () => createInvoiceForUpload(fx.owner, uploadInput(fx.vendorId, "c")),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(VendorRetiredError);
    }

    expect(await counts()).toEqual(atRetirement);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("listVendors", () => {
  test("is active-only by default; includeInactive returns both with correct active and productCount", async () => {
    const [second] = await db
      .insert(vendor)
      .values({ organizationId: fx.organizationId, name: "Old Supplier" })
      .$returningId();
    await assignVendorToProducts(fx.owner, {
      productIds: [fx.pricedProductId, fx.secondProductId, fx.unpricedProductId],
      vendorId: second.id,
    });
    // An inactive product is not counted.
    await db.update(product).set({ active: false }).where(eq(product.id, fx.unpricedProductId));
    await retire(second.id);

    const defaults = await listVendors(fx.owner);
    expect(defaults.map((v) => v.id)).toEqual([fx.vendorId]);
    expect(defaults[0].active).toBe(true);
    expect(defaults[0].productCount).toBe(0);

    const all = await listVendors(fx.owner, { includeInactive: true });
    expect(all.map((v) => v.id).sort()).toEqual([fx.vendorId, second.id].sort());
    const retired = all.find((v) => v.id === second.id)!;
    expect(retired.active).toBe(false);
    expect(retired.productCount).toBe(2);
    expect(typeof retired.productCount).toBe("number");
    // Other tenants' vendors never appear.
    expect(all.some((v) => v.id === fx.otherVendorId)).toBe(false);
  });
});

describe("reorderList", () => {
  test("sorts retired-vendor items first and sets vendorActive (true for vendorless)", async () => {
    // Items must be below par: set par on three products, count one of them.
    const [v2] = await db
      .insert(vendor)
      .values({ organizationId: fx.organizationId, name: "Aaa Active Vendor" })
      .$returningId();
    // priced -> retired vendor ("Test Distributor"), second -> active vendor, unpriced -> no vendor.
    await assignVendorToProducts(fx.owner, { productIds: [fx.pricedProductId], vendorId: fx.vendorId });
    await assignVendorToProducts(fx.owner, { productIds: [fx.secondProductId], vendorId: v2.id });
    for (const id of [fx.pricedProductId, fx.secondProductId, fx.unpricedProductId]) {
      await updateProduct(fx.owner, { productId: id, parLevel: 10 });
    }
    await retire(fx.vendorId);

    // reorderList reads on-hand from the latest CLOSED count.
    const c = await openCount(fx.owner, { type: "full" });
    await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 1,
      newPartialFills: [],
    });
    await submitCount(fx.owner, c.id);
    await reviewCount(fx.owner, c.id);
    await closeCount(fx.owner, c.id);

    const res = await reorderList(fx.owner);
    const byProduct = new Map(res.items.map((i) => [i.productId, i]));
    expect(byProduct.get(fx.pricedProductId)!.vendorActive).toBe(false);
    expect(byProduct.get(fx.secondProductId)!.vendorActive).toBe(true);
    expect(byProduct.get(fx.unpricedProductId)!.vendorActive).toBe(true);
    expect(byProduct.get(fx.unpricedProductId)!.vendorId).toBeNull();

    // Retired first, even though "Aaa Active Vendor" sorts before "Test Distributor".
    expect(res.items[0].productId).toBe(fx.pricedProductId);
    expect(res.items.slice(1).every((i) => i.vendorActive)).toBe(true);
  });
});

describe("history stays readable", () => {
  test("audit packet preview still names a retired vendor", async () => {
    await retire(fx.vendorId);
    // The fixture invoice (2026-06-01, needs_review) is listed as omitted, with its vendor name.
    const preview = await previewAuditPacket(fx.owner, { dateFrom: "2026-05-01", dateTo: "2026-07-01" });
    const row = preview.omitted.find((o) => o.invoiceId === fx.invoiceId);
    expect(row?.vendorName).toBe("Test Distributor");
  });

  test("invoices of a retired vendor stay readable (listInvoices filtered by vendorId)", async () => {
    await retire(fx.vendorId);
    const rows = await listInvoicesForOwner(fx.owner, { vendorId: fx.vendorId });
    expect(rows.map((r) => r.id)).toContain(fx.invoiceId);
  });
});
