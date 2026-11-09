/**
 * Back-office "Add product" (QA 2026-11-08, finding 1) — the write it relies on.
 *
 * The page sends `createProductAction` either no barcode (a house infusion,
 * a damaged label, wine) or a barcode TYPED by a person, which arrives with
 * no symbology. Both must land correctly: no barcode means no product_barcode
 * row at all, and a typed UPC-A must be stored in the same 14-digit form a
 * scan of that bottle would look up, or the first scan after this would miss
 * it and offer to enroll a duplicate (AGENTS.md: barcodes only through
 * normalizeBarcode).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { product, productBarcode } from "@/db/schema";
import { createProduct, resolveBarcode } from "@/lib/domain/catalog";
import { productCreateSchema } from "@/lib/validation/catalog";
import { ConflictError } from "@/lib/domain/errors";
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

/** What the form sends, parsed exactly as the action parses it. */
const input = (extra: Record<string, unknown> = {}) =>
  productCreateSchema.parse({ name: "House Pineapple Rum", category: "Spirits", unitType: "bottle", sizeMl: 750, ...extra });

describe("adding a product from the back office", () => {
  test("with no barcode: the product is created and has no barcode row", async () => {
    const p = await createProduct(fx.manager, input());

    const [row] = await db.select().from(product).where(eq(product.id, p.id));
    expect(row).toMatchObject({ name: "House Pineapple Rum", sizeMl: 750, active: true, organizationId: fx.organizationId });
    expect(await db.select().from(productBarcode).where(eq(productBarcode.productId, p.id))).toHaveLength(0);
  });

  test("with a typed UPC-A (no format): stored as the 14-digit standard form, and a later EAN-13 scan finds it", async () => {
    const p = await createProduct(fx.manager, input({ barcode: { barcode: "082000000013", packLevel: "each", isPrimary: true } }));

    const [b] = await db.select().from(productBarcode).where(eq(productBarcode.productId, p.id));
    expect(b.barcode).toBe("00082000000013");
    expect(b.format).toBeNull();

    const scanned = await resolveBarcode(fx.staff, "0082000000013", "ean_13");
    expect(scanned?.product.id).toBe(p.id);
  });

  test("a barcode already on another product is refused, naming that product, and nothing is created", async () => {
    await createProduct(fx.manager, input({ barcode: { barcode: "082000000013", packLevel: "each" } }));
    const before = (await db.select().from(product)).length;

    const attempt = createProduct(fx.manager, input({ name: "Something Else", barcode: { barcode: "082000000013", packLevel: "each" } }));
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(
      createProduct(fx.manager, input({ name: "Something Else", barcode: { barcode: "082000000013", packLevel: "each" } })),
    ).rejects.toThrow(/House Pineapple Rum/);
    expect((await db.select().from(product)).length).toBe(before);
  });

  test("a manager's cost is dropped, an owner's is kept (invariant 8)", async () => {
    const m = await createProduct(fx.manager, input({ name: "Manager Made", currentUnitCost: "12.00" }));
    const o = await createProduct(fx.owner, input({ name: "Owner Made", currentUnitCost: "12.00" }));
    const [mr] = await db.select().from(product).where(eq(product.id, m.id));
    const [or] = await db.select().from(product).where(eq(product.id, o.id));
    expect(mr.currentUnitCost).toBeNull();
    expect(Number(or.currentUnitCost)).toBe(12);
  });
});
