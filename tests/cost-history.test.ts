/**
 * lib/domain/cost-history.ts — Phase 2.5 backend follow-on, Part B
 * (docs/plans/phase-2.5-backend-followons/03-program-design.md).
 *
 * Seeding helpers mirror tests/invoice-approval-path.test.ts's own local
 * `insertReviewedInvoice`/`insertLine` pattern (not exported from that file,
 * so reproduced here rather than imported) — two real `approveInvoice` calls
 * for the same product produce a real, correctly-chained history to assert
 * against, exactly as 03-program-design.md's Test plan calls for.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { db, closePool } from "@/db";
import { invoice, invoiceLine } from "@/db/schema";
import type { InvoiceLineType } from "@/lib/domain/invoice-lines";
import { approveInvoice } from "@/lib/domain/invoice-approval";
import { getProductCostHistory, getCostPostingsForInvoice } from "@/lib/domain/cost-history";
import { AuthzError } from "@/lib/authz";
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
// Fixture builders — a REVIEWED invoice with an explicit, priceable line.
// Same shape as tests/invoice-approval-path.test.ts's local helpers.
// ---------------------------------------------------------------------------

let invoiceCounter = 0;

async function insertReviewedInvoice(organizationId: number, vendorId: number): Promise<number> {
  invoiceCounter += 1;
  const suffix = `cost-history-${invoiceCounter}`;
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
      invoiceNumber: `COST-${suffix}`,
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

/** Seeds one approved invoice with a single priced line and returns its id. */
async function approveOneInvoice(organizationId: number, vendorId: number, productId: number, rawNet: string): Promise<number> {
  const invoiceId = await insertReviewedInvoice(organizationId, vendorId);
  await insertLine(organizationId, invoiceId, {
    lineNumber: 1,
    matchedProductId: productId,
    quantity: "10.000",
    packSize: 1,
    rawNet,
  });
  const actor = organizationId === fx.organizationId ? fx.owner : fx.otherOwner;
  await approveInvoice(actor, invoiceId);
  return invoiceId;
}

// ---------------------------------------------------------------------------
// getProductCostHistory
// ---------------------------------------------------------------------------

describe("getProductCostHistory", () => {
  test("ordering + chaining: two approvals for the same product return newest-effectiveAt first, with the second row's previousUnitCost equal to the first row's unitCost", async () => {
    // 100.00 / 10 / 1 = 10.0000
    await approveOneInvoice(fx.organizationId, fx.vendorId, fx.pricedProductId, "100.00");
    // 150.00 / 10 / 1 = 15.0000
    await approveOneInvoice(fx.organizationId, fx.vendorId, fx.pricedProductId, "150.00");

    const rows = await getProductCostHistory(fx.owner, fx.pricedProductId);

    expect(rows).toHaveLength(2);
    expect(rows[0].unitCost).toBe("15.0000");
    expect(rows[1].unitCost).toBe("10.0000");
    // Newest-first order confirmed above; the newest row's previousUnitCost
    // must chain to the older row's unitCost.
    expect(rows[0].previousUnitCost).toBe(rows[1].unitCost);
  });

  test("role gating: manager and staff both get AuthzError, not an empty list — 'prohibited from asking' is not the same as 'asked and found nothing'", async () => {
    await approveOneInvoice(fx.organizationId, fx.vendorId, fx.pricedProductId, "100.00");

    await expect(getProductCostHistory(fx.manager, fx.pricedProductId)).rejects.toBeInstanceOf(AuthzError);
    await expect(getProductCostHistory(fx.staff, fx.pricedProductId)).rejects.toBeInstanceOf(AuthzError);
  });

  test("tenant isolation: a product belonging to another organization throws NotFoundError, never that organization's rows", async () => {
    await expect(getProductCostHistory(fx.owner, fx.otherProductId)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a nonexistent product id (never existed at all, not just cross-tenant) also throws NotFoundError", async () => {
    await expect(getProductCostHistory(fx.owner, 999_999_999)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("empty-but-real: a product that exists but was never on an approved invoice returns [] without throwing", async () => {
    const rows = await getProductCostHistory(fx.owner, fx.pricedProductId);
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getCostPostingsForInvoice
// ---------------------------------------------------------------------------

describe("getCostPostingsForInvoice", () => {
  test("role gating: manager and staff both get AuthzError, not an empty list", async () => {
    const invoiceId = await approveOneInvoice(fx.organizationId, fx.vendorId, fx.pricedProductId, "100.00");

    await expect(getCostPostingsForInvoice(fx.manager, invoiceId)).rejects.toBeInstanceOf(AuthzError);
    await expect(getCostPostingsForInvoice(fx.staff, invoiceId)).rejects.toBeInstanceOf(AuthzError);
  });

  test("tenant isolation: an invoice belonging to another organization throws NotFoundError, never that organization's postings", async () => {
    await expect(getCostPostingsForInvoice(fx.owner, fx.otherInvoiceId)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a nonexistent invoice id also throws NotFoundError", async () => {
    await expect(getCostPostingsForInvoice(fx.owner, 999_999_999)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("empty-but-real: an invoice with no product-type/matched lines (nothing ever posted) returns [] without throwing", async () => {
    // fx.invoiceId is the shared needs_review fixture invoice — never approved.
    const rows = await getCostPostingsForInvoice(fx.owner, fx.invoiceId);
    expect(rows).toEqual([]);
  });

  test("invoice-scoping precision: returns exactly one invoice's postings, not another invoice's postings for the same product", async () => {
    const firstInvoiceId = await approveOneInvoice(fx.organizationId, fx.vendorId, fx.pricedProductId, "100.00");
    const secondInvoiceId = await approveOneInvoice(fx.organizationId, fx.vendorId, fx.pricedProductId, "150.00");

    const firstPostings = await getCostPostingsForInvoice(fx.owner, firstInvoiceId);
    const secondPostings = await getCostPostingsForInvoice(fx.owner, secondInvoiceId);

    expect(firstPostings).toHaveLength(1);
    expect(firstPostings[0].unitCost).toBe("10.0000");
    expect(firstPostings[0].sourceInvoiceId).toBe(firstInvoiceId);

    expect(secondPostings).toHaveLength(1);
    expect(secondPostings[0].unitCost).toBe("15.0000");
    expect(secondPostings[0].sourceInvoiceId).toBe(secondInvoiceId);
  });
});
