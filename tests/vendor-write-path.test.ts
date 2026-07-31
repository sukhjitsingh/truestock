/**
 * Vendor write path — open item #19 / docs/mvp-gaps.md finding H.
 *
 * Nothing wrote the `vendor` table: no server action, no seed. So
 * `listVendorsAction` always returned `[]`, the vendor `<select>` on the
 * product form was permanently empty, every product's `vendor_id` stayed
 * NULL, and `/office/reorder` grouped every row under "No vendor set" — the
 * one thing spec §9.3 wants the reorder list to do. Same failure shape as
 * catalog-write-path.test.ts's Finding A: nothing throws, the screen just
 * confidently renders a wrong (empty) answer forever.
 *
 * So, as there, the assertions below are mostly about what ends up in the
 * database — and, for `assignVendorToProducts`, about what does NOT change
 * when the call is refused — not about what the function returned.
 *
 * Role gating for the three vendor actions (create/update/assign) lives
 * entirely in app/actions/catalog.ts's `requireRole("owner", "manager")` —
 * the domain functions in lib/domain/catalog.ts take an `Actor` but never
 * inspect `.role` themselves. Proving that gate holds means calling the
 * actions, which call `requireSession()`, which calls Better Auth's
 * `auth.api.getSession()` and Next's `headers()` — neither of which resolves
 * outside a real request. Both are mocked, `next/headers` to a no-op and
 * `@/lib/auth` to a fake session keyed off `asUser(...)` below, so that
 * `requireSession`'s own DB lookup (role, active, organizationId — the part
 * actually under test) still runs for real. This has to happen before
 * anything in this file imports `@/app/actions/catalog`, directly or
 * transitively — see the dynamic `import()` inside `describe("role gating"...)`
 * below, rather than a static import at the top of the file.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { product, vendor } from "@/db/schema";
import { createVendor, updateVendor, assignVendorToProducts, listVendors } from "@/lib/domain/catalog";
import { openCount, incrementCountLine, submitCount, reviewCount, closeCount } from "@/lib/domain/counts";
import { reorderList } from "@/lib/domain/reports";
import { NotFoundError } from "@/lib/domain/errors";
import { migrateTestDatabase, resetDatabase, createFixtures, newClientLineId, type Fixtures } from "./helpers/test-db";

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
// createVendor / updateVendor
// ---------------------------------------------------------------------------

describe("createVendor", () => {
  test("writes a row scoped to the actor's organization", async () => {
    const created = await createVendor(fx.owner, { name: "Southern Wine & Spirits" });

    const rows = await db.select().from(vendor).where(eq(vendor.id, created.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(fx.organizationId);
    expect(rows[0].name).toBe("Southern Wine & Spirits");
  });
});

describe("updateVendor", () => {
  test("changes fields in place — no second row", async () => {
    const created = await createVendor(fx.owner, { name: "Breakthru Beverage" });

    await updateVendor(fx.owner, { id: created.id, contact: "orders@breakthru.example", leadTimeDays: 3 });

    const rows = await db.select().from(vendor).where(eq(vendor.organizationId, fx.organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.id);
    expect(rows[0].name).toBe("Breakthru Beverage");
    expect(rows[0].contact).toBe("orders@breakthru.example");
    expect(rows[0].leadTimeDays).toBe(3);
  });

  test("a cross-tenant vendor id is refused as NotFound — never an answer that confirms the row is real", async () => {
    const theirs = await createVendor(fx.otherOwner, { name: "Their Distributor" });

    const attempt = updateVendor(fx.owner, { id: theirs.id, contact: "hijacked@example.com" });
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

    const [row] = await db.select().from(vendor).where(eq(vendor.id, theirs.id));
    expect(row.contact).toBeNull();
    expect(row.organizationId).toBe(fx.otherOrganizationId);
  });
});

describe("listVendors", () => {
  test("returns only the caller's org's vendors — a second org's vendor is the negative control", async () => {
    const mine = await createVendor(fx.owner, { name: "Mine Distributing" });
    // The negative control: without this row in the database, a test that
    // merely returns [mine] would pass whether or not the query is scoped.
    await createVendor(fx.otherOwner, { name: "Theirs Distributing" });

    const list = await listVendors(fx.owner);

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(mine.id);
    expect(list.some((v) => v.name === "Theirs Distributing")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assignVendorToProducts — atomic, all-or-nothing (invariant 9)
// ---------------------------------------------------------------------------

describe("assignVendorToProducts", () => {
  test("sets vendor_id on every product in the list", async () => {
    const v = await createVendor(fx.owner, { name: "RNDC" });

    await assignVendorToProducts(fx.owner, {
      productIds: [fx.pricedProductId, fx.secondProductId],
      vendorId: v.id,
    });

    const rows = await db
      .select({ id: product.id, vendorId: product.vendorId })
      .from(product)
      .where(and(eq(product.organizationId, fx.organizationId)));
    expect(rows.find((r) => r.id === fx.pricedProductId)!.vendorId).toBe(v.id);
    expect(rows.find((r) => r.id === fx.secondProductId)!.vendorId).toBe(v.id);
  });

  test("passing null clears vendor_id", async () => {
    const v = await createVendor(fx.owner, { name: "RNDC" });
    await assignVendorToProducts(fx.owner, { productIds: [fx.pricedProductId], vendorId: v.id });

    await assignVendorToProducts(fx.owner, { productIds: [fx.pricedProductId], vendorId: null });

    const [row] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(row.vendorId).toBeNull();
  });

  test("THE IMPORTANT ONE — a list mixing the actor's own ids with another tenant's is refused entirely, and none of the actor's own products are modified", async () => {
    const v = await createVendor(fx.owner, { name: "RNDC" });

    const attempt = assignVendorToProducts(fx.owner, {
      productIds: [fx.pricedProductId, fx.secondProductId, fx.otherProductId],
      vendorId: v.id,
    });
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

    // A test that only asserts the call threw would pass even if the two
    // owned products had already been updated before the cross-tenant id was
    // discovered — that partial apply is exactly the failure this test
    // exists to catch, so re-read the rows and prove neither moved.
    const [priced] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    const [second] = await db.select().from(product).where(eq(product.id, fx.secondProductId));
    expect(priced.vendorId).toBeNull();
    expect(second.vendorId).toBeNull();

    // And the other tenant's product is equally untouched.
    const [theirs] = await db.select().from(product).where(eq(product.id, fx.otherProductId));
    expect(theirs.vendorId).toBeNull();
  });

  test("a vendor id from another tenant is refused even when every product id is valid", async () => {
    const theirVendor = await createVendor(fx.otherOwner, { name: "Their Distributor" });

    const attempt = assignVendorToProducts(fx.owner, {
      productIds: [fx.pricedProductId, fx.secondProductId],
      vendorId: theirVendor.id,
    });
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

    const [priced] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    const [second] = await db.select().from(product).where(eq(product.id, fx.secondProductId));
    expect(priced.vendorId).toBeNull();
    expect(second.vendorId).toBeNull();
  });

  test("duplicate product ids succeed and assign the vendor once (Finding 2 deduplication fix)", async () => {
    const v = await createVendor(fx.owner, { name: "Test Vendor" });

    // Caller sending a duplicate id — could come from a checkbox list built
    // without a Set, or a retried partial selection.
    await assignVendorToProducts(fx.owner, {
      productIds: [fx.pricedProductId, fx.pricedProductId, fx.secondProductId],
      vendorId: v.id,
    });

    const [priced] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    const [second] = await db.select().from(product).where(eq(product.id, fx.secondProductId));
    expect(priced.vendorId).toBe(v.id);
    expect(second.vendorId).toBe(v.id);
  });

  test("a duplicate id mixed with a genuinely foreign id still refuses the whole call (deduplication + invariant 9)", async () => {
    const v = await createVendor(fx.owner, { name: "Test Vendor" });

    // A duplicate of a valid id, mixed with a foreign id — the deduplication
    // cannot become a way to smuggle a foreign id past the check.
    const attempt = assignVendorToProducts(fx.owner, {
      productIds: [fx.pricedProductId, fx.pricedProductId, fx.otherProductId],
      vendorId: v.id,
    });
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

    const [priced] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    const [second] = await db.select().from(product).where(eq(product.id, fx.secondProductId));
    expect(priced.vendorId).toBeNull();
    expect(second.vendorId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The reorder list actually groups by vendor once products have one — the
// whole reason this gap mattered (spec §9.3). Proven end to end: two vendors,
// two short products, one closed count, one call to reorderList().
// ---------------------------------------------------------------------------

describe("the reorder list groups by vendor", () => {
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
  }

  test("items carry their vendor name, and same-vendor rows sort adjacent", async () => {
    const vendorA = await createVendor(fx.owner, { name: "Alpha Distributing" });
    const vendorB = await createVendor(fx.owner, { name: "Zulu Beverage" });

    await assignVendorToProducts(fx.owner, { productIds: [fx.pricedProductId], vendorId: vendorA.id });
    await assignVendorToProducts(fx.owner, { productIds: [fx.secondProductId], vendorId: vendorB.id });

    await closeCountWith(fx.pricedProductId, 1);
    await closeCountWith(fx.secondProductId, 1);
    // Same count/session would collide on the count_line unique index across
    // two closeCountWith calls if they shared a count, so each closes its own
    // — reorderList reads on-hand across all closed counts regardless.

    const { updateProduct } = await import("@/lib/domain/catalog");
    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: 12 });
    await updateProduct(fx.owner, { productId: fx.secondProductId, parLevel: 12 });

    const list = await reorderList(fx.owner);

    expect(list.items).toHaveLength(2);
    const byName = new Map(list.items.map((i) => [i.productName, i]));
    expect(byName.get("Tito's Handmade Vodka")!.vendorId).toBe(vendorA.id);
    expect(byName.get("Tito's Handmade Vodka")!.vendorName).toBe("Alpha Distributing");
    expect(byName.get("Bulleit Bourbon")!.vendorId).toBe(vendorB.id);
    expect(byName.get("Bulleit Bourbon")!.vendorName).toBe("Zulu Beverage");

    // Grouped/sorted by vendor name — Alpha's row comes before Zulu's.
    expect(list.items[0].vendorName).toBe("Alpha Distributing");
    expect(list.items[1].vendorName).toBe("Zulu Beverage");
  });

  test("a product with no vendor still appears on the list, with a null vendorId/vendorName rather than being dropped", async () => {
    const { updateProduct } = await import("@/lib/domain/catalog");
    await updateProduct(fx.owner, { productId: fx.pricedProductId, parLevel: 12 });
    await closeCountWith(fx.pricedProductId, 1);

    const list = await reorderList(fx.owner);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].vendorId).toBeNull();
    expect(list.items[0].vendorName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Role gating (action layer) — createVendorAction / updateVendorAction /
// assignVendorToProductsAction all require requireRole("owner", "manager").
// staff is the role the gate exists to refuse; manager is the positive
// control proving the mocked session harness isn't just failing everything.
// ---------------------------------------------------------------------------

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
}));

let sessionUserId: number | null = null;

mock.module("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => {
        if (sessionUserId == null) return null;
        return { session: { id: "mock-session" }, user: { id: String(sessionUserId) } };
      },
    },
  },
}));

describe("role gating on the vendor actions", () => {
  test("staff is refused on create, update, and assign — and nothing is written", async () => {
    // Dynamically imported: a static import at module top would resolve
    // (and pull in the REAL @/lib/auth / next/headers) before the
    // mock.module() calls above ever run — see the file header comment.
    const { createVendorAction, updateVendorAction, assignVendorToProductsAction } = await import(
      "@/app/actions/catalog"
    );

    const v = await createVendor(fx.owner, { name: "Owner-Created Vendor" });

    sessionUserId = fx.staff.userId;

    const created = await createVendorAction({ name: "Staff Vendor" });
    expect(created.ok).toBe(false);
    const rows = await db.select().from(vendor).where(eq(vendor.name, "Staff Vendor"));
    expect(rows).toHaveLength(0);

    const updated = await updateVendorAction({ id: v.id, contact: "staff@test.local" });
    expect(updated.ok).toBe(false);
    const [unchanged] = await db.select().from(vendor).where(eq(vendor.id, v.id));
    expect(unchanged.contact).toBeNull();

    const assigned = await assignVendorToProductsAction({
      productIds: [fx.pricedProductId],
      vendorId: v.id,
    });
    expect(assigned.ok).toBe(false);
    const [untouchedProduct] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(untouchedProduct.vendorId).toBeNull();
  });

  test("manager is permitted on create, update, and assign — the positive control", async () => {
    const { createVendorAction, updateVendorAction, assignVendorToProductsAction } = await import(
      "@/app/actions/catalog"
    );

    sessionUserId = fx.manager.userId;

    const created = await createVendorAction({ name: "Manager Vendor" });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const updated = await updateVendorAction({ id: created.data.id, contact: "manager@test.local" });
    expect(updated.ok).toBe(true);

    const assigned = await assignVendorToProductsAction({
      productIds: [fx.pricedProductId],
      vendorId: created.data.id,
    });
    expect(assigned.ok).toBe(true);

    const [row] = await db.select().from(product).where(eq(product.id, fx.pricedProductId));
    expect(row.vendorId).toBe(created.data.id);
  });
});
