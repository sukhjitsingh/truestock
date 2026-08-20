"use server";

/**
 * Invoice server actions — Phase 2.5, Slice 1 (upload + archive tracer
 * bullet), Slice 2 (extraction review), and Slice 4 (approve / cost flow).
 * Every export checks session + role itself (CLAUDE.md invariant 7) via
 * lib/authz.ts, never relying on middleware. All writes run through
 * lib/domain/invoices.ts, lib/domain/invoice-lines.ts, and (for approval)
 * lib/domain/invoice-approval.ts, which own the upload/confirm handshake
 * [AR-6], the tenant-ownership checks [AR-2], and the two-query
 * owner/manager split [AR-7].
 *
 * Upload and confirm are owner + manager, never staff — invoices are not a
 * staff concern (spec §4: staff is count-only). Everything else here —
 * reading a single invoice's full (unredacted) detail, its lines, reviewing,
 * approving, rejecting, and resending to extraction — is owner-only, matching
 * `lib/authz.ts:canSeeCost`; the manager archive list goes through
 * `listInvoicesRedactedAction`, backed by a query that never selects a
 * monetary column.
 *
 * `uploadInvoiceAction` and `confirmUploadAction` deliberately return a
 * shaped DTO rather than the raw `InvoiceRow` domain type — the shape itself
 * is the cost-data gate (invariant 8), not a filter applied after the fact.
 */
import { requireRole } from "@/lib/authz";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as invoices from "@/lib/domain/invoices";
import * as invoiceLines from "@/lib/domain/invoice-lines";
import { approveInvoice, type ApproveInvoiceResult } from "@/lib/domain/invoice-approval";
import {
  uploadInvoiceSchema,
  confirmUploadSchema,
  getInvoiceSchema,
  getInvoiceLinesSchema,
  listInvoicesSchema,
  reviewInvoiceSchema,
  rejectInvoiceSchema,
  resendToExtractionSchema,
  approveInvoiceSchema,
} from "@/lib/validation/invoices";

export interface UploadInvoiceResult {
  invoiceId: number;
  uploadUrl: string;
  status: invoices.InvoiceStatus;
}

/**
 * Creates the `invoice` + `extraction_job` rows and hands back where to PUT
 * the file. Rejects any `contentType` outside the accepted allowlist and
 * caps the declared byte length at 25 MB — both enforced again on the real
 * request body in `app/api/invoices/[id]/file/route.ts`'s `PUT`, since a
 * declared value here is client-supplied input.
 */
export async function uploadInvoiceAction(
  input: unknown,
): Promise<ActionResult<UploadInvoiceResult>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = uploadInvoiceSchema.parse(input);
    const created = await invoices.createInvoiceForUpload(actor, parsed);
    return {
      invoiceId: created.id,
      uploadUrl: `/api/invoices/${created.id}/file`,
      status: created.status,
    };
  });
}

export interface ConfirmUploadResult {
  matched: boolean;
  status: invoices.InvoiceStatus;
}

/**
 * The `awaiting_upload -> queued` edge. `matched: false` means the bytes on
 * disk didn't verify against what was declared at upload time (or haven't
 * landed yet) — the client's remedy is to retry the `PUT`, not to retry this
 * call blindly.
 */
export async function confirmUploadAction(
  input: unknown,
): Promise<ActionResult<ConfirmUploadResult>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = confirmUploadSchema.parse(input);
    const result = await invoices.markUploadConfirmed(actor, parsed.invoiceId);
    return { matched: result.matched, status: result.invoice.status };
  });
}

/**
 * Full invoice detail, including every monetary column. Owner-only —
 * matches `lib/authz.ts:canSeeCost` and 04-slices.md's Slice 2 acceptance
 * criterion that this screen refuses a manager.
 */
export async function getInvoiceAction(
  input: unknown,
): Promise<ActionResult<invoices.InvoiceRow>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    const parsed = getInvoiceSchema.parse(input);
    return invoices.getInvoice(actor, parsed.invoiceId);
  });
}

/** The owner's archive list — every column, including monetary ones. */
export async function listInvoicesForOwnerAction(
  input: unknown = {},
): Promise<ActionResult<invoices.InvoiceRow[]>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    const parsed = listInvoicesSchema.parse(input);
    return invoices.listInvoicesForOwner(actor, parsed);
  });
}

