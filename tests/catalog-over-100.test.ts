/**
 * The back-office catalog past 100 products (QA 2026-11-08, with finding 1).
 *
 * The catalog page and the product edit page both read through
 * `searchProducts({ limit: 100 })` — the count-time picker's capped search.
 * The seed is 97 products, so the fourth one added through the new
 * "Add product" page pushed the alphabetical tail off the catalog (it simply
 * stopped being listed) and made its edit page a 404. Nothing errored; the
 * catalog just quietly shrank — the dashboard's version of this was open item
 * #14, fixed the same way: a dedicated read instead of a capped one.
 *
 * The capped search itself is unchanged: the phone's picker is latency-critical
 * and is meant to be capped.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { db, closePool } from "@/db";
import { product } from "@/db/schema";
import { listCatalogProducts, getProductWithStock, searchProducts, updateProduct, deactivateProduct } from "@/lib/domain/catalog";
import { NotFoundError } from "@/lib/domain/errors";
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

/** Brings the org to 101 active products; "Zzz Last Product" sorts after every other. */
async function grow(): Promise<number> {
  await db.insert(product).values(
    Array.from({ length: 97 }, (_, i) => ({
      organizationId: fx.organizationId,
      name: `Bulk Product ${String(i).padStart(3, "0")}`,
      category: "Spirits",
      unitType: "bottle" as const,
      sizeMl: 750,
    })),
  );
  const [last] = await db
    .insert(product)
    .values({ organizationId: fx.organizationId, name: "Zzz Last Product", category: "Spirits", unitType: "bottle", sizeMl: 750 })
    .$returningId();
  return last.id;
}

describe("listCatalogProducts — the whole active catalog, uncapped", () => {
  test("returns all 101 active products, where the capped search returns 100 and drops the last", async () => {
    const lastId = await grow();

    const capped = await searchProducts(fx.owner, { activeOnly: true, limit: 100, includeOnHand: true });
    expect(capped).toHaveLength(100);
    expect(capped.some((p) => p.id === lastId)).toBe(false);

    const all = await listCatalogProducts(fx.owner, { activeOnly: true, includeOnHand: true });
    expect(all).toHaveLength(101);
    expect(all.some((p) => p.id === lastId)).toBe(true);
  });

  test("still filters by the search box, and still excludes inactive products", async () => {
    await grow();
    await deactivateProduct(fx.owner, fx.secondProductId);

    const found = await listCatalogProducts(fx.owner, { query: "Zzz", activeOnly: true, includeOnHand: true });
    expect(found.map((p) => p.name)).toEqual(["Zzz Last Product"]);

    const all = await listCatalogProducts(fx.owner, { activeOnly: true, includeOnHand: true });
    expect(all.some((p) => p.id === fx.secondProductId)).toBe(false);
  });

  test("is scoped to the caller's organization (invariant 9)", async () => {
    const all = await listCatalogProducts(fx.owner, { activeOnly: false, includeOnHand: false });
    const theirs = await listCatalogProducts(fx.otherOwner, { activeOnly: false, includeOnHand: false });
    const mine = new Set(all.map((p) => p.id));
    expect(theirs.some((p) => mine.has(p.id))).toBe(false);
  });
});

describe("getProductWithStock — the edit page's read", () => {
  test("finds the 101st product, with its par attached", async () => {
    const lastId = await grow();
    await updateProduct(fx.owner, { productId: lastId, parLevel: 4 });

    const p = await getProductWithStock(fx.owner, lastId);
    expect(p.name).toBe("Zzz Last Product");
    expect(p.stock?.parLevel).toBe(4);
  });

  test("finds an inactive product too — the edit page opens deactivated rows", async () => {
    await deactivateProduct(fx.owner, fx.secondProductId);
    const p = await getProductWithStock(fx.owner, fx.secondProductId);
    expect(p.active).toBe(false);
  });

  test("another tenant's product is NotFound, never confirmed real", async () => {
    const theirs = await listCatalogProducts(fx.otherOwner, { activeOnly: false, includeOnHand: false });
    await expect(getProductWithStock(fx.owner, theirs[0].id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
