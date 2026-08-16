/**
 * `invoice_line` reads and writes — Phase 2.5, Slices 2 and 3.
 *
 * Two write paths live here, deliberately kept apart:
 *   - `writeExtractedLines` — the extraction pipeline
 *     (`lib/domain/extraction-pipeline.ts`) replacing an invoice's draft
 *     lines wholesale with the result of its latest classify/extract/parse
 *     pass, INCLUDING whatever `lib/domain/matching.ts:matchLinesToProducts`
 *     has already resolved onto those draft lines by the time this is
 *     called (Slice 3). Runs strictly before the owning invoice reaches
 *     `needs_review`.
 *   - `applyLineReviewTx`/`submitInvoiceReview` — a human reviewer's
 *     per-line corrections on the review screen, once the invoice IS
 *     `needs_review`. Updates specific fields on specific rows; never
 *     deletes or reorders anything the pipeline wrote. As of Slice 3, a
 *     manual match here also upserts a `vendor_alias` (see
 *     `applyLineReviewTx`'s own comment) so the SAME vendor SKU arrives
 *     pre-matched on every later invoice.
 * The two are structurally incompatible (wholesale replace vs. targeted
 * update) precisely because of WHEN each runs — see `writeExtractedLines`'s
 * own comment for why that ordering is what makes the delete-then-insert
 * shape safe.
 *
 * ## Why delete-then-insert, not an upsert keyed on (invoiceId, lineNumber)
 *
 * `db/schema.ts`'s `invoice_line` comment calls `lineNumber` "the pipeline's
 * own idempotency key: reclaiming a `running` job that already wrote drafts
 * re-writes the same rows rather than duplicating them." An
 * `INSERT ... ON DUPLICATE KEY UPDATE` reading of that sentence looks
 * tempting, but it is wrong here: it only overwrites rows whose line number
 * recurs in the new attempt and silently STRANDS every row whose line number
 * doesn't. A document that parsed as 12 lines on a crashed attempt and 10 on
 * the reclaim would leave lines 11 and 12 on the invoice forever — a phantom
 * $340 bottle of tequila nobody delivered, invisible until someone notices
 * the reorder list doesn't match the shelf. Deleting the invoice's existing
 * drafts and inserting the new set atomically is the only shape that
 * self-corrects when the line count itself changes between attempts, and it
 * is safe to do because of WHEN this function runs: strictly before the
 * owning invoice reaches `needs_review` (see `processExtractionQueue`), so no
 * human has edited a matched product, confidence, or review timestamp onto
 * any row this call is about to delete. If a later slice's
 * `resendToExtractionAction` re-invokes this on an invoice that previously
 * reached `reviewed`/`rejected`, the intent is the same: the new extraction
 * is authoritative and prior matches are re-done on the new draft, not
 * silently preserved underneath it.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { invoice, invoiceLine, product } from "@/db/schema";
import type { invoiceLineTypeEnum, invoiceLineUomEnum, invoiceMatchMethodEnum } from "@/db/enums";
import type { Actor } from "@/lib/authz";
import { withLockRetry } from "@/lib/domain/db-errors";
import { NotFoundError } from "@/lib/domain/errors";
import { updateInvoiceStatusTx, type InvoiceRow } from "@/lib/domain/invoices";
import { upsertAliasTx } from "@/lib/domain/matching";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type InvoiceLineType = (typeof invoiceLineTypeEnum)[number];
export type InvoiceLineUom = (typeof invoiceLineUomEnum)[number];
export type InvoiceMatchMethod = (typeof invoiceMatchMethodEnum)[number];

/**
 * The exception badge set on a line the pipeline could not match to a
 * product — either `matchLinesToProducts` (Slice 3) found no `vendor_alias`
 * for its `vendorItemCode`, or the invoice has no `vendorId` at all. Exported
 * so `lib/domain/extraction-pipeline.ts` can apply it AFTER matching runs,
 * without duplicating the literal string in two files.
 */
export const UNMATCHED_ITEM_FLAG = "unmatched item";

