/**
 * Retire a vendor (#49) — Slice 2, the action layer: role gate (invariant 7),
 * input validation, verbatim error messages.
 *
 * Split from vendor-retire.test.ts for the same reason as vendor-write-path:
 * the actions call `requireSession()`, so `next/headers` and `@/lib/auth` are
 * mocked here, which must happen before `@/app/actions/catalog` is imported
 * (hence the dynamic imports).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { vendor } from "@/db/schema";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";

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

let fx: Fixtures;

beforeAll(async () => {
  await migrateTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fx = await createFixtures();
  sessionUserId = null;
});

afterAll(async () => {
  await closePool();
});

async function vendorActive(id: number): Promise<boolean> {
  const [row] = await db.select({ active: vendor.active }).from(vendor).where(eq(vendor.id, id));
  return row.active;
}

describe("role gate", () => {
  test("staff is refused on listAll, deactivate and reactivate; the row is unchanged", async () => {
    const { listAllVendorsAction, deactivateVendorAction, reactivateVendorAction } = await import(
      "@/app/actions/catalog"
    );
    sessionUserId = fx.staff.userId;

    expect((await listAllVendorsAction()).ok).toBe(false);

    const retired = await deactivateVendorAction({ vendorId: fx.vendorId });
    expect(retired.ok).toBe(false);
    expect(await vendorActive(fx.vendorId)).toBe(true);

    await db.update(vendor).set({ active: false }).where(eq(vendor.id, fx.vendorId));
    const back = await reactivateVendorAction({ vendorId: fx.vendorId });
    expect(back.ok).toBe(false);
    expect(await vendorActive(fx.vendorId)).toBe(false);
  });

  test("no session is refused", async () => {
    const { deactivateVendorAction } = await import("@/app/actions/catalog");
    sessionUserId = null;
    expect((await deactivateVendorAction({ vendorId: fx.vendorId })).ok).toBe(false);
    expect(await vendorActive(fx.vendorId)).toBe(true);
  });

  test("manager and owner can retire and reactivate", async () => {
    const { deactivateVendorAction, reactivateVendorAction } = await import("@/app/actions/catalog");
    for (const actor of [fx.manager, fx.owner]) {
      sessionUserId = actor.userId;
      const r = await deactivateVendorAction({ vendorId: fx.vendorId });
      expect(r).toEqual({ ok: true, data: { vendorId: fx.vendorId, productCount: 0 } });
      expect(await vendorActive(fx.vendorId)).toBe(false);

      const b = await reactivateVendorAction({ vendorId: fx.vendorId });
      expect(b.ok).toBe(true);
      expect(await vendorActive(fx.vendorId)).toBe(true);
    }
  });

  test("another tenant's vendor id is refused with a not-found message, row untouched", async () => {
    const { deactivateVendorAction } = await import("@/app/actions/catalog");
    sessionUserId = fx.owner.userId;
    const r = await deactivateVendorAction({ vendorId: fx.otherVendorId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).not.toMatch(/retired/i);
    expect(await vendorActive(fx.otherVendorId)).toBe(true);
  });
});

describe("lists", () => {
  test("a retired vendor is absent from listVendorsAction and present in listAllVendorsAction", async () => {
    const { listVendorsAction, listAllVendorsAction, deactivateVendorAction } = await import(
      "@/app/actions/catalog"
    );
    sessionUserId = fx.owner.userId;
    await deactivateVendorAction({ vendorId: fx.vendorId });

    const active = await listVendorsAction();
    if (!active.ok) throw new Error("unreachable");
    expect(active.data.map((v) => v.id)).not.toContain(fx.vendorId);

    const all = await listAllVendorsAction();
    if (!all.ok) throw new Error("unreachable");
    const row = all.data.find((v) => v.id === fx.vendorId);
    expect(row?.active).toBe(false);
  });
});

describe("messages reach the client verbatim", () => {
  test("VENDOR_RETIRED (bulk assign to a retired vendor) names the vendor", async () => {
    const { deactivateVendorAction, assignVendorToProductsAction } = await import("@/app/actions/catalog");
    sessionUserId = fx.owner.userId;
    await deactivateVendorAction({ vendorId: fx.vendorId });
    const r = await assignVendorToProductsAction({ productIds: [fx.pricedProductId], vendorId: fx.vendorId });
    expect(r).toEqual({
      ok: false,
      error: {
        message: "Test Distributor is retired. Choose another vendor, or reactivate it on the Vendors screen.",
        fieldErrors: undefined,
      },
    });
  });

  test("VENDOR_NAME_RETIRED (create and rename)", async () => {
    const { deactivateVendorAction, createVendorAction, updateVendorAction } = await import(
      "@/app/actions/catalog"
    );
    sessionUserId = fx.owner.userId;
    await deactivateVendorAction({ vendorId: fx.vendorId });
    const msg = "A retired vendor already uses this name — reactivate it instead.";

    const created = await createVendorAction({ name: "Test Distributor" });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.message).toBe(msg);

    const other = await createVendorAction({ name: "Other Co" });
    if (!other.ok) throw new Error("unreachable");
    const renamed = await updateVendorAction({ id: other.data.id, name: "Test Distributor" });
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.error.message).toBe(msg);
  });
});

describe("input validation", () => {
  test("0, -1, 'x', missing and non-integer return field errors and write nothing", async () => {
    const { deactivateVendorAction, reactivateVendorAction } = await import("@/app/actions/catalog");
    sessionUserId = fx.owner.userId;
    for (const bad of [{ vendorId: 0 }, { vendorId: -1 }, { vendorId: "x" }, { vendorId: 1.5 }, {}, null]) {
      for (const action of [deactivateVendorAction, reactivateVendorAction]) {
        const r = await action(bad);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.message).toBe("Some fields need attention.");
          expect(r.error.fieldErrors?.vendorId ?? r.error.fieldErrors?._root).toBeDefined();
        }
      }
    }
    expect(await vendorActive(fx.vendorId)).toBe(true);
  });
});
