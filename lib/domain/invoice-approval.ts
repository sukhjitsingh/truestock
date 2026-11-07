/**
 * Invoice approval — Phase 2.5, Slice 4 ("Cost Flow + Alerts",
 * `docs/plans/phase-2.5-invoice-automation/04-slices.md`). The owner's
 * `reviewed -> approved` action: derives a unit cost for every matched
 * product line, snapshots it onto `product_cost_history`, and writes it
 * forward onto `product.current_unit_cost` — the write that finally makes
 * the valuation and reorder list (Phase 3) real instead of `null`.
 *
 * ## One transaction, wrapped in `withLockRetry`
 *
 * Everything below — the status CAS, the `product` row locks, the
 * `product_cost_history` inserts, and the `product.current_unit_cost`
 * updates — runs inside ONE `db.transaction`, matching
 * `lib/domain/invoice-lines.ts:submitInvoiceReview`'s own "CAS plus
 * dependent writes must roll back together" shape. A failure partway through
 * the per-line loop (a cross-tenant `matchedProductId` slipping past the
 * review-time check, say) must leave the invoice at `reviewed` and every
 * product/cost-history row untouched — not half-applied.
 *
 * `withLockRetry` (see `lib/domain/db-errors.ts`) because this transaction
 * takes `SELECT ... FOR UPDATE` locks on both the `invoice` row and every
 * matched `product` row it processes — the same lock shape that has already
 * produced real 1213/1205/1020 races elsewhere in this codebase
 * (`submitInvoiceReview`'s own comment). Retrying the whole transaction is
 * safe for the same reason it is there: InnoDB rolls a deadlock victim back
 * completely, so nothing this callback did persisted, and a retry starts
 * from the state the first attempt saw.
 *
 * ## The CAS's replay/concurrency shape — NOT `updateInvoiceStatusTx`
 *
 * `lib/domain/invoices.ts:updateInvoiceStatusTx` is the precedent this is
 * modeled on (same `SELECT ... FOR UPDATE` -> branch -> `UPDATE` shape), but
 * it is not called directly here: its CAS treats ANY status mismatch —
 * including "already approved" — as a `ConflictError`. 04-slices.md's Slice
 * 4 contract is narrower and different on purpose: "Zero rows affected means
 * it was already approved — return the original success, not an error. This
 * CAS is the concurrency gate; everything below only runs if it won." So
 * this function does its own `SELECT ... FOR UPDATE` + branch:
 *   - `row.status === "approved"` -> return the CURRENT row as success,
 *     `costLinesApplied: 0`, and do NOT touch `approvedAt`/`approvedBy` or
 *     re-enter the cost-writing loop. This is what makes BOTH a sequential
 *     replay (the same invoice approved twice) AND the concurrent case (two
 *     `approveInvoice` calls racing on the same invoice — the loser's
 *     `FOR UPDATE` blocks until the winner commits, then observes
 *     `approved`) apply costs exactly once.
 *   - `row.status !== "reviewed"` (anything else: `needs_review`,
 *     `uploaded`, `processing`, `rejected`) -> `InvalidInvoiceTransitionError`
 *     — not a legal edge to `approved` (`INVOICE_TRANSITIONS`,
 *     `lib/domain/invoices.ts`).
 *   - `row.status === "reviewed"` -> this call wins the CAS: stamp
 *     `status: "approved"`, `approvedAt: now()`, `approvedBy: actor.userId`,
 *     then run the cost-writing loop below.
 *
 * ## Per-line cost writes
 *
 * Every line is classified by `classifyLineForPosting`
 * (lib/domain/cost-derivation.ts). Lines that post get the writes below;
 * the rest are skipped without failing approval and are named, with a reason,
 * in the returned `report`. Processed in `line_number` order (deterministic,
 * and what lets a test induce "the failure is on line 3 of 5").
 *
 * For each such line:
 *   1. The classifier's verdict — a line that cannot be confidently priced
 *      is SKIPPED, never defaulted to any number.
 *   2. [AR-2] `SELECT current_unit_cost ... FOR UPDATE` on
 *      `product` scoped to `(id = matchedProductId, organizationId =
 *      actor.organizationId)` — INSIDE this transaction, not before it
 *      opened. Two purposes at once:
 *        - The tenant-ownership check itself. `invoice_line.matched_product_id`
 *          (db/schema.ts) is a BARE single-column FK, not composite — by
 *          design, since it is human-supplied on the review screen and
 *          `applyLineReviewTx` batch-checks it there [AR-2]. This function
 *          does not trust that earlier check to still hold: a row not found
 *          for THIS organization raises `NotFoundError` and rolls back the
 *          WHOLE transaction, so a cross-tenant id that somehow reached this
 *          column (bypassing the review-time check — the exact scenario
 *          `review_rejects_cross_tenant_product` drives) writes nothing to
 *          the other tenant's product, even if earlier lines in the SAME
 *          loop already looked like they'd succeed.
 *        - Reading `previous_unit_cost` under the SAME lock the eventual
 *          `UPDATE` uses, so two invoices approved for the same product
 *          close together can never both read the SAME stale "previous"
 *          value — the second approval's `FOR UPDATE` blocks until the
 *          first's transaction commits, then reads the value the first one
 *          just wrote (`previous_unit_cost_chains`: A->B, then B->C, never
 *          two jumps from the same baseline).
 *   3. `INSERT INTO product_cost_history` — append-only, `UNIQUE
 *      (source_invoice_line_id)` is a backstop against a bug in the CAS
 *      above re-entering this loop on a replay (this file's own header, and
 *      db/schema.ts's table comment) — the CAS itself is the PRIMARY
 *      idempotency mechanism.
 *   4. `UPDATE product SET current_unit_cost = :unitCost WHERE id =
 *      :matchedProductId AND organization_id = actor.organizationId` — the
 *      real column name (`current_unit_cost`, never `unit_cost`, which does
 *      not exist on this schema), tenant-scoped in its own `WHERE` too, not
 *      just via the lock read above.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { invoice, invoiceLine, product, productCostHistory } from "@/db/schema";
import { AuthzError, canSeeCost, type Actor } from "@/lib/authz";
import { withLockRetry } from "@/lib/domain/db-errors";
import {
  classifyLineForPosting,
  type PostingSkipReason,
} from "@/lib/domain/cost-derivation";
import { InvalidInvoiceTransitionError, NotFoundError } from "@/lib/domain/errors";
import {
  assertInvoiceHasLinesTx,
  toInvoiceRow,
  type InvoiceRow,
  type InvoiceStatus,
} from "@/lib/domain/invoices";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ApproveInvoiceResult {
  invoice: InvoiceRow;
  /**
   * How many lines actually got a new `product_cost_history` row THIS call.
   * `0` on a replay/concurrent-loser short-circuit (the CAS didn't win) —
   * distinct from "0 because this invoice genuinely has no priceable lines,"
   * which also returns `0` here; callers that need to tell the two apart
   * should compare `invoice.approvedAt`/`approvedBy` against what they
   * expected, not rely on this count alone.
   */
  costLinesApplied: number;
  /** True numbers on a replay too: built from the rows that exist. */
  report: PostingReport;
}