/**
 * One extracted line, prior to any human review. Every money/quantity field
 * is a decimal-as-string (this file's usual precision convention — see
 * `db/schema.ts`'s header) or `null` when the extraction genuinely could not
 * determine it. `null` is never coerced to `0` or `1` here: an unreadable
 * pack size stays unreadable rather than becoming a plausible-looking guess
 * (AGENTS.md's "plausible-but-wrong default" rule applies to a parsed
 * document exactly as much as it does to a form default).
 *
 * The four `matched*`/`match*` fields start `null`/`"unmatched"` when
 * `parseLinesFromVision` builds a line, and are the ONLY fields
 * `lib/domain/matching.ts:matchLinesToProducts` is allowed to mutate — see
 * that function's own comment. Nothing else in the extraction pipeline
 * writes to them.
 */
export interface DraftInvoiceLine {
  lineNumber: number;
  rawText: string | null;
  lineType: InvoiceLineType;
  vendorItemCode: string | null;
  description: string | null;
  packDescription: string | null;
  quantity: string | null;
  uom: InvoiceLineUom | null;
  packSize: number | null;
  unitCost: string | null;
  extendedCost: string | null;
  rawGross: string | null;
  rawDiscount: string | null;
  rawNet: string | null;
  exceptionFlags: string[] | null;
  extractionConfidence: string | null;
  matchedProductId: number | null;
  matchedVendorAliasId: number | null;
  matchMethod: InvoiceMatchMethod;
  matchConfidence: string | null;
}

/**
 * Replaces every `invoice_line` row belonging to `invoiceId` with `lines`,
 * inside the caller-supplied transaction.
 *
 * Ownership-checks `invoiceId` against `actor.organizationId` before writing
 * anything [invariant 9] — the caller (the extraction pipeline) resolves
 * `invoiceId` from its own claimed job row, not from client input, but this
 * function's own contract is "never write a row whose (organizationId,
 * invoiceId) it hasn't itself verified," the same discipline every other
 * domain function in this codebase holds even when its caller looks trusted.
 *
 * `matchedProductId`/`matchedVendorAliasId`/`matchMethod`/`matchConfidence`
 * are written exactly as they arrive on `lines` — by the time this function
 * runs, `lib/domain/extraction-pipeline.ts:runClaimedJob` has already called
 * `matchLinesToProducts` (Slice 3) on the same array, so a line that matched
 * a `vendor_alias` carries its resolved `matchedProductId` here; a line that
 * didn't still carries the `"unmatched"` default its constructor set. This
 * function itself does no matching — it persists whatever the caller already
 * resolved. A human correcting a match afterward via the review screen is a
 * SEPARATE write path, `applyLineReviewTx` below.
 *
 * Writes nothing and returns `0` for an empty `lines` array — a document
 * pdf-inspector or Claude Vision genuinely could not find any lines on
 * (blank page, cover sheet) still needs its OLD drafts cleared, which the
 * delete half of this function does unconditionally.
 */
export async function writeExtractedLines(
  tx: Tx,
  actor: Actor,
  invoiceId: number,
  lines: DraftInvoiceLine[],
): Promise<number> {
  const [owned] = await tx
    .select({ id: invoice.id })
    .from(invoice)
    .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)))
    .limit(1);
  if (!owned) {
    throw new NotFoundError("Invoice");
  }

  await tx
    .delete(invoiceLine)
    .where(and(eq(invoiceLine.invoiceId, invoiceId), eq(invoiceLine.organizationId, actor.organizationId)));

  if (lines.length === 0) {
    return 0;
  }

  await tx.insert(invoiceLine).values(
    lines.map((line) => ({
      organizationId: actor.organizationId,
      invoiceId,
      lineNumber: line.lineNumber,
      rawText: line.rawText,
      lineType: line.lineType,
      vendorItemCode: line.vendorItemCode,
      description: line.description,
      packDescription: line.packDescription,
      quantity: line.quantity,
      uom: line.uom,
      packSize: line.packSize,
      unitCost: line.unitCost,
      extendedCost: line.extendedCost,
      rawGross: line.rawGross,
      rawDiscount: line.rawDiscount,
      rawNet: line.rawNet,
      exceptionFlags: line.exceptionFlags,
      extractionConfidence: line.extractionConfidence,
      matchedProductId: line.matchedProductId,
      matchedVendorAliasId: line.matchedVendorAliasId,
      matchMethod: line.matchMethod,
      matchConfidence: line.matchConfidence,
    })),
  );

  return lines.length;
}

// ---------------------------------------------------------------------------
// Reads — owner-only (AR-7: every column here is supplier cost data), scoped
// and ownership-checked per invariant 9.
// ---------------------------------------------------------------------------

