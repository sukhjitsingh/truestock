/**
 * Closed counts are immutable, and not-yet-closed counts refuse writes they
 * should not take — exercised through EVERY count-line write path.
 *
 * Guards AGENTS.md invariant 1 (closed counts are immutable; corrections are
 * new adjustment records), invariant 2 (a closed count is valued from its own
 * snapshots, never from current product data) and invariant 9 (a client-supplied
 * countId / countLineId is ownership-checked; cross-tenant is NotFound).
 *
 * What was covered before: `incrementCountLine` onto a closed count. What was
 * not: the other three write paths (`scanCountLine`, `setCountLineQuantities`,
 * `editCountLineFills`), the case of writing to an EXISTING line (the branch
 * that updates a row rather than inserts one), or that submitted/reviewed
 * counts refuse anything but increments. Each path funnels through
 * `assertCountWritable` today, but nothing stops a fifth path (or a refactor of
 * one of these) from skipping it — and a closed count that quietly accepts one
 * more bottle changes a number that has already been signed off.
 *
 * Mutations that must turn this file red:
 *   - lib/domain/counts.ts assertCountWritable: delete the
 *     `if (row.status === "closed") throw new ClosedCountError()` block.
 *   - lib/domain/counts.ts setCountLineQuantities or editCountLineFills: remove
 *     the `await assertCountWritable(tx, ...)` call.
 *   - lib/domain/counts.ts assertCountWritable: delete the `isCountWritable`
 *     check (submitted/reviewed counts then take writes).
 *   - lib/domain/counts.ts setCountLineQuantities: drop
 *     `eq(countLine.organizationId, actor.organizationId)` from the first lookup.
 *   - lib/domain/counts.ts toCountLineRow/getCount: read case size or cost from
 *     the live `product` row instead of the line's snapshot columns.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { count, countLine, countLineWrite, productBarcode } from "@/db/schema";
import {
  openCount,
  incrementCountLine,
  scanCountLine,
  setCountLineQuantities,
  editCountLineFills,
  submitCount,
  reviewCount,
  reopenCount,
  closeCount,
  getCount,
  getCountTotals,
} from "@/lib/domain/counts";
import { updateProduct } from "@/lib/domain/catalog";
import {
  ClosedCountError,
  CountNotWritableError,
  InvalidCountTransitionError,
  NotFoundError,
} from "@/lib/domain/errors";
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

const BARCODE = "012345678905";

/** Opens a count and lays down one line: 2 eaches and one 0.5 open bottle. */
async function openCountWithLine() {
  const c = await openCount(fx.owner, { type: "full" });
  const written = await incrementCountLine(fx.owner, {
    clientLineId: newClientLineId(),
    countId: c.id,
    productId: fx.pricedProductId,
    locationId: fx.locationId,
    sealedCaseQtyDelta: 0,
    sealedEachQtyDelta: 2,
    newPartialFills: [0.5],
  });
  return { countId: c.id, lineId: written.id };
}

async function advanceTo(countId: number, status: "submitted" | "reviewed" | "closed") {
  await submitCount(fx.owner, countId);
  if (status === "submitted") return;
  await reviewCount(fx.owner, countId);
  if (status === "reviewed") return;
  await closeCount(fx.owner, countId);
}

async function enrollBarcode() {
  await db.insert(productBarcode).values({
    organizationId: fx.organizationId,
    productId: fx.pricedProductId,
    barcode: BARCODE,
    packLevel: "each",
    isPrimary: true,
  });
}

/** Every count_line row and ledger row for a count — what "nothing changed" is compared against. */
async function stateOf(countId: number) {
  const lines = await db.select().from(countLine).where(eq(countLine.countId, countId));
  const ledger = await db.select().from(countLineWrite).where(eq(countLineWrite.countId, countId));
  return { lines, ledger };
}

// ---------------------------------------------------------------------------
// Closed counts (invariant 1)
// ---------------------------------------------------------------------------

