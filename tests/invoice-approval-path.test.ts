/**
 * Invoice approval / cost flow — Phase 2.5, Slice 4 ("Cost Flow + Alerts",
 * docs/plans/phase-2.5-invoice-automation/04-slices.md, Phase D).
 *
 * Covers `lib/domain/cost-derivation.ts:deriveUnitCost` as a pure function,
 * `lib/domain/invoice-approval.ts:approveInvoice` as the transactional
 * domain layer, and `app/actions/invoices.ts:approveInvoiceAction` as the
 * role-gated, Zod-validated boundary — plus every adversarial test named in
 * 04-slices.md's Slice 4 section, using their exact given names.
 *
 * Session mocking follows `tests/invoice-review-path.test.ts`'s convention:
 * `next/headers` and `@/lib/auth` are mocked at module scope, and the
 * action modules under test are imported dynamically (inside each test) so
 * the mocks are in place first.
 *
 * The shared `Fixtures.invoiceId` (tests/helpers/test-db.ts) sits at
 * `needs_review`, not `reviewed`, and its `matchedInvoiceLineId` has no
 * `pack_size` — neither is usable as-is for approval testing. This file
 * builds its own `reviewed` invoices with explicit, priceable lines
 * directly via `db.insert()`, the same ad hoc pattern
 * `tests/invoice-write-path.test.ts` and `tests/matching.test.ts`'s
 * concurrency test already use.
 */
import { readFileSync } from "node:fs";
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db, closePool } from "@/db";
import { invoice, invoiceLine, product, productCostHistory } from "@/db/schema";
import type { InvoiceLineType } from "@/lib/domain/invoice-lines";
import { deriveUnitCost } from "@/lib/domain/cost-derivation";
import { approveInvoice } from "@/lib/domain/invoice-approval";
import { NotFoundError } from "@/lib/domain/errors";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";

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
// Session mocks for the action-layer tests below.
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
// Fixture builders — a REVIEWED invoice with explicit, priceable lines.
// ---------------------------------------------------------------------------

let invoiceCounter = 0;

async function insertReviewedInvoice(organizationId: number, vendorId: number): Promise<number> {
  invoiceCounter += 1;
  const suffix = `approval-${invoiceCounter}`;
  const [inv] = await db
    .insert(invoice)
    .values({
      organizationId,
      vendorId,
      status: "reviewed",
      source: "pdf",
      filePath: `${organizationId}/${suffix}.pdf`,
      fileSha256: suffix.padEnd(64, "0").slice(0, 64),
      fileSizeBytes: 999,
      pageCount: 1,
      invoiceDate: "2026-07-01",
      invoiceNumber: `APPROVAL-${suffix}`,
      totalGross: "100.0000",
      totalDiscount: "0.0000",
      totalNet: "100.0000",
      currency: "USD",
      retentionUntil: "2029-07-01",
    })
    .$returningId();
  return inv.id;
}

interface LineSpec {
  lineNumber: number;
  lineType?: InvoiceLineType;
  matchedProductId?: number | null;
  quantity?: string | null;
  packSize?: number | null;
  rawNet?: string | null;
}

async function insertLine(organizationId: number, invoiceId: number, spec: LineSpec): Promise<number> {
  const [row] = await db
    .insert(invoiceLine)
    .values({
      organizationId,
      invoiceId,
      lineNumber: spec.lineNumber,
      description: `Line ${spec.lineNumber}`,
      lineType: spec.lineType ?? "product",
      quantity: spec.quantity ?? null,
      packSize: spec.packSize ?? null,
      rawGross: spec.rawNet ?? null,
      rawDiscount: "0.00",
      rawNet: spec.rawNet ?? null,
      matchedProductId: spec.matchedProductId ?? null,
      matchMethod: spec.matchedProductId != null ? "manual" : "unmatched",
    })
    .$returningId();
  return row.id;
}

async function selectInvoice(id: number) {
  const [row] = await db.select().from(invoice).where(eq(invoice.id, id));
  return row;
}

async function selectProduct(id: number) {
  const [row] = await db.select().from(product).where(eq(product.id, id));
  return row;
}

async function costHistoryRowsFor(organizationId: number) {
  return db.select().from(productCostHistory).where(eq(productCostHistory.organizationId, organizationId));
}

// ---------------------------------------------------------------------------
// deriveUnitCost — pure function
// ---------------------------------------------------------------------------