export async function approveInvoice(actor: Actor, invoiceId: number): Promise<ApproveInvoiceResult> {
  return withLockRetry(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(invoice)
        .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)))
        .for("update");
      if (!row) {
        throw new NotFoundError("Invoice");
      }

      if (row.status === "approved") {
        // Replay, or the losing side of a concurrent race that unblocked
        // after the winner committed — see this file's header. The original
        // success, not an error, and no re-entry into the cost-writing loop.
        const report = await buildPostingReportTx(tx, actor, invoiceId, "approved");
        return { invoice: toInvoiceRow(row), costLinesApplied: 0, report };
      }
      if (row.status !== "reviewed") {
        throw new InvalidInvoiceTransitionError(
          `Invoice ${invoiceId} must be reviewed to move to approved, but it is ${row.status}.`,
        );
      }

      // F8: refuse a zero-line invoice (a failed extraction). After the replay
      // and status checks above so an already-approved invoice still replays
      // its original success; inside this transaction so nothing is written.
      await assertInvoiceHasLinesTx(tx, actor, invoiceId);

      const now = new Date();
      await tx
        .update(invoice)
        .set({ status: "approved", approvedAt: now, approvedBy: actor.userId })
        .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)));

      const invoiceLines = await tx
        .select({
          id: invoiceLine.id,
          lineType: invoiceLine.lineType,
          uom: invoiceLine.uom,
          quantity: invoiceLine.quantity,
          packSize: invoiceLine.packSize,
          rawNet: invoiceLine.rawNet,
          matchedProductId: invoiceLine.matchedProductId,
        })
        .from(invoiceLine)
        .where(and(eq(invoiceLine.organizationId, actor.organizationId), eq(invoiceLine.invoiceId, invoiceId)))
        .orderBy(asc(invoiceLine.lineNumber));

      let applied = 0;
      for (const line of invoiceLines) {
        // Every line is classified; a line that does not post is skipped
        // without failing the approval, and the report says why.
        const verdict = classifyLineForPosting(line);
        if (!verdict.posts) {
          continue;
        }
        const unitCost = verdict.unitCost;
        // A posting verdict implies a matched product.
        const matchedProductId = line.matchedProductId as number;

        // [AR-2] Ownership-checked here, INSIDE this transaction, regardless
        // of whatever `applyLineReviewTx` already verified at review time —
        // see this file's header. `FOR UPDATE` also fixes the exact instant
        // `previous_unit_cost` is read (AR-5's `previous_unit_cost_chains`).
        const [productRow] = await tx
          .select({ id: product.id, currentUnitCost: product.currentUnitCost })
          .from(product)
          .where(and(eq(product.id, matchedProductId), eq(product.organizationId, actor.organizationId)))
          .for("update");
        if (!productRow) {
          // Never distinguish "doesn't exist" from "belongs to someone
          // else" (invariant 9). Throwing here rolls back the WHOLE
          // transaction — including any product_cost_history rows this same
          // loop already inserted for earlier lines this call — so a
          // mid-loop failure never leaves a partially-applied approval.
          throw new NotFoundError("Product");
        }

        await tx.insert(productCostHistory).values({
          organizationId: actor.organizationId,
          productId: matchedProductId,
          sourceInvoiceId: invoiceId,
          sourceInvoiceLineId: line.id,
          unitCost,
          previousUnitCost: productRow.currentUnitCost,
          createdBy: actor.userId,
        });

        await tx
          .update(product)
          .set({ currentUnitCost: unitCost })
          .where(and(eq(product.id, matchedProductId), eq(product.organizationId, actor.organizationId)));

        applied += 1;
      }

      const [updated] = await tx
        .select()
        .from(invoice)
        .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)))
        .limit(1);
      if (!updated) {
        throw new NotFoundError("Invoice");
      }

      const report = await buildPostingReportTx(tx, actor, invoiceId, "approved");
      return { invoice: toInvoiceRow(updated), costLinesApplied: applied, report };
    }),
  );
}

