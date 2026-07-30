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
 * So the assertions here are mostly about what is in the database afterwards,
 * not about what the function returned. A function that returns a plausible
 * object while writing nothing is exactly the failure being tested for.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { db, closePool } from "@/db";
import { productPar } from "@/db/schema";
import { updateProduct, searchProducts } from "@/lib/domain/catalog";
import { openCount, incrementCountLine, submitCount, reviewCount, closeCount } from "@/lib/domain/counts";
import { reorderList } from "@/lib/domain/reports";
import { NotFoundError } from "@/lib/domain/errors";
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