/** One line, as the review screen renders it — every field the pipeline or a reviewer can write. */
export interface InvoiceLineRow {
  id: number;
  organizationId: number;
  invoiceId: number;
  lineNumber: number;
  rawText: string | null;
  lineType: InvoiceLineType;
  vendorItemCode: string | null;
  description: string | null;
  packDescription: string | null;
  quantity: string | null;
  uom: InvoiceLineUom | null;
  packSize: number | null;
  unitCost: string | null;
  extendedCost: string | null;
  rawGross: string | null;
  rawDiscount: string | null;
  rawNet: string | null;
  exceptionFlags: string[] | null;
  matchedProductId: number | null;
  matchMethod: InvoiceMatchMethod;
  matchConfidence: string | null;
  extractionConfidence: string | null;
  reviewedBy: number | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toInvoiceLineRow(row: typeof invoiceLine.$inferSelect): InvoiceLineRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    invoiceId: row.invoiceId,
    lineNumber: row.lineNumber,
    rawText: row.rawText,
    lineType: row.lineType,
    vendorItemCode: row.vendorItemCode,
    description: row.description,
    packDescription: row.packDescription,
    quantity: row.quantity,
    uom: row.uom,
    packSize: row.packSize,
    unitCost: row.unitCost,
    extendedCost: row.extendedCost,
    rawGross: row.rawGross,
    rawDiscount: row.rawDiscount,
    rawNet: row.rawNet,
    exceptionFlags: row.exceptionFlags ?? null,
    matchedProductId: row.matchedProductId,
    matchMethod: row.matchMethod,
    matchConfidence: row.matchConfidence,
    extractionConfidence: row.extractionConfidence,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Every line on one invoice, in document order (`line_number` ascending —
 * the pipeline's own renumbering, see `parseLinesFromVision`'s comment).
 * Ownership-checked against `actor.organizationId` before anything is read
 * [invariant 9]: a cross-tenant `invoiceId` raises `NotFoundError`, the same
 * shape `getInvoice` uses, rather than an empty array — an empty array would
 * be indistinguishable from "your own invoice with zero lines," which is a
 * real state (see `writeExtractedLines`'s own comment on a blank document).
 */
export async function getLinesForInvoice(actor: Actor, invoiceId: number): Promise<InvoiceLineRow[]> {
  const [owned] = await db
    .select({ id: invoice.id })
    .from(invoice)
    .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)))
    .limit(1);
  if (!owned) {
    throw new NotFoundError("Invoice");
  }

  const rows = await db
    .select()
    .from(invoiceLine)
    .where(and(eq(invoiceLine.invoiceId, invoiceId), eq(invoiceLine.organizationId, actor.organizationId)))
    .orderBy(asc(invoiceLine.lineNumber));
  return rows.map(toInvoiceLineRow);
}

// ---------------------------------------------------------------------------
// Review — a human's per-line corrections on the `needs_review` screen.
// ---------------------------------------------------------------------------

/**
 * One line's reviewer correction. Every field but `id` is OPTIONAL —
 * `undefined` means "leave this column alone," which lets a reviewer
 * resubmit only the lines they actually touched rather than every line on
 * the invoice. `matchedProductId: null` is a real, distinct value from
 * `undefined`: it explicitly clears an existing match (a reviewer undoing a
 * mis-match), where `undefined` leaves whatever match already exists.
 *
 * `matchMethod` and `exceptionFlags`' "unmatched item" badge are
 * deliberately NOT accepted here — both are DERIVED from `matchedProductId`
 * by `applyLineReviewTx` below, never trusted from the client. `matchMethod`
 * is a closed set whose values (`vendor_alias_code`, `barcode`, `fuzzy`, …)
 * describe HOW a match was made; the only method a human review action can
 * ever legitimately produce is `manual` (or `unmatched`, clearing it), so
 * accepting an arbitrary client-supplied value would let a request claim an
 * automatic-matching provenance it never earned.
 */
export interface LineCorrection {
  id: number;
  rawGross?: string | null;
  rawDiscount?: string | null;
  rawNet?: string | null;
  matchedProductId?: number | null;
}