describe("deriveUnitCost", () => {
  test("deposit lines never get a derived cost, even with clean numbers", () => {
    expect(
      deriveUnitCost({ lineType: "deposit", quantity: "10.000", packSize: 24, rawNet: "60.00" }),
    ).toBeNull();
  });

  test("deposit_return lines never get a derived cost", () => {
    expect(
      deriveUnitCost({ lineType: "deposit_return", quantity: "10.000", packSize: 24, rawNet: "-60.00" }),
    ).toBeNull();
  });

  test("missing raw_net returns null, never a fabricated number", () => {
    expect(
      deriveUnitCost({ lineType: "product", quantity: "10.000", packSize: 24, rawNet: null }),
    ).toBeNull();
  });

  test("missing quantity returns null", () => {
    expect(
      deriveUnitCost({ lineType: "product", quantity: null, packSize: 24, rawNet: "60.00" }),
    ).toBeNull();
  });

  test("missing pack_size returns null", () => {
    expect(
      deriveUnitCost({ lineType: "product", quantity: "10.000", packSize: null, rawNet: "60.00" }),
    ).toBeNull();
  });

  test("zero quantity returns null rather than dividing by zero", () => {
    expect(
      deriveUnitCost({ lineType: "product", quantity: "0.000", packSize: 24, rawNet: "60.00" }),
    ).toBeNull();
  });

  test("zero pack_size returns null rather than dividing by zero", () => {
    expect(
      deriveUnitCost({ lineType: "product", quantity: "10.000", packSize: 0, rawNet: "60.00" }),
    ).toBeNull();
  });

  test("negative quantity returns null", () => {
    expect(
      deriveUnitCost({ lineType: "product", quantity: "-1.000", packSize: 24, rawNet: "60.00" }),
    ).toBeNull();
  });

  test("computes raw_net / qty / pack_size to 4 decimal places", () => {
    // 294.00 / 12 / 1 = 24.5
    expect(
      deriveUnitCost({ lineType: "product", quantity: "12.000", packSize: 1, rawNet: "294.00" }),
    ).toBe("24.5000");
  });

  test("a case pack divides the cost down to the per-bottle unit", () => {
    // 180.00 / 5 cases / 24 bottles-per-case = 1.50 per bottle
    expect(
      deriveUnitCost({ lineType: "product", quantity: "5.000", packSize: 24, rawNet: "180.00" }),
    ).toBe("1.5000");
  });

  test("returns a string, never a JS number — DECIMAL precision must never round-trip through a float", () => {
    const result = deriveUnitCost({
      lineType: "product",
      quantity: "3.000",
      packSize: 1,
      rawNet: "10.00",
    });
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// approveInvoice — domain layer
// ---------------------------------------------------------------------------

describe("approveInvoice — happy path", () => {
  test("owner approves an invoice with matched product lines: current_unit_cost updates, one history row per line", async () => {
    const invoiceId = await insertReviewedInvoice(fx.organizationId, fx.vendorId);
    // 216.00 / 12 / 1 = 18.0000 — deliberately different from the fixture's
    // 24.5000 starting cost, so a coincidental match can't hide a broken write.
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 1,
      matchedProductId: fx.pricedProductId,
      quantity: "12.000",
      packSize: 1,
      rawNet: "216.00",
    });
    // 375.00 / 10 / 3 = 12.5000 — also different from its 31.2500 starting cost.
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 2,
      matchedProductId: fx.secondProductId,
      quantity: "10.000",
      packSize: 3,
      rawNet: "375.00",
    });

    const result = await approveInvoice(fx.owner, invoiceId);

    expect(result.invoice.status).toBe("approved");
    expect(result.costLinesApplied).toBe(2);

    const priced = await selectProduct(fx.pricedProductId);
    expect(priced.currentUnitCost).toBe("18.0000");
    const second = await selectProduct(fx.secondProductId);
    expect(second.currentUnitCost).toBe("12.5000");

    const rows = await costHistoryRowsFor(fx.organizationId);
    expect(rows).toHaveLength(2);
    const byProduct = new Map(rows.map((r) => [r.productId, r]));
    expect(byProduct.get(fx.pricedProductId)?.unitCost).toBe("18.0000");
    expect(byProduct.get(fx.pricedProductId)?.previousUnitCost).toBe("24.5000");
    expect(byProduct.get(fx.secondProductId)?.unitCost).toBe("12.5000");
    expect(byProduct.get(fx.secondProductId)?.previousUnitCost).toBe("31.2500");
  });

  test("non-priceable lines (deposit, unmatched, missing pack size) are skipped, not defaulted", async () => {
    const invoiceId = await insertReviewedInvoice(fx.organizationId, fx.vendorId);
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 1,
      lineType: "deposit",
      matchedProductId: fx.pricedProductId,
      quantity: "1.000",
      packSize: 1,
      rawNet: "10.00",
    });
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 2,
      matchedProductId: null, // unmatched — line_type product but nothing to price
      quantity: "1.000",
      packSize: 1,
      rawNet: "10.00",
    });
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 3,
      matchedProductId: fx.secondProductId,
      quantity: "1.000",
      packSize: null, // indeterminate pack size — must not default to 1
      rawNet: "10.00",
    });

    const result = await approveInvoice(fx.owner, invoiceId);

    expect(result.costLinesApplied).toBe(0);
    const priced = await selectProduct(fx.pricedProductId);
    expect(priced.currentUnitCost).toBe("24.5000"); // untouched
    const second = await selectProduct(fx.secondProductId);
    expect(second.currentUnitCost).toBe("31.2500"); // untouched
    expect(await costHistoryRowsFor(fx.organizationId)).toHaveLength(0);
  });

  test("an invoice not in reviewed status is refused", async () => {
    // fx.invoiceId sits at needs_review — not a legal starting state.
    const attempt = approveInvoice(fx.owner, fx.invoiceId);
    await expect(attempt).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// review_rejects_cross_tenant_product [AR-2]
// ---------------------------------------------------------------------------

describe("review_rejects_cross_tenant_product", () => {
  test("org A submitting org B's matched_product_id gets NotFoundError, and org B's cost is unchanged", async () => {
    const invoiceId = await insertReviewedInvoice(fx.organizationId, fx.vendorId);
    // Simulates the app-layer review-time ownership check having been
    // bypassed: matchedProductId is a bare, non-tenant-scoped FK, so this
    // insert succeeds at the database layer even though otherProductId
    // belongs to fx.otherOrganizationId, not fx.organizationId.
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 1,
      matchedProductId: fx.otherProductId,
      quantity: "1.000",
      packSize: 1,
      rawNet: "10.00",
    });

    await expect(approveInvoice(fx.owner, invoiceId)).rejects.toThrow(NotFoundError);

    const inv = await selectInvoice(invoiceId);
    expect(inv.status).toBe("reviewed"); // rolled back, not left half-approved

    const other = await selectProduct(fx.otherProductId);
    expect(other.currentUnitCost).toBeNull(); // org B's cost never touched

    expect(await costHistoryRowsFor(fx.organizationId)).toHaveLength(0);
    expect(await costHistoryRowsFor(fx.otherOrganizationId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// invoice_line_fk_refuses_cross_tenant [AR-2]
// ---------------------------------------------------------------------------

describe("invoice_line_fk_refuses_cross_tenant", () => {
  test("with the app-layer check removed, the database still refuses (1452)", async () => {
    // Bypasses approveInvoice's own FOR UPDATE ownership check entirely by
    // inserting directly into product_cost_history: organizationId is org
    // A's, but productId belongs to org B. product_cost_history's composite
    // tenant FK (organization_id, product_id) -> product(organization_id,
    // id) has no matching row for that pair, so MariaDB must refuse this at
    // the constraint layer even with no app code in between.
    const attempt = (async () => {
      await db.insert(productCostHistory).values({
        organizationId: fx.organizationId,
        productId: fx.otherProductId,
        sourceInvoiceId: fx.invoiceId,
        sourceInvoiceLineId: fx.matchedInvoiceLineId,
        unitCost: "10.0000",
        createdBy: fx.owner.userId,
      });
    })();
    await expect(attempt).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// approve_is_idempotent_on_replay [AR-4]
// ---------------------------------------------------------------------------

describe("approve_is_idempotent_on_replay", () => {
  test("approving twice writes one history row per line", async () => {
    const invoiceId = await insertReviewedInvoice(fx.organizationId, fx.vendorId);
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 1,
      matchedProductId: fx.pricedProductId,
      quantity: "12.000",
      packSize: 1,
      rawNet: "216.00",
    });
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 2,
      matchedProductId: fx.secondProductId,
      quantity: "10.000",
      packSize: 3,
      rawNet: "375.00",
    });

    const first = await approveInvoice(fx.owner, invoiceId);
    expect(first.costLinesApplied).toBe(2);

    const second = await approveInvoice(fx.owner, invoiceId);
    expect(second.costLinesApplied).toBe(0); // replay short-circuit, not an error
    expect(second.invoice.approvedAt).toEqual(first.invoice.approvedAt);
    expect(second.invoice.approvedBy).toBe(first.invoice.approvedBy);

    const rows = await costHistoryRowsFor(fx.organizationId);
    expect(rows).toHaveLength(2); // never doubled

    const priced = await selectProduct(fx.pricedProductId);
    expect(priced.currentUnitCost).toBe("18.0000"); // not re-derived or re-applied
  });
});

// ---------------------------------------------------------------------------
// approve_concurrent_applies_once [AR-4]
// ---------------------------------------------------------------------------

describe("approve_concurrent_applies_once", () => {
  test("two simultaneous approvals apply costs once", async () => {
    const invoiceId = await insertReviewedInvoice(fx.organizationId, fx.vendorId);
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 1,
      matchedProductId: fx.pricedProductId,
      quantity: "12.000",
      packSize: 1,
      rawNet: "216.00",
    });
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 2,
      matchedProductId: fx.secondProductId,
      quantity: "10.000",
      packSize: 3,
      rawNet: "375.00",
    });

    // Real concurrency — both calls fire at once, not sequentially. One
    // wins the CAS; the other's FOR UPDATE blocks until the winner commits,
    // then observes `approved` and short-circuits per this file's contract.
    const [a, b] = await Promise.all([
      approveInvoice(fx.owner, invoiceId),
      approveInvoice(fx.owner, invoiceId),
    ]);

    const appliedTotal = a.costLinesApplied + b.costLinesApplied;
    expect(appliedTotal).toBe(2); // applied exactly once across both calls
    expect(a.invoice.status).toBe("approved");
    expect(b.invoice.status).toBe("approved");

    const rows = await costHistoryRowsFor(fx.organizationId);
    expect(rows).toHaveLength(2); // never doubled by the race

    const priced = await selectProduct(fx.pricedProductId);
    expect(priced.currentUnitCost).toBe("18.0000");
    const second = await selectProduct(fx.secondProductId);
    expect(second.currentUnitCost).toBe("12.5000");
  });
});

// ---------------------------------------------------------------------------
// approve_rolls_back_on_midway_failure [AR-4]
// ---------------------------------------------------------------------------

describe("approve_rolls_back_on_midway_failure", () => {
  test("a failure on line 3 of 5 leaves zero cost rows and the invoice still reviewed", async () => {
    const invoiceId = await insertReviewedInvoice(fx.organizationId, fx.vendorId);
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 1,
      matchedProductId: fx.pricedProductId,
      quantity: "1.000",
      packSize: 1,
      rawNet: "10.00",
    });
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 2,
      matchedProductId: fx.secondProductId,
      quantity: "1.000",
      packSize: 1,
      rawNet: "20.00",
    });
    // Line 3: cross-tenant matchedProductId — the loop processes in
    // line_number order, so this is the one that throws mid-loop, AFTER
    // lines 1 and 2 have already inserted their own product_cost_history
    // rows within the same still-open transaction.
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 3,
      matchedProductId: fx.otherProductId,
      quantity: "1.000",
      packSize: 1,
      rawNet: "30.00",
    });
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 4,
      matchedProductId: fx.unpricedProductId,
      quantity: "1.000",
      packSize: 1,
      rawNet: "40.00",
    });
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 5,
      matchedProductId: fx.pricedProductId,
      quantity: "1.000",
      packSize: 1,
      rawNet: "50.00",
    });

    await expect(approveInvoice(fx.owner, invoiceId)).rejects.toThrow(NotFoundError);

    const inv = await selectInvoice(invoiceId);
    expect(inv.status).toBe("reviewed"); // the whole transaction rolled back

    expect(await costHistoryRowsFor(fx.organizationId)).toHaveLength(0); // including lines 1 & 2

    const priced = await selectProduct(fx.pricedProductId);
    expect(priced.currentUnitCost).toBe("24.5000"); // unchanged
    const second = await selectProduct(fx.secondProductId);
    expect(second.currentUnitCost).toBe("31.2500"); // unchanged
    const unpriced = await selectProduct(fx.unpricedProductId);
    expect(unpriced.currentUnitCost).toBeNull(); // unchanged
  });
});

