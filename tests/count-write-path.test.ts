/**
 * The count write path, against a real MariaDB.
 *
 * This file exists to close the items docs/open-items.md #1 listed as
 * "reasoned, not exercised" — every one of them is a claim about what the
 * DATABASE does under concurrency, replay, or constraint violation, which is
 * exactly the class of claim a unit test with a mocked db cannot make.
 *
 * The one that matters most is the replay rollback. The `count_line_write`
 * ledger's whole design rests on an assumption: that when the ledger insert
 * violates its unique index, InnoDB rolls back the count_line increment written
 * earlier in the same transaction, leaving nothing behind. If that assumption is
 * wrong, a retried write silently double-counts — the exact bug this table
 * replaced, back again and invisible.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { countLine, countLineWrite, product as productTable } from "@/db/schema";
import {
  openCount,
  incrementCountLine,
  setCountLineQuantities,
  submitCount,
  reviewCount,
  closeCount,
  getCount,
  getCountTotals,
} from "@/lib/domain/counts";
import { ClosedCountError, NotFoundError } from "@/lib/domain/errors";
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
  // Without this the mysql2 pool keeps the event loop alive and `bun test`
  // hangs after the last assertion instead of exiting.
  await closePool();
});

/** Drives a count to `reviewed`, the only status closeCount accepts. */
async function advanceToReviewed(countId: number) {
  await submitCount(fx.owner, countId);
  await reviewCount(fx.owner, countId);
}

// ---------------------------------------------------------------------------

describe("replay rollback — the crux of the double-count fix", () => {
  test("the same clientLineId applied twice increments exactly once", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    const clientLineId = newClientLineId();

    const first = await incrementCountLine(fx.owner, {
      clientLineId,
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 3,
      newPartialFills: [],
    });

    // The retry. Same id, same payload — a client resending after a dropped
    // ack, which is precisely what the offline queue does.
    const replay = await incrementCountLine(fx.owner, {
      clientLineId,
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 3,
      newPartialFills: [],
    });

    // A replay must look like success to the caller, not an error.
    expect(replay.id).toBe(first.id);
    // ...and must not have added anything.
    expect(replay.sealedEachQty).toBe(3);

    const [row] = await db.select().from(countLine).where(eq(countLine.id, first.id));
    expect(row.sealedEachQty).toBe(3);

    // The ledger is the actual proof: one applied write, one row.
    const ledger = await db
      .select()
      .from(countLineWrite)
      .where(eq(countLineWrite.countLineId, first.id));
    expect(ledger).toHaveLength(1);
  });

  test("the rolled-back attempt leaves no partial state behind", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    const clientLineId = newClientLineId();

    await incrementCountLine(fx.owner, {
      clientLineId,
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 1,
      sealedEachQtyDelta: 0,
      newPartialFills: [0.5],
    });

    // Replay with a DIFFERENT payload under the same id. The id is what
    // decides, not the body — otherwise a corrupted retry could sneak a
    // different write past the guard.
    await incrementCountLine(fx.owner, {
      clientLineId,
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 99,
      sealedEachQtyDelta: 99,
      newPartialFills: [0.1, 0.2],
    });

    const rows = await db.select().from(countLine).where(eq(countLine.countId, c.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].sealedCaseQty).toBe(1);
    expect(rows[0].sealedEachQty).toBe(0);
    expect(rows[0].partialFills).toEqual([0.5]);
  });

  test("a genuine second scan uses a fresh id and DOES increment", async () => {
    const c = await openCount(fx.owner, { type: "full" });

    for (let i = 0; i < 3; i++) {
      await incrementCountLine(fx.owner, {
        clientLineId: newClientLineId(), // fresh per write attempt — the rule
        countId: c.id,
        productId: fx.pricedProductId,
        locationId: fx.locationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 1,
        newPartialFills: [],
      });
    }

    const rows = await db.select().from(countLine).where(eq(countLine.countId, c.id));
    // Invariant 3: three scans of one product in one location is ONE row.
    expect(rows).toHaveLength(1);
    expect(rows[0].sealedEachQty).toBe(3);

    const ledger = await db
      .select()
      .from(countLineWrite)
      .where(eq(countLineWrite.countId, c.id));
    expect(ledger).toHaveLength(3);
  });
});

