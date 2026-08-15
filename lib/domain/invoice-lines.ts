/**
 * `invoice_line` writes — Phase 2.5, Slice 2 (extraction drafts).
 *
 * This module owns exactly one write path: the extraction pipeline
 * (`lib/domain/extraction-pipeline.ts`) replacing an invoice's draft lines
 * with the result of its latest classify/extract/parse pass. It does NOT
 * (yet) own reads or the review screen's per-line edits — those belong to a
 * later slice's `reviewInvoiceAction`, which needs its own ownership-checked
 * read/update helpers this file deliberately leaves room for.
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
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { invoice, invoiceLine } from "@/db/schema";
import type { invoiceLineTypeEnum, invoiceLineUomEnum } from "@/db/enums";
import type { Actor } from "@/lib/authz";
import { NotFoundError } from "@/lib/domain/errors";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type InvoiceLineType = (typeof invoiceLineTypeEnum)[number];
export type InvoiceLineUom = (typeof invoiceLineUomEnum)[number];

/**
 * One extracted line, prior to any human review. Every money/quantity field
 * is a decimal-as-string (this file's usual precision convention — see
 * `db/schema.ts`'s header) or `null` when the extraction genuinely could not
 * determine it. `null` is never coerced to `0` or `1` here: an unreadable
 * pack size stays unreadable rather than becoming a plausible-looking guess
 * (AGENTS.md's "plausible-but-wrong default" rule applies to a parsed
 * document exactly as much as it does to a form default).
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
 * `matchMethod` is left unset on every row so it takes the column's own
 * `default('unmatched')` — this slice never sets anything else; a human
 * setting `matchedProductId`/`matchMethod` via the review screen is later
 * slices' `reviewInvoiceAction`, not this pipeline.
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
    })),
  );

  return lines.length;
}
