/**
 * Location write path — Slices 2 and 3 (docs/plans/phase-1-to-1.5/04-slices.md).
 *
 * `location.active` (migration 0003) exists; a location can be created,
 * renamed/re-moded, and (Slice 3) retired from the app. The management
 * screen (`listAllLocationsAction`) sees active and retired rows; the
 * scan-picker consumer (`listLocationsAction`) must keep seeing active-only
 * rows with its EXACT current behavior — Gate 2 Decision 5, and the single
 * highest risk in this bundle (a retired location that still accepts real
 * scans with zero errors anywhere).
 *
 * The `describe("createLocation"|"listLocations"|"updateLocation")` blocks
 * below predate `deactivateLocation` (Slice 2) and, where a test needed a
 * RETIRED row to exist, flipped `location.active` directly via `db.update`
 * rather than waiting on it — that is setup for a different function's
 * test, not a claim that `deactivateLocation` works. `deactivateLocation`
 * itself is exercised directly, below, in `describe("deactivateLocation")`
 * (Slice 3).
 *
 * Role gating for the location actions follows `tests/vendor-write-path.test.ts`'s
 * convention: `next/headers` and `@/lib/auth` are mocked at module scope
 * (below, before any describe that needs them) so `requireSession`'s own DB
 * lookup (role, active, organizationId) still runs for real, and
 * `@/app/actions/catalog` is imported dynamically — inside each test that
 * needs it — so the mocks are in place before that module (or anything
 * importing it transitively, i.e. `@/lib/authz`) is ever resolved.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { location, count, countLine, productBarcode } from "@/db/schema";
import {
  createLocation,
  updateLocation,
  deactivateLocation,
  listLocations,
} from "@/lib/domain/catalog";
import {
  openCount,
  incrementCountLine,
  scanCountLine,
  submitCount,
  reviewCount,
  closeCount,
} from "@/lib/domain/counts";
import { NotFoundError, DomainError } from "@/lib/domain/errors";
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

// ---------------------------------------------------------------------------
// Session mocks for the action-layer tests below. Declared at module scope,
// before any test runs, so that whichever test first dynamically imports
// `@/app/actions/catalog` gets the mocked `next/headers` / `@/lib/auth`
// rather than the real ones — matching `tests/vendor-write-path.test.ts`.
// `sessionUserId` starts null (no session); each action-layer test sets it
// to the fixture actor it wants to act as before importing the action.
// ---------------------------------------------------------------------------

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
}));

let sessionUserId: number | null = null;

mock.module("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => {
        if (sessionUserId == null) return null;
        return { session: { id: "mock-session" }, user: { id: String(sessionUserId) } };
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// createLocation
// ---------------------------------------------------------------------------

describe("createLocation", () => {
  test("writes a row scoped to the actor's organization, active by default", async () => {
    const created = await createLocation(fx.owner, { name: "Patio Bar", countMode: "tenths" });

    const rows = await db.select().from(location).where(eq(location.id, created.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(fx.organizationId);
    expect(rows[0].name).toBe("Patio Bar");
    expect(rows[0].active).toBe(true);
    expect(created.active).toBe(true);
  });

  test("a duplicate name in the same org is refused with ConflictError", async () => {
    await createLocation(fx.owner, { name: "Patio Bar", countMode: "tenths" });

    const attempt = createLocation(fx.owner, { name: "Patio Bar", countMode: "quantity" });
    await expect(attempt).rejects.toThrow(/already exists/);

    const rows = await db
      .select()
      .from(location)
      .where(and(eq(location.organizationId, fx.organizationId), eq(location.name, "Patio Bar")));
    expect(rows).toHaveLength(1);
  });

  test("a duplicate name against a RETIRED location in the same org is still refused", async () => {
    // deactivateLocation doesn't exist until slice 3 — flip `active` directly
    // to set up the retired row this test needs.
    const retired = await createLocation(fx.owner, { name: "Old Patio Bar", countMode: "tenths" });
    await db.update(location).set({ active: false }).where(eq(location.id, retired.id));

    const attempt = createLocation(fx.owner, { name: "Old Patio Bar", countMode: "tenths" });
    await expect(attempt).rejects.toThrow(/already exists/);
  });

  test("a duplicate name in a DIFFERENT org succeeds", async () => {
    await createLocation(fx.owner, { name: "Rooftop", countMode: "tenths" });

    const theirs = await createLocation(fx.otherOwner, { name: "Rooftop", countMode: "quantity" });

    expect(theirs.name).toBe("Rooftop");
    const rows = await db.select().from(location).where(eq(location.name, "Rooftop"));
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// listLocations
// ---------------------------------------------------------------------------

describe("listLocations", () => {
  test("returns only active locations by default", async () => {
    const retired = await createLocation(fx.owner, { name: "Closed Tap", countMode: "tenths" });
    await db.update(location).set({ active: false }).where(eq(location.id, retired.id));

    const list = await listLocations(fx.owner);

    expect(list.some((l) => l.id === retired.id)).toBe(false);
    // fx.locationId ("Back Bar") is seeded active — should still appear.
    expect(list.some((l) => l.id === fx.locationId)).toBe(true);
  });

  test("includeInactive: true also returns retired locations", async () => {
    const retired = await createLocation(fx.owner, { name: "Closed Tap", countMode: "tenths" });
    await db.update(location).set({ active: false }).where(eq(location.id, retired.id));

    const list = await listLocations(fx.owner, { includeInactive: true });

    const found = list.find((l) => l.id === retired.id);
    expect(found).toBeDefined();
    expect(found!.active).toBe(false);
  });

  test("returns only the caller's org's locations — a second org's location is the negative control", async () => {
    const list = await listLocations(fx.owner);

    expect(list.some((l) => l.id === fx.otherLocationId)).toBe(false);
    expect(list.every((l) => l.id === fx.locationId)).toBe(true);
  });

  test("listLocationsAction (the scan-picker consumer) still excludes a location after it is deactivated — MUTATION-CHECKED: fails if listLocations's default flips, or if listLocationsAction ever passes includeInactive: true", async () => {
    // deactivateLocation is slice 3 — flip `active` directly to prove the
    // READ side of Decision 5/Risk 1 holds regardless of how a row became
    // inactive.
    await db.update(location).set({ active: false }).where(eq(location.id, fx.locationId));

    sessionUserId = fx.owner.userId;
    const { listLocationsAction } = await import("@/app/actions/catalog");
    const result = await listLocationsAction();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.some((l) => l.id === fx.locationId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateLocation
// ---------------------------------------------------------------------------

describe("updateLocation", () => {
  test("renames without touching count_mode when count_mode is omitted", async () => {
    const created = await createLocation(fx.owner, { name: "Speed Rail", countMode: "quantity" });

    const updated = await updateLocation(fx.owner, { locationId: created.id, name: "Speed Rail 2" });

    expect(updated.name).toBe("Speed Rail 2");
    expect(updated.countMode).toBe("quantity");
  });

  // NOTE: 03-program-design.md's test plan marks this MUTATION-CHECKED
  // against `assertLocationOwned` specifically. Verified by actually
  // removing that call: it did NOT make this test fail, because
  // `updateLocation`'s write and its final re-select are BOTH also scoped
  // to `actor.organizationId` (mirroring `updateProduct`'s "the
  // organization predicate stays on the write as well ... the guarantee
  // that a cross-tenant row cannot be touched even if that check were
  // skipped"). So this test is covered by defense-in-depth across three
  // layers, not gated on this one guard alone — a stronger property than
  // the plan assumed, not a weaker one. See this slice's `deviations`.
  test("a cross-tenant locationId is refused with NotFoundError, and the row is unchanged", async () => {
    const attempt = updateLocation(fx.owner, { locationId: fx.otherLocationId, name: "Hijacked" });
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

    const [row] = await db.select().from(location).where(eq(location.id, fx.otherLocationId));
    expect(row.name).toBe("Their Bar");
    expect(row.organizationId).toBe(fx.otherOrganizationId);
  });

  test("changing count_mode succeeds when the location has no count_line rows", async () => {
    const updated = await updateLocation(fx.owner, {
      locationId: fx.locationId,
      countMode: "quantity",
    });
    expect(updated.countMode).toBe("quantity");
  });

  test("changing count_mode is refused when the location has a line on a non-closed count — MUTATION-CHECKED: removing the guard lets the mode change through", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 3,
      newPartialFills: [],
    });

    const attempt = updateLocation(fx.owner, { locationId: fx.locationId, countMode: "quantity" });
    await expect(attempt).rejects.toBeInstanceOf(DomainError);

    const [row] = await db.select().from(location).where(eq(location.id, fx.locationId));
    expect(row.countMode).toBe("tenths");
  });

  test("changing count_mode succeeds when the location's only lines are on a CLOSED count — negative control proving the guard is 'no open lines,' not 'never touched'", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 3,
      newPartialFills: [],
    });
    await submitCount(fx.owner, c.id);
    await reviewCount(fx.owner, c.id);
    await closeCount(fx.owner, c.id);

    // Sanity: the line really is on a closed count before asserting the guard lets it through.
    const [closedCount] = await db.select({ status: count.status }).from(count).where(eq(count.id, c.id));
    expect(closedCount.status).toBe("closed");
    const lines = await db.select().from(countLine).where(eq(countLine.countId, c.id));
    expect(lines).toHaveLength(1);

    const updated = await updateLocation(fx.owner, { locationId: fx.locationId, countMode: "quantity" });
    expect(updated.countMode).toBe("quantity");
  });
});

// ---------------------------------------------------------------------------
// deactivateLocation — Slice 3 (docs/plans/phase-1-to-1.5/04-slices.md).
//
// Mirrors `setUserActive` (`lib/domain/users.ts:110-155`): one transaction,
// `assertLocationOwned` first, then two independent refusals (last-active-
// location, Decision 6; in-use-by-open-count, Decision 4 — applied
// UNCONDITIONALLY, unlike `updateLocation`'s count-mode guard which only
// fires on a diff), then the `active = false` write. Never a DELETE
// (invariant 6).
// ---------------------------------------------------------------------------

describe("deactivateLocation", () => {
  test("sets active = false", async () => {
    // fx.locationId ("Back Bar") is seeded active with no other active
    // location in the org — add a second so retiring it isn't refused by
    // the last-active-location guard, which is a separate test below.
    await createLocation(fx.owner, { name: "Storeroom", countMode: "quantity" });

    await deactivateLocation(fx.owner, fx.locationId);

    const [row] = await db.select().from(location).where(eq(location.id, fx.locationId));
    expect(row.active).toBe(false);
  });

  test(
    "refuses to deactivate the LAST active location in the org — MUTATION-CHECKED: removing the guard lets the deactivation through",
    async () => {
      // fx.locationId is the ONLY active location in its org at this point
      // (createFixtures seeds exactly one).
      const attempt = deactivateLocation(fx.owner, fx.locationId);
      await expect(attempt).rejects.toBeInstanceOf(DomainError);

      const [row] = await db.select().from(location).where(eq(location.id, fx.locationId));
      expect(row.active).toBe(true);
    },
  );

  test("deactivating a non-last active location succeeds when at least one other stays active — negative control", async () => {
    const second = await createLocation(fx.owner, { name: "Storeroom", countMode: "quantity" });

    await deactivateLocation(fx.owner, fx.locationId);

    const [retired] = await db.select().from(location).where(eq(location.id, fx.locationId));
    expect(retired.active).toBe(false);
    const [stillActive] = await db.select().from(location).where(eq(location.id, second.id));
    expect(stillActive.active).toBe(true);
  });

  test(
    "refuses to deactivate a location with a line on a non-closed count — MUTATION-CHECKED: removing the guard lets the deactivation through",
    async () => {
      await createLocation(fx.owner, { name: "Storeroom", countMode: "quantity" });

      const c = await openCount(fx.owner, { type: "full" });
      await incrementCountLine(fx.owner, {
        clientLineId: newClientLineId(),
        countId: c.id,
        productId: fx.pricedProductId,
        locationId: fx.locationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 3,
        newPartialFills: [],
      });

      const attempt = deactivateLocation(fx.owner, fx.locationId);
      await expect(attempt).rejects.toBeInstanceOf(DomainError);

      const [row] = await db.select().from(location).where(eq(location.id, fx.locationId));
      expect(row.active).toBe(true);
    },
  );

  test("deactivating a location whose only lines are on a CLOSED count succeeds — negative control, Decision 4", async () => {
    await createLocation(fx.owner, { name: "Storeroom", countMode: "quantity" });

    const c = await openCount(fx.owner, { type: "full" });
    await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 3,
      newPartialFills: [],
    });
    await submitCount(fx.owner, c.id);
    await reviewCount(fx.owner, c.id);
    await closeCount(fx.owner, c.id);

    await deactivateLocation(fx.owner, fx.locationId);

    const [row] = await db.select().from(location).where(eq(location.id, fx.locationId));
    expect(row.active).toBe(false);
  });

  test("a cross-tenant locationId is refused with NotFoundError", async () => {
    const attempt = deactivateLocation(fx.owner, fx.otherLocationId);
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

    const [row] = await db.select().from(location).where(eq(location.id, fx.otherLocationId));
    expect(row.active).toBe(true);
    expect(row.organizationId).toBe(fx.otherOrganizationId);
  });
});

// ---------------------------------------------------------------------------
// Role gating (action layer) — createLocationAction / updateLocationAction /
// deactivateLocationAction all require requireRole("owner", "manager").
// ---------------------------------------------------------------------------

describe("role gating on the location actions", () => {
  test("staff is refused on create, update, and deactivate — and nothing is written", async () => {
    const { createLocationAction, updateLocationAction, deactivateLocationAction } = await import(
      "@/app/actions/catalog"
    );

    sessionUserId = fx.staff.userId;

    const created = await createLocationAction({ name: "Staff Location", countMode: "tenths" });
    expect(created.ok).toBe(false);
    const rows = await db.select().from(location).where(eq(location.name, "Staff Location"));
    expect(rows).toHaveLength(0);

    const updated = await updateLocationAction({ locationId: fx.locationId, name: "Staff Renamed" });
    expect(updated.ok).toBe(false);
    const [unchanged] = await db.select().from(location).where(eq(location.id, fx.locationId));
    expect(unchanged.name).toBe("Back Bar");

    const deactivated = await deactivateLocationAction({ locationId: fx.locationId });
    expect(deactivated.ok).toBe(false);
    const [stillActive] = await db.select().from(location).where(eq(location.id, fx.locationId));
    expect(stillActive.active).toBe(true);
  });

  test("manager is permitted on create, update, and deactivate — the positive control", async () => {
    const { createLocationAction, updateLocationAction, deactivateLocationAction } = await import(
      "@/app/actions/catalog"
    );

    sessionUserId = fx.manager.userId;

    const created = await createLocationAction({ name: "Manager Location", countMode: "tenths" });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const updated = await updateLocationAction({ locationId: created.data.id, name: "Manager Renamed" });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("unreachable");
    expect(updated.data.name).toBe("Manager Renamed");

    // fx.locationId ("Back Bar") is still active and the created location is
    // still active too, so deactivating "Back Bar" is not refused by the
    // last-active-location guard — it is a role-gating positive control,
    // not a guard test.
    const deactivated = await deactivateLocationAction({ locationId: fx.locationId });
    expect(deactivated.ok).toBe(true);
    const [row] = await db.select().from(location).where(eq(location.id, fx.locationId));
    expect(row.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Write-path guard against a RETIRED location — the gap the review found:
// `listLocationsAction` (Decision 5) keeps a retired location out of a
// FRESH fetch, but the scan screen fetches `locations` once per leg and
// never refetches, so a client can still be holding a now-retired location
// as its active leg. `upsertCountLineRow` (lib/domain/counts.ts, shared by
// `incrementCountLine` and `scanCountLine`) must itself refuse a write into
// a retired location — the read-side exclusion is not a substitute for a
// write-side check.
//
// `deactivateLocation` is exercised for real (not by flipping `active`
// directly) so this proves the exact "own tab retires it, other tab keeps
// scanning" scenario from the finding, using a second location so the
// last-active-location guard (Decision 6) doesn't interfere.
// ---------------------------------------------------------------------------

describe("write-path guard: a retired location refuses count-line writes", () => {
  test(
    "incrementCountLine into a just-retired location is refused with DomainError, and no row is written — MUTATION-CHECKED: removing the active check lets the write through",
    async () => {
      // A second active location so deactivating fx.locationId isn't
      // blocked by the last-active-location guard.
      await createLocation(fx.owner, { name: "Storeroom", countMode: "quantity" });

      const c = await openCount(fx.owner, { type: "full" });

      // Simulates the finding's scenario: no lines have been scanned into
      // fx.locationId yet, so deactivateLocation's hasOpenCountLines guard
      // does not block the retirement — exactly why the write path, not
      // just the deactivate guard, must refuse the write.
      await deactivateLocation(fx.owner, fx.locationId);
      const [retired] = await db.select().from(location).where(eq(location.id, fx.locationId));
      expect(retired.active).toBe(false);

      const attempt = incrementCountLine(fx.owner, {
        clientLineId: newClientLineId(),
        countId: c.id,
        productId: fx.pricedProductId,
        locationId: fx.locationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 3,
        newPartialFills: [],
      });
      await expect(attempt).rejects.toBeInstanceOf(DomainError);

      const lines = await db.select().from(countLine).where(eq(countLine.countId, c.id));
      expect(lines).toHaveLength(0);
    },
  );

  test("scanCountLine into a just-retired location is refused too — same guard, the barcode-driven caller", async () => {
    await createLocation(fx.owner, { name: "Storeroom", countMode: "quantity" });
    const barcode = "012345678905";
    await db.insert(productBarcode).values({
      productId: fx.pricedProductId,
      barcode,
      packLevel: "each",
      organizationId: fx.organizationId,
    });

    const c = await openCount(fx.owner, { type: "full" });
    await deactivateLocation(fx.owner, fx.locationId);

    const attempt = scanCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      locationId: fx.locationId,
      barcode,
      qty: 1,
    });
    await expect(attempt).rejects.toBeInstanceOf(DomainError);

    const lines = await db.select().from(countLine).where(eq(countLine.countId, c.id));
    expect(lines).toHaveLength(0);
  });

  test(
    "a SECOND write into a location retired after the FIRST write is also refused — proves the check runs unconditionally, not only on the insert-only branch",
    async () => {
      await createLocation(fx.owner, { name: "Storeroom", countMode: "quantity" });
      const c = await openCount(fx.owner, { type: "full" });

      // First write lands while the location is still active.
      await incrementCountLine(fx.owner, {
        clientLineId: newClientLineId(),
        countId: c.id,
        productId: fx.pricedProductId,
        locationId: fx.locationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 3,
        newPartialFills: [],
      });

      // deactivateLocation's hasOpenCountLines guard now correctly refuses
      // to retire a location with a line on an open count (Decision 4) —
      // so simulate the location being retired by a route that already
      // exists for other reasons (a direct flip), which is the only way to
      // reach "existing line, now-retired location" without contradicting
      // that separate guard.
      await db.update(location).set({ active: false }).where(eq(location.id, fx.locationId));

      const attempt = incrementCountLine(fx.owner, {
        clientLineId: newClientLineId(),
        countId: c.id,
        productId: fx.pricedProductId,
        locationId: fx.locationId,
        sealedCaseQtyDelta: 0,
        sealedEachQtyDelta: 1,
        newPartialFills: [],
      });
      await expect(attempt).rejects.toBeInstanceOf(DomainError);

      // The delta from the refused second write must not have landed —
      // the line stays exactly where the first write left it.
      const [line] = await db.select().from(countLine).where(eq(countLine.countId, c.id));
      expect(line.sealedEachQty).toBe(3);
    },
  );

  test("incrementCountLine into a STILL-active location succeeds — negative control proving the guard checks active, not just existence", async () => {
    const c = await openCount(fx.owner, { type: "full" });
    const written = await incrementCountLine(fx.owner, {
      clientLineId: newClientLineId(),
      countId: c.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedCaseQtyDelta: 0,
      sealedEachQtyDelta: 2,
      newPartialFills: [],
    });
    expect(written.sealedEachQty).toBe(2);
  });
});
