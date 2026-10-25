/**
 * Invoice cost-history / cost-posting reads. Phase 2.5 backend follow-on
 * (docs/plans/phase-2.5-backend-followons/03-program-design.md, Part B) —
 * the write path (`approveInvoice`, lib/domain/invoice-approval.ts) is
 * already correct and out of scope here. This file is read-only against
 * `product_cost_history`, whose own schema comment (db/schema.ts) already
 * anticipates exactly this read ("a future cost-history screen").
 *
 * Cost gating (CLAUDE.md invariant 8): every row here IS cost data — there is
 * no partial projection that hides `unitCost`/`previousUnitCost` while
 * showing the rest, so the `canSeeCost` check gates the whole function, not a
 * column subset (contrast lib/domain/catalog.ts, where cost is one column
 * among many non-cost ones).
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { product, productCostHistory } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import { canSeeCost, AuthzError } from "@/lib/authz";
import { NotFoundError } from "@/lib/domain/errors";
import { getInvoice } from "@/lib/domain/invoices";

export interface CostHistoryRow {
  id: number;
  productId: number;
  sourceInvoiceId: number;
  sourceInvoiceLineId: number;
  /** DECIMAL(10,4) as string — this codebase's existing money convention. */
  unitCost: string;
  previousUnitCost: string | null;
  effectiveAt: Date;
  createdBy: number;
}

function toCostHistoryRow(row: typeof productCostHistory.$inferSelect): CostHistoryRow {
  return {
    id: row.id,
    productId: row.productId,
    sourceInvoiceId: row.sourceInvoiceId,
    sourceInvoiceLineId: row.sourceInvoiceLineId,
    unitCost: row.unitCost,
    previousUnitCost: row.previousUnitCost,
    effectiveAt: row.effectiveAt,
    createdBy: row.createdBy,
  };
}

/**
 * Ownership + existence in one check (invariant 9: a foreign key proves a
 * row exists, not whose it is). Mirrors `assertVendorOwned`
 * (lib/domain/invoices.ts) minus the `Tx` parameter — this is a read-only
 * path, no transaction is needed.
 */
async function assertProductOwned(organizationId: number, productId: number): Promise<void> {
  const [owned] = await db
    .select({ id: product.id })
    .from(product)
    .where(and(eq(product.id, productId), eq(product.organizationId, organizationId)))
    .limit(1);
  if (!owned) {
    throw new NotFoundError("Product");
  }
}

/**
 * One product's full cost history, newest first. A product that exists but
 * was never on an approved invoice returns `[]` — that is a real, correct
 * answer, not an error.
 */
export async function getProductCostHistory(actor: Actor, productId: number): Promise<CostHistoryRow[]> {
  // Role check first, before any query — a caller who can't see cost data
  // gets refused before a query result could leak even a row-existence
  // signal (deliberate ordering, 03-program-design.md's "Least confident
  // decisions" #3).
  if (!canSeeCost(actor.role)) {
    throw new AuthzError(403, "You do not have permission to view cost data.");
  }
  await assertProductOwned(actor.organizationId, productId);

  const rows = await db
    .select()
    .from(productCostHistory)
    .where(and(eq(productCostHistory.organizationId, actor.organizationId), eq(productCostHistory.productId, productId)))
    // `effective_at` is a TIMESTAMP with no fractional-seconds precision, so
    // two approvals inside the same second tie on it — `id DESC` breaks the
    // tie deterministically in true insertion order (same pattern already
    // used by lib/domain/extraction.ts). Without this, "newest first" would
    // only hold between approvals a full second apart.
    .orderBy(desc(productCostHistory.effectiveAt), desc(productCostHistory.id));

  return rows.map(toCostHistoryRow);
}

/**
 * The cost postings a single approved invoice produced, newest first. An
 * invoice with no product-type/matched lines (nothing ever posted) returns
 * `[]`, not an error.
 */
export async function getCostPostingsForInvoice(actor: Actor, invoiceId: number): Promise<CostHistoryRow[]> {
  if (!canSeeCost(actor.role)) {
    throw new AuthzError(403, "You do not have permission to view cost data.");
  }
  // Reused purely for its ownership assertion — `getInvoice` throws
  // NotFoundError("Invoice") on a cross-tenant or nonexistent id; the row it
  // returns is discarded. Deliberate reuse over a narrower duplicate helper
  // (03-program-design.md's "Least confident decisions" #1), for consistency
  // with every other invoice-scoped read in this codebase.
  await getInvoice(actor, invoiceId);

  const rows = await db
    .select()
    .from(productCostHistory)
    .where(and(eq(productCostHistory.organizationId, actor.organizationId), eq(productCostHistory.sourceInvoiceId, invoiceId)))
    // Same same-second tiebreak reasoning as getProductCostHistory above.
    .orderBy(desc(productCostHistory.effectiveAt), desc(productCostHistory.id));

  return rows.map(toCostHistoryRow);
}
