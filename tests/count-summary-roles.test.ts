/**
 * `countSummary` (lib/domain/reports.ts) — the count's report payload — had no
 * behavioural test at all. It is also the single densest place where
 * invariants 2, 8 and 9 meet: it sums money, it rolls that money up by category
 * and location, and it compares against a previous count.
 *
 * Guards AGENTS.md invariant 8 (cost and margin data is gated by role, in the
 * payload SHAPE, server-side — the keys must be ABSENT for a non-owner, not
 * present-and-hidden), invariant 2 (an unpriced line is excluded, never $0; the
 * previous count's value comes from its stored snapshot, never from today's
 * product cost) and invariant 9 (a foreign countId is NotFound, and another
 * tenant's closed count is never offered as "previous").
 *
 * Mutations that must turn this file red:
 *   - lib/domain/reports.ts countSummary: change `if (showCost) {
 *     summary.totalValue = ... }` to run unconditionally (manager gets the total).
 *   - lib/domain/reports.ts addTo: create every group with `value: 0` regardless
 *     of `showCost` (a rollup leaks the dollar sum the line gate withholds).
 *   - lib/domain/reports.ts previousCountComparison: always set
 *     `comparison.totalValue` / `valueDelta`, outside the `if (showCost)` block.
 *   - lib/domain/reports.ts previousCountComparison: drop `eq(count.status,
 *     "closed")` (an abandoned draft becomes "previous"), or drop the
 *     `eq(count.organizationId, ...)` predicate (another tenant's count does).
 *   - lib/domain/reports.ts previousCountComparison: always use
 *     `prevTotals.totalValue` instead of the stored `prev.totalValue`.
 *   - lib/domain/valuation.ts computeLineValuation: coerce NULL cost to 0.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { count } from "@/db/schema";
import { countSummary, type CountSummary } from "@/lib/domain/reports";
import {
  openCount,
  incrementCountLine,
  submitCount,
  reviewCount,
  closeCount,
} from "@/lib/domain/counts";
import { createLocation, updateProduct } from "@/lib/domain/catalog";
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

// Relative to one anchor taken at load, never a hard-coded calendar date: a
// literal date in a fixture is a test that starts failing on some future day.
// Floored to whole seconds: the TIMESTAMP columns store no sub-second part, so
// a millisecond anchor would not round-trip through the database.
const ANCHOR = Math.floor(Date.now() / 1000) * 1000;
const daysAgo = (n: number) => new Date(ANCHOR - n * 86_400_000);

interface LineSpec {
  actor?: Fixtures["owner"];
  productId: number;
  locationId: number;
  each: number;
  fills?: number[];
}

async function countWith(specs: LineSpec[], opener: Fixtures["owner"] = fx.owner): Promise<number> {
  const c = await openCount(opener, { type: "full" });
  for (const s of specs) {
    await incrementCountLine(s.actor ?? opener, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: s.productId,
      locationId: s.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: s.each,
      newPartialFills: s.fills ?? [],
    });
  }
  return c.id;
}

async function closeIt(countId: number, actor: Fixtures["owner"] = fx.owner) {
  await submitCount(actor, countId);
  await reviewCount(actor, countId);
  await closeCount(actor, countId);
}

/** Pin timestamps directly so ordering never depends on real wall-clock gaps. */
async function stamp(countId: number, times: { startedAt?: Date; closedAt?: Date }) {
  await db.update(count).set(times).where(eq(count.id, countId));
}

/** Every key at every depth — so a leaked dollar figure is found wherever it hides. */
function keysDeep(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) keysDeep(v, out);
  } else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

/** Keys that look like money. `pricedLineCount` is a COUNT of lines, not a figure. */
function moneyKeys(summary: CountSummary): string[] {
  return [...keysDeep(summary)]
    .filter((k) => /value|cost|price|margin|amount|dollar/i.test(k))
    .filter((k) => k !== "pricedLineCount")
    .sort();
}

/**
 * The shared closed count:
 *   Back Bar  : Tito's (cost 24.50) 2 each + [0.5]  -> 2.5 units, $61.25   (Spirits)
 *   Back Bar  : House Infusion (NO cost) 3 each      -> 3 units, unpriced   (Spirits)
 *   Storeroom : Bulleit (cost 31.25, re-filed Wine) 4 each -> 4 units, $125 (Wine)
 */