/**
 * Applies `corrections` to `invoiceId`'s lines, inside the caller-supplied
 * transaction. The composable half of the review write path — see
 * `applyLineReview` (opens its own transaction, for standalone/unit use) and
 * `submitInvoiceReview` (composes this with the invoice's own CAS
 * atomically, which is what `reviewInvoiceAction` actually calls).
 *
 * Three ownership checks, in order, before any row is written:
 *   1. `invoiceId` belongs to `actor.organizationId`.
 *   2. Every submitted line `id` belongs to THAT invoice AND that
 *      organization — checked as one batched `SELECT`, not per-line. A
 *      crafted line id from a different invoice (even the caller's own
 *      other invoice) or a different tenant is refused before anything is
 *      touched; a foreign key on `invoice_line.invoice_id` would prove the
 *      row exists, not that this invoice review is allowed to touch it.
 *   3. [AR-2] Every submitted `matchedProductId` belongs to
 *      `actor.organizationId` — ALSO one batched `SELECT`, before any row is
 *      written. This is the check `db/schema.ts`'s `invoiceLine.matchedProductId`
 *      comment names explicitly: the column has no app-level FK-implied
 *      trust because a human picks it from a client request.
 *
 * `reviewedBy`/`reviewedAt` are stamped on every corrected line from `actor`
 * and `now()` — never accepted from the caller, the same discipline
 * `count_line`'s audit columns hold.
 *
 * ## Slice 3 — a manual match also teaches the alias table
 *
 * When a correction sets a REAL `matchedProductId` (not a clear-to-null) on
 * a line that has a `vendorItemCode`, this function also upserts a
 * `vendor_alias` for `(actor.organizationId, ownedInvoice.vendorId,
 * line.vendorItemCode) -> matchedProductId` via
 * `lib/domain/matching.ts:upsertAliasTx`, inside this SAME transaction — see
 * that function's own comment for why it must not open a second one. Two
 * cases deliberately do NOT create or touch an alias, and neither is an
 * error:
 *   - `line.vendorItemCode == null` — nothing to key an alias on; some
 *     vendors' invoices genuinely never print an item code.
 *   - `ownedInvoice.vendorId == null` — the upload has no vendor recorded at
 *     all (`vendor_alias.vendorId` is `NOT NULL` with a composite tenant FK
 *     to `vendor`, so there is no null-vendor row this could even become).
 * A clear-to-null correction (`matchedProductId: null`) never touches the
 * alias table either — undoing a mismatch on ONE invoice's line is not
 * evidence the vendor's mapping itself was wrong, and silently deleting a
 * `vendor_alias` that other invoices' lines still reference through
 * `matchedVendorAliasId` (ON DELETE SET NULL) would erase their match
 * history along with it.
 *
 * `matchedVendorAliasId` on the corrected LINE itself is deliberately left
 * untouched here — `db/schema.ts`'s own comment on that column names
 * `matchLinesToProducts` as its only legitimate setter (an automatic match,
 * not a human's manual one), and this function sets `matchMethod: "manual"`
 * on this same line a few lines below, which already records how this
 * particular line got its match.
 */
