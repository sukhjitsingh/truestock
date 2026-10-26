/**
 * The coverage read behind every closed-count dollar figure (DB-1, phone test
 * 2026-10-25): `getCountCoverages`, and the two owner-only surfaces that carry
 * it — `getLastClosedCount` (dashboard tile) and `listCounts` (counts list).
 *
 * `count.total_value` is stored without any record of how many lines were
 * costed, so a closed `0.00` cannot say "worth nothing" from "no costs on file"
 * on its own. These tests pin that the answer is recomputable from the per-line
 * snapshots, agrees with the live totals, stays owner-only, and never crosses
 * a tenant boundary.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { closePool } from "@/db";
import {
  openCount,
  incrementCountLine,
  submitCount,
  reviewCount,
  closeCount,
  getCountCoverages,
  getCountTotals,
  listCounts,
} from "@/lib/domain/counts";
import { getLastClosedCount } from "@/lib/domain/reports";
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

async function addLine(countId: number, productId: number, each = 2, actor: Fixtures["owner"] = fx.owner) {
  await incrementCountLine(actor, {
    clientLineId: newClientLineId(),
    countId,
    productId,
    locationId: actor === fx.otherOwner ? fx.otherLocationId : fx.locationId,
    sealedCaseQtyDelta: 0,
    sealedEachQtyDelta: each,
    newPartialFills: [],
  });
}

async function close(countId: number, actor: Fixtures["owner"] = fx.owner) {
  await submitCount(actor, countId);
  await reviewCount(actor, countId);
  await closeCount(actor, countId);
}

describe("getCountCoverages", () => {
  test("splits a count into costed and uncosted lines from the line snapshots", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    await addLine(c.id, fx.pricedProductId);
    await addLine(c.id, fx.secondProductId);
    await addLine(c.id, fx.unpricedProductId);

    const coverage = (await getCountCoverages(fx.owner, [c.id])).get(c.id);
    expect(coverage).toEqual({ pricedLineCount: 2, excludedLineCount: 1 });
  });

  test("a count whose lines are all uncosted reports zero costed — the DB-1 case", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    await addLine(c.id, fx.unpricedProductId);

    const coverage = (await getCountCoverages(fx.owner, [c.id])).get(c.id);
    expect(coverage).toEqual({ pricedLineCount: 0, excludedLineCount: 1 });
  });

  test("a count with no lines is present as 0/0, and an empty id list reads nothing", async () => {
    const c = await openCount(fx.owner, { type: "full" });

    expect((await getCountCoverages(fx.owner, [c.id])).get(c.id)).toEqual({
      pricedLineCount: 0,
      excludedLineCount: 0,
    });
    expect((await getCountCoverages(fx.owner, [])).size).toBe(0);
  });

  test("agrees with the live totals the Close button is built from", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    await addLine(c.id, fx.pricedProductId);
    await addLine(c.id, fx.unpricedProductId);

    const totals = await getCountTotals(fx.owner, c.id);
    const coverage = (await getCountCoverages(fx.owner, [c.id])).get(c.id);
    expect(coverage).toEqual({
      pricedLineCount: totals.pricedLineCount,
      excludedLineCount: totals.excludedLineCount,
    });
  });

  test("another tenant's lines are invisible: a foreign count id reads as 0/0, not as a real count", async () => {
    const theirs = await openCount(fx.otherOwner, { type: "full" });
    await addLine(theirs.id, fx.otherProductId, 3, fx.otherOwner);

    // Negative control: their own read does see the line. (The fixture's
    // other-tenant product carries no cost, so it counts as excluded — what
    // matters is that it is counted at all.)
    expect((await getCountCoverages(fx.otherOwner, [theirs.id])).get(theirs.id)).toEqual({
      pricedLineCount: 0,
      excludedLineCount: 1,
    });
    // Mine must not.
    expect((await getCountCoverages(fx.owner, [theirs.id])).get(theirs.id)).toEqual({
      pricedLineCount: 0,
      excludedLineCount: 0,
    });
  });
});

describe("getLastClosedCount coverage", () => {
  test("an owner gets the coverage beside the stored total; it says the $0.00 is uncosted", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    await addLine(c.id, fx.unpricedProductId);
    await close(c.id);

    const result = await getLastClosedCount(fx.owner);
    expect(Number(result!.totalValue)).toBe(0);
    expect(result!.valuationCoverage).toEqual({ pricedLineCount: 0, excludedLineCount: 1 });
  });

  test("a partly costed close reports how many lines back the total", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    await addLine(c.id, fx.pricedProductId, 4);
    await addLine(c.id, fx.unpricedProductId);
    await close(c.id);

    const result = await getLastClosedCount(fx.owner);
    expect(Number(result!.totalValue)).toBeCloseTo(98, 2);
    expect(result!.valuationCoverage).toEqual({ pricedLineCount: 1, excludedLineCount: 1 });
  });

  test("a manager gets neither the total nor the coverage", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    await addLine(c.id, fx.pricedProductId);
    await close(c.id);

    const result = await getLastClosedCount(fx.manager);
    expect(result).not.toBeNull();
    expect(result!.totalValue).toBeUndefined();
    expect(result!.valuationCoverage).toBeUndefined();
  });
});

describe("listCounts coverage", () => {
  test("a closed row carries its coverage for an owner; an open row carries none", async () => {
    const closed = await openCount(fx.owner, { type: "full" });
    await addLine(closed.id, fx.unpricedProductId);
    await close(closed.id);
    const open = await openCount(fx.owner, { type: "full" });
    await addLine(open.id, fx.pricedProductId);

    const rows = await listCounts(fx.owner);
    const closedRow = rows.find((r) => r.id === closed.id)!;
    const openRow = rows.find((r) => r.id === open.id)!;

    expect(closedRow.totalValue).toBe(0);
    expect(closedRow.valuationCoverage).toEqual({ pricedLineCount: 0, excludedLineCount: 1 });
    expect(openRow.totalValue).toBeNull();
    expect(openRow.valuationCoverage).toBeUndefined();
  });

  test("a manager's rows contain no total and no coverage", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    await addLine(c.id, fx.pricedProductId);
    await close(c.id);

    const rows = await listCounts(fx.manager);
    expect(rows).toHaveLength(1);
    expect("totalValue" in rows[0]!).toBe(false);
    expect("valuationCoverage" in rows[0]!).toBe(false);
  });

  test("each closed row gets its own coverage, not a neighbour's", async () => {
    const costed = await openCount(fx.owner, { type: "full" });
    await addLine(costed.id, fx.pricedProductId);
    await close(costed.id);
    const uncosted = await openCount(fx.owner, { type: "full" });
    await addLine(uncosted.id, fx.unpricedProductId);
    await close(uncosted.id);

    const rows = await listCounts(fx.owner);
    expect(rows.find((r) => r.id === costed.id)!.valuationCoverage).toEqual({
      pricedLineCount: 1,
      excludedLineCount: 0,
    });
    expect(rows.find((r) => r.id === uncosted.id)!.valuationCoverage).toEqual({
      pricedLineCount: 0,
      excludedLineCount: 1,
    });
  });
});