async function buildMainCount() {
  const storeroom = await createLocation(fx.owner, { name: "Storeroom", countMode: "quantity" });
  await updateProduct(fx.owner, { productId: fx.secondProductId, category: "Wine" });
  const countId = await countWith([
    { productId: fx.pricedProductId, locationId: fx.locationId, each: 2, fills: [0.5] },
    { productId: fx.unpricedProductId, locationId: fx.locationId, each: 3 },
    { productId: fx.secondProductId, locationId: storeroom.id, each: 4 },
  ]);
  await closeIt(countId);
  return { countId, storeroomId: storeroom.id };
}

// ---------------------------------------------------------------------------
// Owner: the full payload, correct
// ---------------------------------------------------------------------------

describe("countSummary — owner payload", () => {
  test("totals: dollars exclude the unpriced line, units include it", async () => {
    const { countId } = await buildMainCount();

    const s = await countSummary(fx.owner, countId);

    expect(s.countId).toBe(countId);
    expect(s.status).toBe("closed");
    expect(s.totalValue).toBe(186.25); // 61.25 + 125.00; NOT 61.25 + 0 + 125.00 with a phantom line
    expect(s.totalUnits).toBe(9.5); // 2.5 + 3 + 4
    expect(s.pricedLineCount).toBe(2);
    expect(s.excludedLineCount).toBe(1);
  });

  test("per-line figures: the uncosted line has units but NO extendedValue — undefined, never 0", async () => {
    const { countId } = await buildMainCount();

    const s = await countSummary(fx.owner, countId);

    const byProduct = new Map(s.lines.map((l) => [l.productId, l]));
    expect(s.lines).toHaveLength(3);
    expect(byProduct.get(fx.pricedProductId)!.units).toBe(2.5);
    expect(byProduct.get(fx.pricedProductId)!.extendedValue).toBe(61.25);
    expect(byProduct.get(fx.secondProductId)!.extendedValue).toBe(125);
    const unpriced = byProduct.get(fx.unpricedProductId)!;
    expect(unpriced.units).toBe(3);
    expect(unpriced.extendedValue).toBeUndefined();
    expect(unpriced.extendedValue).not.toBe(0);
  });

  test("byCategory: units, lineCount, excludedLineCount and value are right, ordered by units desc", async () => {
    const { countId } = await buildMainCount();

    const s = await countSummary(fx.owner, countId);

    expect(s.byCategory).toEqual([
      { key: "Spirits", label: "Spirits", lineCount: 2, units: 5.5, excludedLineCount: 1, value: 61.25 },
      { key: "Wine", label: "Wine", lineCount: 1, units: 4, excludedLineCount: 0, value: 125 },
    ]);
  });

  test("byLocation: grouped by location id, labelled by name, with the same figures", async () => {
    const { countId, storeroomId } = await buildMainCount();

    const s = await countSummary(fx.owner, countId);

    expect(s.byLocation).toEqual([
      {
        key: String(fx.locationId),
        label: "Back Bar",
        lineCount: 2,
        units: 5.5,
        excludedLineCount: 1,
        value: 61.25,
      },
      {
        key: String(storeroomId),
        label: "Storeroom",
        lineCount: 1,
        units: 4,
        excludedLineCount: 0,
        value: 125,
      },
    ]);
  });

  test("a first closed count has no previous", async () => {
    const { countId } = await buildMainCount();
    expect((await countSummary(fx.owner, countId)).previous).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manager and staff: quantities yes, dollars never (invariant 8)
// ---------------------------------------------------------------------------

describe("countSummary — non-owner payload carries no money, by key absence", () => {
  test("positive control: the OWNER payload does contain money keys at every level", async () => {
    // If this is empty, moneyKeys() has stopped finding money and the
    // absence assertions below pass for the wrong reason.
    const { countId } = await buildMainCount();
    const prior = await countWith([{ productId: fx.pricedProductId, locationId: fx.locationId, each: 1 }]);
    await closeIt(prior);
    await stamp(prior, { startedAt: daysAgo(30), closedAt: daysAgo(29) });

    const s = await countSummary(fx.owner, countId);

    expect(moneyKeys(s)).toEqual(["extendedValue", "totalValue", "value", "valueDelta"]);
  });

  for (const role of ["manager", "staff"] as const) {
    test(`${role}: totalValue, extendedValue, group.value, previous.totalValue and previous.valueDelta are all ABSENT`, async () => {
      const { countId } = await buildMainCount();
      const prior = await countWith([{ productId: fx.pricedProductId, locationId: fx.locationId, each: 1 }]);
      await closeIt(prior);
      await stamp(prior, { startedAt: daysAgo(30), closedAt: daysAgo(29) });

      const s = await countSummary(fx[role], countId);

      // Key absence, not `=== undefined`: JSON and Server Action serialisation
      // can still carry a key whose value is undefined/null.
      expect("totalValue" in s).toBe(false);
      for (const l of s.lines) expect("extendedValue" in l).toBe(false);
      for (const g of [...s.byCategory, ...s.byLocation]) expect("value" in g).toBe(false);
      expect(s.previous).not.toBeNull();
      expect("totalValue" in s.previous!).toBe(false);
      expect("valueDelta" in s.previous!).toBe(false);
      // ...and nothing else money-shaped hides anywhere in the tree.
      expect(moneyKeys(s)).toEqual([]);
    });

    test(`${role}: still receives every QUANTITY the owner does`, async () => {
      const { countId } = await buildMainCount();
      const ownerView = await countSummary(fx.owner, countId);

      const s = await countSummary(fx[role], countId);

      expect(s.totalUnits).toBe(ownerView.totalUnits);
      expect(s.pricedLineCount).toBe(ownerView.pricedLineCount);
      expect(s.excludedLineCount).toBe(1);
      expect(s.lines.map((l) => [l.productId, l.units])).toEqual(
        ownerView.lines.map((l) => [l.productId, l.units]),
      );
      expect(s.byCategory.map((g) => [g.key, g.units, g.lineCount, g.excludedLineCount])).toEqual([
        ["Spirits", 5.5, 2, 1],
        ["Wine", 4, 1, 0],
      ]);
    });
  }
});

// ---------------------------------------------------------------------------
// The previous-count comparison
// ---------------------------------------------------------------------------

describe("countSummary — previous count", () => {
  /**
   * P1 closed 20d ago, P2 closed 10d ago (4 each = $98.00), an abandoned draft
   * D started 5d ago (999 each), a count M closed 12h ago but AFTER K started,
   * and K (the one summarised) started 1d ago: 6 each + [0.5] = 6.5 units, $159.25.
   */
  async function buildTimeline() {
    const p1 = await countWith([{ productId: fx.pricedProductId, locationId: fx.locationId, each: 1 }]);
    await closeIt(p1);
    await stamp(p1, { startedAt: daysAgo(21), closedAt: daysAgo(20) });

    const p2 = await countWith([{ productId: fx.pricedProductId, locationId: fx.locationId, each: 4 }]);
    await closeIt(p2);
    await stamp(p2, { startedAt: daysAgo(11), closedAt: daysAgo(10) });

    // Never closed. Its id is higher than P2's and it started after P2 closed,
    // so a "previous row by id" or "latest count" query would pick it.
    const draft = await countWith([
      { productId: fx.pricedProductId, locationId: fx.locationId, each: 999 },
    ]);
    await stamp(draft, { startedAt: daysAgo(5) });

    const mid = await countWith([{ productId: fx.pricedProductId, locationId: fx.locationId, each: 7 }]);
    await closeIt(mid);
    await stamp(mid, { startedAt: daysAgo(3), closedAt: new Date(ANCHOR - 12 * 3_600_000) });

    const k = await countWith([
      { productId: fx.pricedProductId, locationId: fx.locationId, each: 6, fills: [0.5] },
    ]);
    await closeIt(k);
    await stamp(k, { startedAt: daysAgo(1), closedAt: new Date(ANCHOR) });

    return { p1, p2, draft, mid, k };
  }

  test("previous is the latest CLOSED count that closed before this one STARTED", async () => {
    const t = await buildTimeline();

    const s = await countSummary(fx.owner, t.k);

    // Not P1 (older), not the draft (never closed), not M (closed after K began).
    expect(s.previous).not.toBeNull();
    expect(s.previous!.countId).toBe(t.p2);
    expect(s.previous!.closedAt).toEqual(daysAgo(10));
  });

  test("an abandoned draft is ignored even though it is newer and bigger", async () => {
    const t = await buildTimeline();
    const s = await countSummary(fx.owner, t.k);
    expect(s.previous!.countId).not.toBe(t.draft);
    // 999 units would have made unitsDelta hugely negative.
    expect(s.previous!.totalUnits).toBe(4);
  });

  test("a count closed after this one started is not its predecessor (cutoff is startedAt, not closedAt)", async () => {
    const t = await buildTimeline();
    const s = await countSummary(fx.owner, t.k);
    expect(s.previous!.countId).not.toBe(t.mid);
  });

  test("owner deltas: units and value, against the previous count's figures", async () => {
    const t = await buildTimeline();

    const s = await countSummary(fx.owner, t.k);

    expect(s.totalUnits).toBe(6.5);
    expect(s.totalValue).toBe(159.25);
    expect(s.previous!.totalUnits).toBe(4);
    expect(s.previous!.unitsDelta).toBe(2.5);
    expect(s.previous!.totalValue).toBe(98);
    expect(s.previous!.valueDelta).toBe(61.25);
  });

  test("manager gets the units delta but neither previous.totalValue nor previous.valueDelta", async () => {
    const t = await buildTimeline();

    const s = await countSummary(fx.manager, t.k);

    expect(s.previous!.countId).toBe(t.p2);
    expect(s.previous!.unitsDelta).toBe(2.5);
    expect("totalValue" in s.previous!).toBe(false);
    expect("valueDelta" in s.previous!).toBe(false);
  });

  test("a later product-cost change does not alter the comparison (valued from snapshots, invariant 2)", async () => {
    const t = await buildTimeline();
    const before = await countSummary(fx.owner, t.k);

    await updateProduct(fx.owner, { productId: fx.pricedProductId, currentUnitCost: "99.0000" });

    expect(await countSummary(fx.owner, t.k)).toEqual(before);
  });

  test("valueDelta is driven by the previous count's STORED total_value, not a recomputation", async () => {
    // Direct write of a closed row — a probe, not a supported operation. It is
    // the only way to tell "reads the stored snapshot" from "recomputes the
    // same number from the lines", which are otherwise indistinguishable.
    const t = await buildTimeline();
    await db.update(count).set({ totalValue: "1000.00" }).where(eq(count.id, t.p2));

    const s = await countSummary(fx.owner, t.k);

    expect(s.previous!.totalValue).toBe(1000);
    expect(s.previous!.valueDelta).toBe(-840.75); // 159.25 - 1000
  });

  test("a previous count with no stored total_value falls back to its own snapshot lines", async () => {
    const t = await buildTimeline();
    await db.update(count).set({ totalValue: null }).where(eq(count.id, t.p2));

    const s = await countSummary(fx.owner, t.k);

    expect(s.previous!.totalValue).toBe(98);
    expect(s.previous!.valueDelta).toBe(61.25);
  });

  test("another tenant's newer closed count is never offered as previous", async () => {
    const t = await buildTimeline();
    const theirs = await countWith(
      [{ productId: fx.otherProductId, locationId: fx.otherLocationId, each: 50 }],
      fx.otherOwner,
    );
    await closeIt(theirs, fx.otherOwner);
    await stamp(theirs, { startedAt: daysAgo(3), closedAt: daysAgo(2) });

    const s = await countSummary(fx.owner, t.k);

    expect(s.previous!.countId).toBe(t.p2);
    expect(s.previous!.countId).not.toBe(theirs);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (invariant 9)
// ---------------------------------------------------------------------------

describe("countSummary — tenant isolation", () => {
  test("another tenant's countId is NotFound for every role, and the owning tenant still gets it", async () => {
    const { countId } = await buildMainCount();

    await expect(countSummary(fx.otherOwner, countId)).rejects.toThrow(NotFoundError);
    // A nonexistent id gives the identical answer, so the two cannot be told apart.
    await expect(countSummary(fx.otherOwner, countId + 9999)).rejects.toThrow(NotFoundError);

    const own = await countSummary(fx.owner, countId);
    expect(own.countId).toBe(countId);
  });
});
