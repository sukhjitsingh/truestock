/**
 * Closing a count over sections nobody visited (QA finding A20 / DB-4).
 *
 * A "section" is an active location of the org (the hub's "N of M started");
 * unvisited = zero count_line rows for the count. Closing is permanent
 * (invariant 1), so `closeCount` refuses until every empty section is named in
 * `confirmedEmptyLocationIds`, recomputed inside the close transaction.
 *
 * Mutation check: delete the `throw new EmptySectionsError` in closeCount and
 * every refusal test below goes red (the count closes).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { count } from "@/db/schema";
import { createLocation } from "@/lib/domain/catalog";
import {
  openCount,
  incrementCountLine,
  submitCount,
  reviewCount,
  closeCount,
} from "@/lib/domain/counts";
import { EmptySectionsError } from "@/lib/domain/errors";
import { closeCountSchema } from "@/lib/validation/counts";
import {
  migrateTestDatabase,
  resetDatabase,
  createFixtures,
  newClientLineId,
  type Fixtures,
} from "./helpers/test-db";

let fx: Fixtures;
let storeroomId: number;
let patioId: number;

beforeAll(async () => {
  await migrateTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fx = await createFixtures();
  storeroomId = (await createLocation(fx.owner, { name: "Storeroom", countMode: "quantity" })).id;
  patioId = (await createLocation(fx.owner, { name: "Patio", countMode: "quantity" })).id;
});

afterAll(async () => {
  await closePool();
});

/** A reviewed count with one line, in Back Bar only: Storeroom and Patio stay empty. */
async function reviewedCountInBackBarOnly() {
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
  await submitCount(fx.owner, c.id);
  await reviewCount(fx.owner, c.id);
  return c.id;
}

async function statusOf(countId: number) {
  const [row] = await db.select({ status: count.status }).from(count).where(eq(count.id, countId));
  return row.status;
}

async function refusal(promise: Promise<unknown>): Promise<EmptySectionsError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(EmptySectionsError);
    return err as EmptySectionsError;
  }
  throw new Error("expected closeCount to refuse, but it closed");
}

describe("closeCount over sections with no lines", () => {
  test("refused with no confirmation: count stays reviewed, error lists the empty sections", async () => {
    const countId = await reviewedCountInBackBarOnly();
    const err = await refusal(closeCount(fx.owner, countId));
    expect(err.emptyLocations.map((l) => l.id).sort()).toEqual([storeroomId, patioId].sort());
    expect(err.emptyLocations.map((l) => l.name).sort()).toEqual(["Patio", "Storeroom"]);
    expect(err.sectionCount).toBe(3);
    expect(await statusOf(countId)).toBe("reviewed");
  });

  test("refused when the confirmation omits one empty section", async () => {
    const countId = await reviewedCountInBackBarOnly();
    const err = await refusal(
      closeCount(fx.owner, countId, { confirmedEmptyLocationIds: [storeroomId] }),
    );
    // The refusal carries the full current empty list, not only the unconfirmed one.
    expect(err.emptyLocations.map((l) => l.id).sort()).toEqual([storeroomId, patioId].sort());
    expect(await statusOf(countId)).toBe("reviewed");
  });

  test("a confirmation of the visited section does not stand in for the empty ones", async () => {
    const countId = await reviewedCountInBackBarOnly();
    await refusal(closeCount(fx.owner, countId, { confirmedEmptyLocationIds: [fx.locationId] }));
    expect(await statusOf(countId)).toBe("reviewed");
  });

  test("closes with the full confirmation", async () => {
    const countId = await reviewedCountInBackBarOnly();
    const result = await closeCount(fx.owner, countId, {
      confirmedEmptyLocationIds: [storeroomId, patioId],
    });
    expect(result.count.status).toBe("closed");
    expect(await statusOf(countId)).toBe("closed");
  });

  test("closes with no confirmation when no section is empty (one-tap as before)", async () => {
    const full = await openCount(fx.owner, { type: "full" });
    for (const locationId of [fx.locationId, storeroomId, patioId]) {
      await incrementCountLine(fx.owner, {
        clientLineId: newClientLineId(),
        countId: full.id,
        productId: fx.pricedProductId,
        locationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 1,
        newPartialFills: [],
      });
    }
    await submitCount(fx.owner, full.id);
    await reviewCount(fx.owner, full.id);
    const result = await closeCount(fx.owner, full.id);
    expect(result.count.status).toBe("closed");
  });

  test("a cross-tenant location id in the confirmation does not help", async () => {
    const countId = await reviewedCountInBackBarOnly();
    const err = await refusal(
      closeCount(fx.owner, countId, {
        confirmedEmptyLocationIds: [fx.otherLocationId, storeroomId],
      }),
    );
    expect(err.emptyLocations.map((l) => l.id)).toEqual(expect.arrayContaining([patioId]));
    // The other tenant's location is never named in the refusal either.
    expect(err.emptyLocations.map((l) => l.id)).not.toContain(fx.otherLocationId);
    expect(await statusOf(countId)).toBe("reviewed");
  });

  test("a retired section is not a section: it does not block the close", async () => {
    const countId = await reviewedCountInBackBarOnly();
    const { deactivateLocation } = await import("@/lib/domain/catalog");
    await deactivateLocation(fx.owner, patioId);
    await refusal(closeCount(fx.owner, countId, { confirmedEmptyLocationIds: [] }));
    await closeCount(fx.owner, countId, { confirmedEmptyLocationIds: [storeroomId] });
    expect(await statusOf(countId)).toBe("closed");
  });
});

describe("closeCountSchema", () => {
  test("defaults the confirmation to empty and rejects non-integer ids", () => {
    expect(closeCountSchema.parse({ countId: 1 }).confirmedEmptyLocationIds).toEqual([]);
    expect(() => closeCountSchema.parse({ countId: 1, confirmedEmptyLocationIds: ["a"] })).toThrow();
    expect(() => closeCountSchema.parse({ countId: 1, confirmedEmptyLocationIds: [1.5] })).toThrow();
  });
});