export interface PostingReportLine {
  lineId: number;
  lineNumber: number;
  description: string | null;
  productId: number | null;
  productName: string | null;
  posted: boolean;
  unitCost: string | null;
  /** Null when posted. `not_posted_at_approval`: see Gate 3, least confident #4. */
  reason: PostingSkipReason | "not_posted_at_approval" | null;
}

export interface PostingReport {
  /** True only once approved: `posted` then means rows that exist. */
  final: boolean;
  totalLines: number;
  postedLines: number;
  lines: PostingReportLine[];
}

/**
 * Which lines of one invoice post a cost (or did). Owner only, since it carries
 * unit costs (invariant 8); the invoice is looked up inside the caller's
 * organization, so another tenant's id is NotFound (invariant 9).
 */
export async function getInvoicePostingReport(actor: Actor, invoiceId: number): Promise<PostingReport> {
  if (!canSeeCost(actor.role)) {
    throw new AuthzError(403, "You do not have permission to view cost data.");
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: invoice.status })
      .from(invoice)
      .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)));
    if (!row) {
      throw new NotFoundError("Invoice");
    }
    return buildPostingReportTx(tx, actor, invoiceId, row.status);
  });
}

// Before approval `posted` is the classifier's prediction. Once approved
// (`final`), `posted` means a product_cost_history row exists for the line and
// unitCost comes from that row, never from re-deriving. The caller has already
// ownership-checked the invoice.
async function buildPostingReportTx(
  tx: Tx,
  actor: Actor,
  invoiceId: number,
  status: InvoiceStatus,
): Promise<PostingReport> {
  const final = status === "approved";
  const rows = await tx
    .select({
      id: invoiceLine.id,
      lineNumber: invoiceLine.lineNumber,
      description: invoiceLine.description,
      lineType: invoiceLine.lineType,
      uom: invoiceLine.uom,
      quantity: invoiceLine.quantity,
      packSize: invoiceLine.packSize,
      rawNet: invoiceLine.rawNet,
      matchedProductId: invoiceLine.matchedProductId,
      productName: product.name,
    })
    .from(invoiceLine)
    .leftJoin(
      product,
      and(eq(product.id, invoiceLine.matchedProductId), eq(product.organizationId, actor.organizationId)),
    )
    .where(and(eq(invoiceLine.organizationId, actor.organizationId), eq(invoiceLine.invoiceId, invoiceId)))
    .orderBy(asc(invoiceLine.lineNumber));

  const written = new Map<number, string>();
  if (final) {
    const history = await tx
      .select({ lineId: productCostHistory.sourceInvoiceLineId, unitCost: productCostHistory.unitCost })
      .from(productCostHistory)
      .where(
        and(
          eq(productCostHistory.organizationId, actor.organizationId),
          eq(productCostHistory.sourceInvoiceId, invoiceId),
        ),
      );
    for (const h of history) {
      if (h.lineId != null) written.set(h.lineId, h.unitCost);
    }
  }

  const lines: PostingReportLine[] = rows.map((r) => {
    const verdict = classifyLineForPosting(r);
    const base = {
      lineId: r.id,
      lineNumber: r.lineNumber,
      description: r.description,
      productId: r.matchedProductId,
      productName: r.productName,
    };
    if (!final) {
      return verdict.posts
        ? { ...base, posted: true, unitCost: verdict.unitCost, reason: null }
        : { ...base, posted: false, unitCost: null, reason: verdict.reason };
    }
    const cost = written.get(r.id);
    if (cost !== undefined) return { ...base, posted: true, unitCost: cost, reason: null };
    return {
      ...base,
      posted: false,
      unitCost: null,
      reason: verdict.posts ? ("not_posted_at_approval" as const) : verdict.reason,
    };
  });

  return {
    final,
    totalLines: lines.length,
    postedLines: lines.filter((l) => l.posted).length,
    lines,
  };
}