export async function applyLineReviewTx(
  tx: Tx,
  actor: Actor,
  invoiceId: number,
  corrections: LineCorrection[],
): Promise<void> {
  if (corrections.length === 0) {
    return;
  }

  const [ownedInvoice] = await tx
    .select({ id: invoice.id, vendorId: invoice.vendorId })
    .from(invoice)
    .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)))
    .limit(1);
  if (!ownedInvoice) {
    throw new NotFoundError("Invoice");
  }

  const uniqueLineIds = Array.from(new Set(corrections.map((c) => c.id)));
  const ownedLines = await tx
    .select()
    .from(invoiceLine)
    .where(
      and(
        eq(invoiceLine.organizationId, actor.organizationId),
        eq(invoiceLine.invoiceId, invoiceId),
        inArray(invoiceLine.id, uniqueLineIds),
      ),
    );
  if (ownedLines.length !== uniqueLineIds.length) {
    // At least one submitted line id isn't this invoice's own — never
    // distinguish "belongs to someone else" from "doesn't exist" (invariant 9).
    throw new NotFoundError("Invoice line");
  }
  const ownedLinesById = new Map(ownedLines.map((row) => [row.id, row]));

  const uniqueProductIds = Array.from(
    new Set(corrections.map((c) => c.matchedProductId).filter((id): id is number => id != null)),
  );
  if (uniqueProductIds.length > 0) {
    const ownedProducts = await tx
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.organizationId, actor.organizationId), inArray(product.id, uniqueProductIds)));
    if (ownedProducts.length !== uniqueProductIds.length) {
      throw new NotFoundError("Product");
    }
  }

  const now = new Date();
  for (const correction of corrections) {
    const current = ownedLinesById.get(correction.id)!;
    const setValues: Partial<typeof invoiceLine.$inferInsert> = {
      reviewedBy: actor.userId,
      reviewedAt: now,
    };
    if (correction.rawGross !== undefined) setValues.rawGross = correction.rawGross;
    if (correction.rawDiscount !== undefined) setValues.rawDiscount = correction.rawDiscount;
    if (correction.rawNet !== undefined) setValues.rawNet = correction.rawNet;

    if (correction.matchedProductId !== undefined) {
      setValues.matchedProductId = correction.matchedProductId;
      setValues.matchMethod = correction.matchedProductId == null ? "unmatched" : "manual";
      // Derived, not client-supplied (see LineCorrection's comment): matching
      // a product clears the "unmatched item" badge; explicitly clearing a
      // match puts it back, since the line is unmatched again.
      const currentFlags = current.exceptionFlags ?? [];
      setValues.exceptionFlags =
        correction.matchedProductId == null
          ? currentFlags.includes(UNMATCHED_ITEM_FLAG)
            ? currentFlags
            : [...currentFlags, UNMATCHED_ITEM_FLAG]
          : currentFlags.filter((flag) => flag !== UNMATCHED_ITEM_FLAG);

      // Slice 3: teach the alias table from this human's manual match — see
      // this function's own comment for the two cases that deliberately
      // don't (no vendorItemCode on the line; no vendorId on the invoice)
      // and why a clear-to-null never reaches here at all.
      if (correction.matchedProductId != null && ownedInvoice.vendorId != null && current.vendorItemCode != null) {
        await upsertAliasTx(
          tx,
          actor.organizationId,
          ownedInvoice.vendorId,
          current.vendorItemCode,
          correction.matchedProductId,
        );
      }
    }

    await tx
      .update(invoiceLine)
      .set(setValues)
      .where(
        and(
          eq(invoiceLine.id, correction.id),
          eq(invoiceLine.organizationId, actor.organizationId),
          eq(invoiceLine.invoiceId, invoiceId),
        ),
      );
  }
}

/** `applyLineReviewTx`, opening its own transaction — for standalone/unit use. */
export async function applyLineReview(
  actor: Actor,
  invoiceId: number,
  corrections: LineCorrection[],
): Promise<void> {
  await db.transaction((tx) => applyLineReviewTx(tx, actor, invoiceId, corrections));
}

/**
 * The review screen's actual submit: applies the reviewer's line
 * corrections AND CAS's the invoice `needs_review -> reviewed`, in ONE
 * transaction. If the CAS finds the invoice has moved on — rejected or
 * reviewed by someone else since this reviewer loaded the screen —
 * `updateInvoiceStatusTx` raises `ConflictError`, and the whole transaction
 * rolls back: the line corrections are undone along with it, rather than
 * left applied against an invoice that never actually reached `reviewed`
 * (04-slices.md's `review_conflicts_when_status_moved`).
 *
 * `withLockRetry` (see db-errors.ts): a manual match inside
 * `applyLineReviewTx` calls `lib/domain/matching.ts:upsertAliasTx`, whose
 * duplicate-key recovery branch takes a `SELECT ... FOR UPDATE` on the
 * existing `vendor_alias` row — so two reviewers submitting corrections that
 * both map the SAME `(organizationId, vendorId, vendorItemCode)` at once can
 * have InnoDB pick one as a deadlock victim (1213). That can only be fixed
 * HERE, at the outer transaction, not inside `upsertAliasTx`/`upsertAliasCore`
 * itself: those run mid-transaction, sharing this call's `tx`, and a deadlock
 * rolls the WHOLE transaction back — including the CAS below — so only
 * re-running the whole thing (not just the alias write) recovers. Same
 * reasoning `lib/domain/counts.ts` already applies at its own
 * `db.transaction(...)` call sites.
 */
export async function submitInvoiceReview(
  actor: Actor,
  invoiceId: number,
  corrections: LineCorrection[],
): Promise<InvoiceRow> {
  return withLockRetry(() =>
    db.transaction(async (tx) => {
      await applyLineReviewTx(tx, actor, invoiceId, corrections);
      return updateInvoiceStatusTx(tx, actor, invoiceId, "needs_review", "reviewed");
    }),
  );
}