// ---------------------------------------------------------------------------
// schema_matches_live_columns [AR-5]
// ---------------------------------------------------------------------------

describe("schema_matches_live_columns", () => {
  test("migration applies clean from empty; vendor is not recreated", async () => {
    // Live-DB check: product_cost_history exists with exactly the expected
    // columns, proving the migration this test runs against actually
    // applied cleanly (migrateTestDatabase() in beforeAll, against a
    // freshly-truncated-but-still-migrated database each test file).
    const [rows] = (await db.execute(
      sql`SELECT column_name AS name FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'product_cost_history'
          ORDER BY ordinal_position`,
    )) as unknown as [Array<{ name: string }>, unknown];
    const columnNames = rows.map((r) => r.name);
    expect(columnNames).toEqual([
      "id",
      "organization_id",
      "product_id",
      "source_invoice_id",
      "source_invoice_line_id",
      "unit_cost",
      "previous_unit_cost",
      "effective_at",
      "created_by",
    ]);

    // Source check: the migration that introduced product_cost_history must
    // never touch `vendor` — a DROP/CREATE or ALTER of that table hiding
    // inside this migration would be invisible to the column check above
    // (same column names either way) but would still be a real regression.
    const migrationSql = readFileSync(
      `${process.cwd()}/drizzle/0007_yielding_gideon.sql`,
      "utf-8",
    );
    expect(migrationSql).toContain("CREATE TABLE `product_cost_history`");
    expect(migrationSql.toLowerCase()).not.toContain("`vendor`");
  });
});