describe("a closed count refuses every count-line write path", () => {
  test("positive control: the same four writes DO apply while the count is open", async () => {
    // If this fails the refusals below prove nothing — they could be failing
    // for a reason unrelated to the count's status.
    await enrollBarcode();
    const { countId, lineId } = await openCountWithLine();

    const incremented = await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 1,
      newPartialFills: [],
    });
    expect(incremented.id).toBe(lineId);
    expect(incremented.sealedEachQty).toBe(3);

    const scanned = await scanCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId,
      barcode: BARCODE,
      locationId: fx.locationId,
      qty: 1,
    });
    expect(scanned.sealedEachQty).toBe(4);

    const set = await setCountLineQuantities(fx.owner, {
      clientLineId: newClientLineId(),
      countLineId: lineId,
      sealedCaseQty: 0,
      sealedEachQty: 9,
    });
    expect(set.sealedEachQty).toBe(9);

    const edited = await editCountLineFills(fx.owner, {
      clientLineId: newClientLineId(),
      countLineId: lineId,
      partialFills: [0.1],
    });
    expect(edited.partialFills).toEqual([0.1]);

    // Four applied writes plus the setup write: five ledger rows.
    expect((await stateOf(countId)).ledger).toHaveLength(5);
  });

  test("incrementCountLine onto an EXISTING line is refused, and the line and ledger are untouched", async () => {
    const { countId } = await openCountWithLine();
    await advanceTo(countId, "closed");
    const before = await stateOf(countId);

    await expect(
      incrementCountLine(fx.owner, {
        clientLineId: newClientLineId(),
        countId,
        productId: fx.pricedProductId,
        locationId: fx.locationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 5,
        newPartialFills: [0.9],
      }),
    ).rejects.toThrow(ClosedCountError);

    expect(await stateOf(countId)).toEqual(before);
    expect(before.lines[0].sealedEachQty).toBe(2);
  });

  test("incrementCountLine for a NEW product is refused: no new row is created", async () => {
    const { countId } = await openCountWithLine();
    await advanceTo(countId, "closed");
    const before = await stateOf(countId);

    await expect(
      incrementCountLine(fx.owner, {
        clientLineId: newClientLineId(),
        countId,
        productId: fx.secondProductId,
        locationId: fx.locationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 1,
        newPartialFills: [],
      }),
    ).rejects.toThrow(ClosedCountError);

    const after = await stateOf(countId);
    expect(after.lines).toHaveLength(1);
    expect(after).toEqual(before);
  });

  test("scanCountLine by barcode is refused", async () => {
    await enrollBarcode();
    const { countId } = await openCountWithLine();
    await advanceTo(countId, "closed");
    const before = await stateOf(countId);

    await expect(
      scanCountLine(fx.owner, {
        clientLineId: newClientLineId(),
        countId,
        barcode: BARCODE,
        locationId: fx.locationId,
        qty: 1,
      }),
    ).rejects.toThrow(ClosedCountError);

    expect(await stateOf(countId)).toEqual(before);
  });

  test("setCountLineQuantities is refused", async () => {
    const { countId, lineId } = await openCountWithLine();
    await advanceTo(countId, "closed");
    const before = await stateOf(countId);

    await expect(
      setCountLineQuantities(fx.owner, {
        clientLineId: newClientLineId(),
        countLineId: lineId,
        sealedCaseQty: 7,
        sealedEachQty: 7,
      }),
    ).rejects.toThrow(ClosedCountError);

    expect(await stateOf(countId)).toEqual(before);
  });

  test("editCountLineFills is refused", async () => {
    const { countId, lineId } = await openCountWithLine();
    await advanceTo(countId, "closed");
    const before = await stateOf(countId);

    await expect(
      editCountLineFills(fx.owner, {
        clientLineId: newClientLineId(),
        countLineId: lineId,
        partialFills: [0.1, 0.2, 0.3],
      }),
    ).rejects.toThrow(ClosedCountError);

    expect(await stateOf(countId)).toEqual(before);
    expect(before.lines[0].partialFills).toEqual([0.5]);
  });

  test("a closed count cannot be reopened or re-closed, and its stored total is not rewritten", async () => {
    const { countId } = await openCountWithLine();
    await advanceTo(countId, "closed");
    const [closed] = await db.select().from(count).where(eq(count.id, countId));

    await expect(reopenCount(fx.owner, countId)).rejects.toThrow(InvalidCountTransitionError);
    await expect(closeCount(fx.owner, countId)).rejects.toThrow(InvalidCountTransitionError);

    const [after] = await db.select().from(count).where(eq(count.id, countId));
    expect(after.status).toBe("closed");
    expect(after.totalValue).toBe(closed.totalValue);
    expect(after.closedAt).toEqual(closed.closedAt);
  });

  test("replaying a write that landed BEFORE the close is an ordinary success and changes nothing", async () => {
    // Characterisation, not a mandate: the replay pre-check in applyIncrement
    // answers from the ledger before the count's status is consulted, so an
    // offline-queue resend of a write that did land reads as success rather
    // than as a spurious "count is closed" error. What matters for invariant 1
    // is that the replay writes nothing.
    const c = await openCount(fx.owner, { type: "full" });
    const clientLineId = newClientLineId();
    const input = {
      clientLineId,
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 3,
      newPartialFills: [],
    };
    const first = await incrementCountLine(fx.owner, input);
    await advanceTo(c.id, "closed");
    const before = await stateOf(c.id);

    const replay = await incrementCountLine(fx.owner, input);

    expect(replay.id).toBe(first.id);
    expect(replay.sealedEachQty).toBe(3);
    expect(await stateOf(c.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Submitted and reviewed counts: no longer being counted
// ---------------------------------------------------------------------------

describe.each(["submitted", "reviewed"] as const)("a %s count refuses count-line writes", (status) => {
  test("increment, scan, set and edit all throw CountNotWritableError and change nothing", async () => {
    await enrollBarcode();
    const { countId, lineId } = await openCountWithLine();
    await advanceTo(countId, status);
    const before = await stateOf(countId);

    await expect(
      incrementCountLine(fx.owner, {
        clientLineId: newClientLineId(),
        countId,
        productId: fx.pricedProductId,
        locationId: fx.locationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 1,
        newPartialFills: [],
      }),
    ).rejects.toThrow(CountNotWritableError);

    await expect(
      scanCountLine(fx.owner, {
        clientLineId: newClientLineId(),
        countId,
        barcode: BARCODE,
        locationId: fx.locationId,
        qty: 1,
      }),
    ).rejects.toThrow(CountNotWritableError);

    await expect(
      setCountLineQuantities(fx.owner, {
        clientLineId: newClientLineId(),
        countLineId: lineId,
        sealedCaseQty: 4,
        sealedEachQty: 4,
      }),
    ).rejects.toThrow(CountNotWritableError);

    await expect(
      editCountLineFills(fx.owner, {
        clientLineId: newClientLineId(),
        countLineId: lineId,
        partialFills: [0.2],
      }),
    ).rejects.toThrow(CountNotWritableError);

    expect(await stateOf(countId)).toEqual(before);
  });

  test("the refusal is about status, not the line: reopening the count makes the same write succeed", async () => {
    const { countId, lineId } = await openCountWithLine();
    await advanceTo(countId, status);
    await reopenCount(fx.owner, countId);

    const set = await setCountLineQuantities(fx.owner, {
      clientLineId: newClientLineId(),
      countLineId: lineId,
      sealedCaseQty: 0,
      sealedEachQty: 8,
    });

    expect(set.sealedEachQty).toBe(8);
  });

  test("it is NOT closed: the error is the narrower CountNotWritableError, not ClosedCountError", async () => {
    // Different situations with different remedies ("reopen it" vs "it is
    // final") — a single error type would describe neither.
    const { countId, lineId } = await openCountWithLine();
    await advanceTo(countId, status);

    const err = await setCountLineQuantities(fx.owner, {
      clientLineId: newClientLineId(),
      countLineId: lineId,
      sealedCaseQty: 1,
      sealedEachQty: 1,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CountNotWritableError);
    expect(err).not.toBeInstanceOf(ClosedCountError);
  });
});

// ---------------------------------------------------------------------------
// Tenant ownership of client-supplied ids (invariant 9)
// ---------------------------------------------------------------------------

describe("a foreign tenant's count and count-line ids are NotFound, not an answer", () => {
  test("positive control: the owning tenant can set and edit its own line", async () => {
    const { lineId } = await openCountWithLine();

    const set = await setCountLineQuantities(fx.owner, {
      clientLineId: newClientLineId(),
      countLineId: lineId,
      sealedCaseQty: 0,
      sealedEachQty: 6,
    });
    const edited = await editCountLineFills(fx.owner, {
      clientLineId: newClientLineId(),
      countLineId: lineId,
      partialFills: [0.7],
    });

    expect(set.sealedEachQty).toBe(6);
    expect(edited.partialFills).toEqual([0.7]);
  });

  test("setCountLineQuantities with another tenant's countLineId is NotFound and the line is untouched", async () => {
    const { countId, lineId } = await openCountWithLine();
    const before = await stateOf(countId);

    await expect(
      setCountLineQuantities(fx.otherOwner, {
        clientLineId: newClientLineId(),
        countLineId: lineId,
        sealedCaseQty: 99,
        sealedEachQty: 99,
      }),
    ).rejects.toThrow(NotFoundError);

    expect(await stateOf(countId)).toEqual(before);
  });

  test("editCountLineFills with another tenant's countLineId is NotFound and the line is untouched", async () => {
    const { countId, lineId } = await openCountWithLine();
    const before = await stateOf(countId);

    await expect(
      editCountLineFills(fx.otherOwner, {
        clientLineId: newClientLineId(),
        countLineId: lineId,
        partialFills: [0.99],
      }),
    ).rejects.toThrow(NotFoundError);

    expect(await stateOf(countId)).toEqual(before);
  });

  test("incrementCountLine, getCount, getCountTotals and closeCount on another tenant's countId are NotFound", async () => {
    const { countId } = await openCountWithLine();
    await submitCount(fx.owner, countId);
    await reviewCount(fx.owner, countId);

    await expect(
      incrementCountLine(fx.otherOwner, {
        clientLineId: newClientLineId(),
        countId,
        productId: fx.otherProductId,
        locationId: fx.otherLocationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 1,
        newPartialFills: [],
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(getCount(fx.otherOwner, countId)).rejects.toThrow(NotFoundError);
    await expect(getCountTotals(fx.otherOwner, countId)).rejects.toThrow(NotFoundError);
    await expect(closeCount(fx.otherOwner, countId)).rejects.toThrow(NotFoundError);

    // The owner's count is still reviewed — the foreign close attempt did nothing.
    const [row] = await db.select().from(count).where(eq(count.id, countId));
    expect(row.status).toBe("reviewed");
  });
});

// ---------------------------------------------------------------------------
// A closed count is valued from its own snapshots (invariant 2)
// ---------------------------------------------------------------------------

describe("after close, changing the product's cost and case size does not change the count", () => {
  test("getCount and getCountTotals are identical before and after, for owner and manager alike", async () => {
    // A beer-like shape: a case size, a cost, cases + eaches + a fill.
    await updateProduct(fx.owner, { productId: fx.pricedProductId, caseSize: 12 });
    const c = await openCount(fx.owner, { type: "full" });
    await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 1,
      sealedEachQtyDelta: 2,
      newPartialFills: [0.5],
    });
    await advanceTo(c.id, "closed");

    const ownerDetailBefore = await getCount(fx.owner, c.id);
    const ownerTotalsBefore = await getCountTotals(fx.owner, c.id);
    const managerDetailBefore = await getCount(fx.manager, c.id);
    const managerTotalsBefore = await getCountTotals(fx.manager, c.id);
    const [storedBefore] = await db.select().from(count).where(eq(count.id, c.id));

    // Sanity: the closed count really was valued, from 1 x 12 + 2 + 0.5 = 14.5
    // units at 24.50 = 355.25. Without this the equality below could hold
    // trivially because everything was null.
    expect(ownerDetailBefore.lines[0].units).toBe(14.5);
    expect(ownerTotalsBefore.totalValue).toBe(355.25);
    expect(storedBefore.totalValue).toBe("355.25");

    // The catalog moves on: new supplier, new pack size, new price.
    await updateProduct(fx.owner, {
      productId: fx.pricedProductId,
      caseSize: 6,
      currentUnitCost: "99.0000",
    });

    expect(await getCount(fx.owner, c.id)).toEqual(ownerDetailBefore);
    expect(await getCountTotals(fx.owner, c.id)).toEqual(ownerTotalsBefore);
    expect(await getCount(fx.manager, c.id)).toEqual(managerDetailBefore);
    expect(await getCountTotals(fx.manager, c.id)).toEqual(managerTotalsBefore);
    const [storedAfter] = await db.select().from(count).where(eq(count.id, c.id));
    expect(storedAfter.totalValue).toBe(storedBefore.totalValue);
  });

  test("positive control: a count opened AFTER the catalog change does pick up the new cost and case size", async () => {
    await updateProduct(fx.owner, { productId: fx.pricedProductId, caseSize: 6, currentUnitCost: "99.0000" });
    const c = await openCount(fx.owner, { type: "full" });

    const written = await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 1,
      sealedEachQtyDelta: 2,
      newPartialFills: [0.5],
    });

    // 1 x 6 + 2 + 0.5 = 8.5 units at 99.00 = 841.50.
    expect(written.caseSizeAtCount).toBe(6);
    expect(written.unitCostAtCount).toBe("99.0000");
    expect(written.units).toBe(8.5);
    expect(written.extendedValue).toBe(841.5);
  });
});