describe("count_line_write ledger", () => {
  test("records the delta of each write, not the resulting total", async () => {
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
    await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 5,
      newPartialFills: [],
    });

    const ledger = await db
      .select()
      .from(countLineWrite)
      .where(eq(countLineWrite.countId, c.id))
      .orderBy(countLineWrite.id);

    // 2 then 5 — deltas. If these read 2 then 7, the ledger is recording
    // state rather than change and the audit trail cannot be replayed.
    expect(ledger.map((r) => r.sealedEachDelta)).toEqual([2, 5]);
    // ...and the deltas sum to the line's current value.
    const [line] = await db.select().from(countLine).where(eq(countLine.countId, c.id));
    expect(ledger.reduce((sum, r) => sum + r.sealedEachDelta, 0)).toBe(line.sealedEachQty);
  });

  test("the foreign key to count_line is enforced", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    // Wrapped in an async fn rather than passed directly: drizzle's query
    // builder is a thenable, not a Promise, and `expect(builder).rejects`
    // inspects it without ever executing the query — the assertion would pass
    // whether or not the constraint exists.
    await expect(
      (async () =>
        db.insert(countLineWrite).values({
          organizationId: fx.organizationId,
          countLineId: 999_999, // no such line
          countId: c.id,
          writtenBy: fx.owner.userId,
          sealedCaseDelta: 0,
          sealedEachDelta: 1,
          partialFillsDelta: [],
          clientLineId: newClientLineId(),
        }))(),
    ).rejects.toThrow();
  });
});

describe("partial_fills round-trips through drizzle", () => {
  test("reads back as real numbers, not a JSON string", async () => {
    const c = await openCount(fx.owner, { type: "full" });

    const line = await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 0,
      newPartialFills: [0.3, 0.8],
    });

    // MariaDB stores JSON as a longtext alias, so this is really a test of
    // mysql2's parsing — drizzle supplies no mapFromDriverValue here. If a
    // driver upgrade ever changes that, this is the test that catches it.
    expect(Array.isArray(line.partialFills)).toBe(true);
    expect(line.partialFills).toEqual([0.3, 0.8]);
    expect(typeof line.partialFills[0]).toBe("number");

    const [raw] = await db.select().from(countLine).where(eq(countLine.id, line.id));
    expect(raw.partialFills).toEqual([0.3, 0.8]);
  });

  test("a second write appends rather than replacing", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    const base = {
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 0,
    };

    await incrementCountLine(fx.owner, {
      ...base,
      clientLineId: newClientLineId(),
      newPartialFills: [0.3],
    });
    const second = await incrementCountLine(fx.owner, {
      ...base,
      clientLineId: newClientLineId(),
      newPartialFills: [0.8],
    });

    // Invariant 4's spirit: observations accumulate, they are not overwritten.
    expect(second.partialFills).toEqual([0.3, 0.8]);
  });
});

describe("DECIMAL(10,4) and the cost snapshot (invariant 2)", () => {
  test("unit_cost_at_count is snapshotted exactly, as a string", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    const line = await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 2,
      newPartialFills: [],
    });

    // Exact string equality, not toBeCloseTo. Money read through a float is
    // the failure mode this column's string mode exists to prevent, and a
    // tolerance-based assertion would pass even if that protection broke.
    expect(line.unitCostAtCount).toBe("24.5000");
  });

  test("changing the product's cost later does not re-value an existing line", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    const line = await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 2,
      newPartialFills: [],
    });

    await db
      .update(productTable)
      .set({ currentUnitCost: "99.9900" })
      .where(eq(productTable.id, fx.pricedProductId));

    const detail = await getCount(fx.owner, c.id);
    const found = detail.lines.find((l) => l.id === line.id)!;
    // Invariant 2: history is valued from the snapshot, never from current
    // product data.
    expect(found.unitCostAtCount).toBe("24.5000");
  });

  test("an unpriced line is excluded from the total, never valued at zero", async () => {
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
    await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.unpricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 7,
      newPartialFills: [],
    });

    const totals = await getCountTotals(fx.owner, c.id);
    expect(totals.lineCount).toBe(2);
    expect(totals.pricedLineCount).toBe(1);
    expect(totals.excludedLineCount).toBe(1);
    // 2 x 24.50. If the unpriced line were coerced to 0 it would still be 49 —
    // so the excludedLineCount assertion above is what makes this meaningful.
    expect(totals.totalValue).toBeCloseTo(49, 2);
  });
});