// ---------------------------------------------------------------------------
// approved_invoice_cannot_be_rejected [AR-4]
// ---------------------------------------------------------------------------

describe("approved_invoice_cannot_be_rejected", () => {
  test("approved is terminal; rejecting it is refused, and cost rows stay while the invoice reads approved", async () => {
    const invoiceId = await insertReviewedInvoice(fx.organizationId, fx.vendorId);
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 1,
      matchedProductId: fx.pricedProductId,
      quantity: "12.000",
      packSize: 1,
      rawNet: "216.00",
    });
    await approveInvoice(fx.owner, invoiceId);

    const { rejectInvoiceAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.owner.userId;
    const result = await rejectInvoiceAction({ invoiceId, reason: "changed my mind" });

    expect(result.ok).toBe(false);

    const inv = await selectInvoice(invoiceId);
    expect(inv.status).toBe("approved"); // never moved to rejected

    expect(await costHistoryRowsFor(fx.organizationId)).toHaveLength(1); // append-only, untouched
  });
});

// ---------------------------------------------------------------------------
// previous_unit_cost_chains [AR-5]
// ---------------------------------------------------------------------------

describe("previous_unit_cost_chains", () => {
  test("two approvals for one product record A->B then B->C, not two jumps from the same baseline", async () => {
    const firstInvoiceId = await insertReviewedInvoice(fx.organizationId, fx.vendorId);
    // 300.00 / 10 / 1 = 30.0000
    await insertLine(fx.organizationId, firstInvoiceId, {
      lineNumber: 1,
      matchedProductId: fx.pricedProductId,
      quantity: "10.000",
      packSize: 1,
      rawNet: "300.00",
    });
    const firstResult = await approveInvoice(fx.owner, firstInvoiceId);
    expect(firstResult.costLinesApplied).toBe(1);

    const priced1 = await selectProduct(fx.pricedProductId);
    expect(priced1.currentUnitCost).toBe("30.0000"); // A -> B

    const secondInvoiceId = await insertReviewedInvoice(fx.organizationId, fx.vendorId);
    // 350.00 / 10 / 1 = 35.0000
    await insertLine(fx.organizationId, secondInvoiceId, {
      lineNumber: 1,
      matchedProductId: fx.pricedProductId,
      quantity: "10.000",
      packSize: 1,
      rawNet: "350.00",
    });
    const secondResult = await approveInvoice(fx.owner, secondInvoiceId);
    expect(secondResult.costLinesApplied).toBe(1);

    const priced2 = await selectProduct(fx.pricedProductId);
    expect(priced2.currentUnitCost).toBe("35.0000"); // B -> C

    const rows = await db
      .select()
      .from(productCostHistory)
      .where(
        and(eq(productCostHistory.organizationId, fx.organizationId), eq(productCostHistory.productId, fx.pricedProductId)),
      );
    expect(rows).toHaveLength(2);
    const bySourceInvoice = new Map(rows.map((r) => [r.sourceInvoiceId, r]));

    // A -> B: previous is the fixture's original cost.
    expect(bySourceInvoice.get(firstInvoiceId)?.unitCost).toBe("30.0000");
    expect(bySourceInvoice.get(firstInvoiceId)?.previousUnitCost).toBe("24.5000");

    // B -> C: previous is what the FIRST approval just wrote — never the
    // same 24.5000 baseline twice, which is the exact regression AR-5 found
    // (previous_unit_cost read outside the transaction).
    expect(bySourceInvoice.get(secondInvoiceId)?.unitCost).toBe("35.0000");
    expect(bySourceInvoice.get(secondInvoiceId)?.previousUnitCost).toBe("30.0000");
  });
});

