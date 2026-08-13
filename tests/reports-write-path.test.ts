/**
 * `getLastClosedCount` — dashboard aggregate read, open-items #14.
 *
 * Replaces the dashboard's old "fetch 50 via listCounts, filter to closed,
 * sort client-side" pattern with a direct `ORDER BY closed_at DESC LIMIT 1`
 * query (lib/domain/reports.ts). This file only covers that new function —
 * `countSummary`/`reorderList` already have their own coverage elsewhere.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { count } from "@/db/schema";
import { getLastClosedCount } from "@/lib/domain/reports";
import { openCount, incrementCountLine, submitCount, reviewCount, closeCount } from "@/lib/domain/counts";
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

async function advanceToReviewed(countId: number, actor: Fixtures["owner"] = fx.owner) {
  await submitCount(actor, countId);
  await reviewCount(actor, countId);
}

/** Sets a closed count's `closed_at` directly, to make ordering deterministic
 * without depending on real wall-clock gaps between calls in the same test. */
async function setClosedAt(countId: number, closedAt: Date) {
  await db.update(count).set({ closedAt }).where(eq(count.id, countId));
}

describe("getLastClosedCount", () => {
  test("returns the most recently CLOSED count, not the most recently started or submitted one", async () => {
    // A opens (and therefore starts) before B.
    const a = await openCount(fx.owner, { type: "full", notes: "count A" });
    const b = await openCount(fx.owner, { type: "full", notes: "count B" });

    await advanceToReviewed(a.id);
    await advanceToReviewed(b.id);

    // Close B first, then A — so A is the LAST one closed despite being the
    // FIRST one started. Pin the timestamps explicitly so the assertion
    // below can't pass by accident of real-clock ordering.
    await closeCount(fx.owner, b.id);
    await closeCount(fx.owner, a.id);
    await setClosedAt(b.id, new Date(Date.now() - 60_000));
    await setClosedAt(a.id, new Date());

    const result = await getLastClosedCount(fx.owner);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(a.id);
  });

  test("returns null when no count has ever been closed", async () => {
    await openCount(fx.owner, { type: "full" });

    const result = await getLastClosedCount(fx.owner);
    expect(result).toBeNull();
  });

  test("a manager caller never receives totalValue; an owner caller does", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 4,
      newPartialFills: [],
    });
    await advanceToReviewed(c.id);
    await closeCount(fx.owner, c.id);

    const ownerResult = await getLastClosedCount(fx.owner);
    expect(ownerResult).not.toBeNull();
    expect(ownerResult!.totalValue).toBeDefined();
    expect(Number(ownerResult!.totalValue)).toBeCloseTo(98, 2); // 4 x 24.50

    const managerResult = await getLastClosedCount(fx.manager);
    expect(managerResult).not.toBeNull();
    expect(managerResult!.totalValue).toBeUndefined();
  });

  test("a second tenant's closed count never appears", async () => {
    const theirs = await openCount(fx.otherOwner, { type: "full" });
    await advanceToReviewed(theirs.id, fx.otherOwner);
    await closeCount(fx.otherOwner, theirs.id);

    // The negative control: without `theirs` existing, a test asserting
    // `null` here would pass whether or not the query is tenant-scoped.
    const mine = await getLastClosedCount(fx.owner);
    expect(mine).toBeNull();

    const theirResult = await getLastClosedCount(fx.otherOwner);
    expect(theirResult).not.toBeNull();
    expect(theirResult!.id).toBe(theirs.id);
  });
});