/**
 * The manager/staff-safe archive list [AR-7] — backed by a query that never
 * selects a monetary column, so there is nothing for this action to leak
 * even if it forgot to gate. Staff is excluded: invoices are not a staff
 * concern (spec §4).
 */
export async function listInvoicesRedactedAction(
  input: unknown = {},
): Promise<ActionResult<invoices.InvoiceRowRedacted[]>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = listInvoicesSchema.parse(input);
    return invoices.listInvoicesRedacted(actor, parsed);
  });
}

/**
 * The review screen's line table — every column, including cost. Owner-only,
 * same gate as `getInvoiceAction`: a manager has no legitimate use for this
 * screen (04-slices.md's `manager_cannot_open_review_screen`).
 */
export async function getInvoiceLinesAction(
  input: unknown,
): Promise<ActionResult<invoiceLines.InvoiceLineRow[]>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    const parsed = getInvoiceLinesSchema.parse(input);
    return invoiceLines.getLinesForInvoice(actor, parsed.invoiceId);
  });
}

/**
 * The review screen's submit — applies every line correction and CAS's the
 * invoice `needs_review -> reviewed` atomically (see
 * `lib/domain/invoice-lines.ts:submitInvoiceReview`). [AR-2]: every
 * `matchedProductId` in `corrections` is batch ownership-checked against
 * this organization, in one query, before any row is written. If the
 * invoice moved on since the reviewer loaded the screen — rejected, or
 * already reviewed by someone else — this surfaces as a `ConflictError`
 * (mapped to a plain "conflict" message by `runAction`), and nothing is
 * written; it never silently overwrites (04-slices.md's
 * `review_conflicts_when_status_moved`).
 */
export async function reviewInvoiceAction(
  input: unknown,
): Promise<ActionResult<invoices.InvoiceRow>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    const parsed = reviewInvoiceSchema.parse(input);
    return invoiceLines.submitInvoiceReview(actor, parsed.invoiceId, parsed.corrections);
  });
}

/**
 * Rejects an invoice with a required, auditable reason. CAS's
 * `needs_review | reviewed -> rejected`; `approved` is terminal [AR-4] and
 * is not in the `from` list, so an attempt to reject an approved invoice
 * raises the same `ConflictError` any other illegal edge would.
 */
export async function rejectInvoiceAction(
  input: unknown,
): Promise<ActionResult<invoices.InvoiceRow>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    const parsed = rejectInvoiceSchema.parse(input);
    return invoices.updateInvoiceStatus(
      actor,
      parsed.invoiceId,
      ["needs_review", "reviewed"],
      "rejected",
      { rejectionReason: parsed.reason },
    );
  });
}

/**
 * The owner's `reviewed -> approved` submit (Phase 2.5, Slice 4). Derives a
 * unit cost for every matched product line, snapshots it onto
 * `product_cost_history`, and writes it forward onto
 * `product.current_unit_cost` — see `lib/domain/invoice-approval.ts` for the
 * full CAS/transaction contract. A replay (the same invoice approved twice,
 * sequentially or concurrently) returns the same success with
 * `costLinesApplied: 0`, never an error — see that file's header for why.
 */
export async function approveInvoiceAction(
  input: unknown,
): Promise<ActionResult<ApproveInvoiceResult>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    const parsed = approveInvoiceSchema.parse(input);
    return approveInvoice(actor, parsed.invoiceId);
  });
}

export interface ResendToExtractionResult {
  invoiceId: number;
  extractionJobId: number;
  status: invoices.InvoiceStatus;
}

/**
 * Re-extract: opens a NEW `extraction_job` row (`queued`, skipping
 * `awaiting_upload` — the file is already confirmed and on disk from the
 * original upload) and CAS's the invoice `rejected -> processing`
 * [AR-4/AR-6]. The previous job's `error_message`/`retry_count` are left
 * untouched — they are that attempt's own history, not this one's.
 */
export async function resendToExtractionAction(
  input: unknown,
): Promise<ActionResult<ResendToExtractionResult>> {
  return runAction(async () => {
    const actor = await requireRole("owner");
    const parsed = resendToExtractionSchema.parse(input);
    const result = await invoices.resendInvoiceToExtraction(actor, parsed.invoiceId);
    return {
      invoiceId: result.invoice.id,
      extractionJobId: result.extractionJobId,
      status: result.invoice.status,
    };
  });
}