// ---------------------------------------------------------------------------
// no_reference_to_unit_cost_column [AR-5]
// ---------------------------------------------------------------------------

describe("no_reference_to_unit_cost_column", () => {
  test("no query names product.unit_cost or unit_cost_updated_at — the two columns AR-5 found referenced but nonexistent", () => {
    const files = [
      `${process.cwd()}/lib/domain/cost-derivation.ts`,
      `${process.cwd()}/lib/domain/invoice-approval.ts`,
      `${process.cwd()}/app/actions/invoices.ts`,
    ];
    for (const path of files) {
      const source = readFileSync(path, "utf-8");
      expect(source).not.toContain("unit_cost_updated_at");
      // The real column is product.currentUnitCost; `product.unitCost` is
      // the wrong, nonexistent one AR-5 caught referenced in an earlier
      // draft.
      expect(source).not.toContain("product.unitCost");
    }
  });
});

// ---------------------------------------------------------------------------
// approveInvoiceAction — role gate, Zod, cross-tenant [AR-2] [AR-7]
// ---------------------------------------------------------------------------

describe("approveInvoiceAction", () => {
  async function insertOwnHappyPathInvoice(): Promise<number> {
    const invoiceId = await insertReviewedInvoice(fx.organizationId, fx.vendorId);
    await insertLine(fx.organizationId, invoiceId, {
      lineNumber: 1,
      matchedProductId: fx.pricedProductId,
      quantity: "12.000",
      packSize: 1,
      rawNet: "216.00",
    });
    return invoiceId;
  }

  test("manager is refused", async () => {
    const invoiceId = await insertOwnHappyPathInvoice();
    const { approveInvoiceAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.manager.userId;
    const result = await approveInvoiceAction({ invoiceId });
    expect(result.ok).toBe(false);
  });

  test("staff is refused", async () => {
    const invoiceId = await insertOwnHappyPathInvoice();
    const { approveInvoiceAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.staff.userId;
    const result = await approveInvoiceAction({ invoiceId });
    expect(result.ok).toBe(false);
  });

  test("anonymous (no session) is refused", async () => {
    const invoiceId = await insertOwnHappyPathInvoice();
    const { approveInvoiceAction } = await import("@/app/actions/invoices");
    sessionUserId = null;
    const result = await approveInvoiceAction({ invoiceId });
    expect(result.ok).toBe(false);
  });

  test("an owner from another org gets a not-found-shaped failure, never the row", async () => {
    const invoiceId = await insertOwnHappyPathInvoice();
    const { approveInvoiceAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.otherOwner.userId;
    const result = await approveInvoiceAction({ invoiceId });
    expect(result.ok).toBe(false);

    // Never half-applied against org A's data, even though the request came
    // from a differently-scoped valid owner.
    const inv = await selectInvoice(invoiceId);
    expect(inv.status).toBe("reviewed");
  });

  test("malformed input is refused by Zod before touching the domain layer", async () => {
    const { approveInvoiceAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.owner.userId;
    const result = await approveInvoiceAction({ invoiceId: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.fieldErrors).toBeDefined();
  });

  test("owner approves: product.current_unit_cost updates to a non-null derived value, one product_cost_history row is written", async () => {
    const invoiceId = await insertOwnHappyPathInvoice();
    const { approveInvoiceAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.owner.userId;
    const result = await approveInvoiceAction({ invoiceId });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.invoice.status).toBe("approved");
    expect(result.data.costLinesApplied).toBe(1);

    const priced = await selectProduct(fx.pricedProductId);
    expect(priced.currentUnitCost).not.toBeNull();
    expect(priced.currentUnitCost).toBe("18.0000");

    const rows = await costHistoryRowsFor(fx.organizationId);
    expect(rows).toHaveLength(1);
  });
});
