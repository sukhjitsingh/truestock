/**
 * Pure unit tests for the role predicates that drive per-role UI construction
 * — lib/authz.ts's `canSeeCost` / `canManageCost` / `canManageInventoryOps`.
 *
 * Scope note, honestly stated: `components/office/catalog-table.tsx` builds
 * its TanStack `columns: ColumnDef[]` array conditionally at call time —
 * `columnVisibility` is never used, per the binding rule in
 * docs/design-system.md and CLAUDE.md invariant 8 — but that column-array
 * construction lives inside a "use client" component with hooks and JSX and
 * exports no standalone pure builder function, so it cannot be unit-tested
 * directly without a rendering harness (this project has none — no jsdom,
 * no @testing-library/react in package.json; confirmed before writing this
 * file). What CAN be unit-tested, and is the thing catalog-table.tsx's own
 * `canManage`/`canSeeCost` locals are equivalent to, is the role predicate
 * layer these decisions are ultimately gated on. The actual per-role DOM
 * shape (does a manager's table really omit the cost column, not just hide
 * it) is verified where it can only truly be proven — against a rendered
 * browser DOM — by scripts/verify-browser.mjs's owner/manager checks.
 */
import { describe, test, expect } from "bun:test";
import { canSeeCost, canManageCost, canManageInventoryOps } from "@/lib/authz";

const ROLES = ["owner", "manager", "staff"] as const;

describe("canSeeCost — gates the catalog table's entire cost column", () => {
  test("true for owner only", () => {
    expect(canSeeCost("owner")).toBe(true);
    expect(canSeeCost("manager")).toBe(false);
    expect(canSeeCost("staff")).toBe(false);
  });
});

describe("canManageCost — gates whether the cost cell is an editable input or read-only Money", () => {
  test("true for owner only, same as canSeeCost today", () => {
    for (const role of ROLES) {
      expect(canManageCost(role)).toBe(canSeeCost(role));
    }
  });
});

describe("canManageInventoryOps — gates the select column, the case-size column, and the row Edit button", () => {
  test("true for owner and manager, false for staff", () => {
    expect(canManageInventoryOps("owner")).toBe(true);
    expect(canManageInventoryOps("manager")).toBe(true);
    expect(canManageInventoryOps("staff")).toBe(false);
  });

  test("staff gets neither cost NOR management columns — the catalog table renders staff the fewest columns of any role", () => {
    expect(canSeeCost("staff")).toBe(false);
    expect(canManageInventoryOps("staff")).toBe(false);
  });

  test("manager gets management columns but not cost — the specific split the Phase 2 completion criterion is about", () => {
    expect(canManageInventoryOps("manager")).toBe(true);
    expect(canSeeCost("manager")).toBe(false);
  });
});