describe("cost visibility (invariant 8)", () => {
  test("a manager never receives cost fields, even though the row has them", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    const asManager = await incrementCountLine(fx.manager, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 1,
      newPartialFills: [],
    });

    expect(asManager.unitCostAtCount).toBeUndefined();
    expect(asManager.extendedValue).toBeUndefined();

    // The snapshot still happened in the database — it is the RESPONSE that is
    // gated, not the write.
    const [row] = await db.select().from(countLine).where(eq(countLine.id, asManager.id));
    expect(row.unitCostAtCount).toBe("24.5000");

    const totals = await getCountTotals(fx.manager, c.id);
    expect(totals.totalValue).toBeUndefined();
  });
});

describe("closed counts are immutable (invariant 1)", () => {
  test("a write to a closed count is refused", async () => {
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
    await advanceToReviewed(c.id);
    await closeCount(fx.owner, c.id);

    await expect(
      incrementCountLine(fx.owner, {
        clientLineId: newClientLineId(),
        countId: c.id,
        productId: fx.secondProductId,
        locationId: fx.locationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 1,
        newPartialFills: [],
      }),
    ).rejects.toThrow(ClosedCountError);
  });

  test("closing writes the total and the close is idempotent-safe to re-attempt", async () => {
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

    const closed = await closeCount(fx.owner, c.id);
    expect(closed.count.status).toBe("closed");
    expect(closed.totals.totalValue).toBeCloseTo(98, 2); // 4 x 24.50

    // A second close must not silently re-close or re-value.
    await expect(closeCount(fx.owner, c.id)).rejects.toThrow();
  });
});

describe("tenancy (invariant 9) on the write path", () => {
  test("another tenant's count cannot be written to", async () => {
    const c = await openCount(fx.owner, { type: "full" });

    await expect(
      incrementCountLine(fx.otherOwner, {
        clientLineId: newClientLineId(),
        countId: c.id,
        productId: fx.pricedProductId,
        locationId: fx.locationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 1,
        newPartialFills: [],
      }),
    ).rejects.toThrow(NotFoundError);
  });

  test("a cross-tenant locationId is refused, not silently accepted", async () => {
    const c = await openCount(fx.owner, { type: "full" });

    // fx.otherLocationId is a real row — existence is not ownership. This is
    // the gap the schema audit found live in production code.
    await expect(
      incrementCountLine(fx.owner, {
        clientLineId: newClientLineId(),
        countId: c.id,
        productId: fx.pricedProductId,
        locationId: fx.otherLocationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 1,
        newPartialFills: [],
      }),
    ).rejects.toThrow();

    const rows = await db.select().from(countLine).where(eq(countLine.countId, c.id));
    expect(rows).toHaveLength(0);
  });

  test("another tenant cannot read the count", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    await expect(getCount(fx.otherOwner, c.id)).rejects.toThrow(NotFoundError);
  });
});

describe("absolute SET corrections", () => {
  test("a SET replaces the quantity and the ledger records the signed delta", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    const line = await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 12,
      newPartialFills: [],
    });

    // The "meant ADD, typed SET" case from CLAUDE.md: 12 -> 3 is -9.
    const corrected = await setCountLineQuantities(fx.owner, {
      clientLineId: newClientLineId(),
      countLineId: line.id,
      sealedCaseQty: 0,
      sealedEachQty: 3,
    });
    expect(corrected.sealedEachQty).toBe(3);

    const ledger = await db
      .select()
      .from(countLineWrite)
      .where(and(eq(countLineWrite.countLineId, line.id)))
      .orderBy(countLineWrite.id);
    expect(ledger).toHaveLength(2);
    // The correction is recorded as what actually changed, so summing the
    // ledger still reconstructs the line.
    expect(ledger[1].sealedEachDelta).toBe(-9);
    expect(ledger.reduce((sum, r) => sum + r.sealedEachDelta, 0)).toBe(3);
  });
});
