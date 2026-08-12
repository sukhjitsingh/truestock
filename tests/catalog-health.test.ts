/**
 * `getCatalogHealth` — dashboard aggregate read, open-items #14.
 *
 * The dashboard's old "Catalog health" tile counted `products.length` off
 * `searchProductsAction({ activeOnly: true, limit: 100 })` — a capped read.
 * With 101 active products in the catalog it silently read 100, the exact
 * bug Gate 1's success metric #2 named. This is the test that must FAIL
 * against that capped pattern; see the 101-row test below and
 * `commandsRun` in the task report for the before/after proof.
 *
 * Amendment 1 (2026-08-12): no `incompleteCount` here, and no test for one
 * — the field was deleted, not reconciled against `incompleteReasons`.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { db, closePool } from "@/db";
import { product } from "@/db/schema";
import { getCatalogHealth, searchProducts } from "@/lib/domain/catalog";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";

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

describe("getCatalogHealth", () => {
  test("activeCount is correct with 101 active products", async () => {
    // createFixtures already wrote 3 active products for fx.organizationId
    // (priced, second, unpriced). Bulk-insert the rest to bring the org's
    // catalog to exactly 101 active rows.
    const remaining = 101 - 3;
    await db.insert(product).values(
      Array.from({ length: remaining }, (_, i) => ({
        organizationId: fx.organizationId,
        name: `Bulk Product ${i}`,
        category: "Spirits",
        unitType: "bottle" as const,
        sizeMl: 750,
      })),
    );

    // Proof this is a real bug, not a hypothetical: the capped read this
    // replaces truncates at 100, one short of the real total.
    const cappedRead = await searchProducts(fx.owner, {
      activeOnly: true,
      limit: 100,
      includeOnHand: false,
    });
    expect(cappedRead.length).toBe(100);

    const health = await getCatalogHealth(fx.owner);
    expect(health.activeCount).toBe(101);
  });

  test("unpricedCount is null for a manager caller", async () => {
    const managerHealth = await getCatalogHealth(fx.manager);
    expect(managerHealth.unpricedCount).toBeNull();

    const ownerHealth = await getCatalogHealth(fx.owner);
    // fx.unpricedProductId is the one fixture product with no cost set.
    expect(ownerHealth.unpricedCount).toBe(1);
  });

  test("a second tenant's products never affect the counts", async () => {
    const before = await getCatalogHealth(fx.owner);
    expect(before.activeCount).toBe(3);

    // The negative control: without these rows a test that merely returns
    // fx.owner's own count would pass whether or not the query is scoped.
    await db.insert(product).values(
      Array.from({ length: 10 }, (_, i) => ({
        organizationId: fx.otherOrganizationId,
        name: `Their Bulk Product ${i}`,
        category: "Spirits",
        unitType: "bottle" as const,
        sizeMl: 750,
      })),
    );

    const after = await getCatalogHealth(fx.owner);
    expect(after.activeCount).toBe(3);

    const theirHealth = await getCatalogHealth(fx.otherOwner);
    // fx.otherProductId (1) plus the 10 just inserted.
    expect(theirHealth.activeCount).toBe(11);
  });
});
