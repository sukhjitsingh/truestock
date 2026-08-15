"use server";

/**
 * Invoice server actions — Phase 2.5, Slice 1 (upload + archive tracer
 * bullet). Every export checks session + role itself (CLAUDE.md invariant
 * 7) via lib/authz.ts, never relying on middleware. All writes run through
 * lib/domain/invoices.ts, which owns the upload/confirm handshake [AR-6],
 * the tenant-ownership checks [AR-2], and the two-query owner/manager split
 * [AR-7].
 *
 * Upload and confirm are owner + manager, never staff — invoices are not a
 * staff concern (spec §4: staff is count-only). Reading a single invoice
 * with its full (unredacted) detail is owner-only, matching
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
import {
  uploadInvoiceSchema,
  confirmUploadSchema,
  getInvoiceSchema,
  listInvoicesSchema,
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
