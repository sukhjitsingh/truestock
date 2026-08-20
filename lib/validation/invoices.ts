/**
 * Zod schemas for the invoice upload/archive boundary (Phase 2.5, Slice 1).
 * Shared with the frontend — see db/enums.ts's header for why this file must
 * not import anything that drags Drizzle or a Node built-in into the
 * browser bundle. `ACCEPTED_INVOICE_CONTENT_TYPES` therefore comes from
 * `lib/storage/invoice-content-types.ts` (a zero-import module), never from
 * `lib/storage/invoice-files.ts` itself, which imports `node:fs/promises`.
 */
import { z } from "zod";
import { invoiceStatusEnum, invoiceSourceEnum } from "@/db/enums";
import { ACCEPTED_INVOICE_CONTENT_TYPES } from "@/lib/storage/invoice-content-types";

export const invoiceStatusSchema = z.enum(invoiceStatusEnum);
export const invoiceSourceSchema = z.enum(invoiceSourceEnum);

const contentTypeSchema = z.enum(
  ACCEPTED_INVOICE_CONTENT_TYPES as [string, ...string[]],
);

/**
 * A SHA-256 digest as lowercase hex — same shape `sha256Hex` produces (64
 * hex characters). Validated here so a malformed declared hash fails with an
 * actionable Zod message rather than reaching the database and simply never
 * matching in `markUploadConfirmed`.
 */
const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Must be a lowercase SHA-256 hex digest (64 characters).");

/**
 * Sanity ceiling on the DECLARED byte length, enforced again on the real
 * request body in `app/api/invoices/[id]/file/route.ts`'s `PUT` handler — a
 * declared value is client-supplied input and must never be the only gate.
 * 25 MB comfortably covers a phone photo or a multi-page scanned PDF.
 */
const MAX_INVOICE_BYTES = 25 * 1024 * 1024;

export const uploadInvoiceSchema = z.object({
  vendorId: z.number().int().positive().optional(),
  source: invoiceSourceSchema,
  contentType: contentTypeSchema,
  fileSha256: sha256HexSchema,
  fileSizeBytes: z.number().int().positive().max(MAX_INVOICE_BYTES),
});
export type UploadInvoiceInput = z.infer<typeof uploadInvoiceSchema>;

export const confirmUploadSchema = z.object({
  invoiceId: z.number().int().positive(),
});
export type ConfirmUploadInput = z.infer<typeof confirmUploadSchema>;

export const getInvoiceSchema = z.object({
  invoiceId: z.number().int().positive(),
});

/** Invoice archive list (back office). Bounded so the screen can't ask for everything. */
export const listInvoicesSchema = z.object({
  status: invoiceStatusSchema.optional(),
  vendorId: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(200).optional().default(50),
});
export type ListInvoicesInput = z.infer<typeof listInvoicesSchema>;

export const getInvoiceLinesSchema = getInvoiceSchema;

/**
 * A `DECIMAL(12,2)` money value as the string form Drizzle round-trips
 * (`invoiceLine.rawGross`/`rawDiscount`/`rawNet` — see db/schema.ts). Up to
 * 10 integer digits, an optional leading `-` (a discount line is naturally
 * negative), and at most 2 decimal places. `null` is a distinct, valid value
 * — it clears the column, matching `lib/domain/invoice-lines.ts`'s
 * `LineCorrection` doc comment; `undefined`/omitted leaves it unchanged.
 */
const moneyStringSchema = z
  .string()
  .regex(/^-?\d{1,10}(\.\d{1,2})?$/, "Must be a number with up to 2 decimal places.");

/**
 * One line's reviewer correction — mirrors
 * `lib/domain/invoice-lines.ts`'s `LineCorrection` exactly. `matchMethod`
 * and `exceptionFlags` are deliberately NOT fields here: both are derived
 * server-side from `matchedProductId`, never accepted from the client (see
 * that file's comment on `LineCorrection`).
 */
export const lineCorrectionSchema = z.object({
  id: z.number().int().positive(),
  rawGross: moneyStringSchema.nullable().optional(),
  rawDiscount: moneyStringSchema.nullable().optional(),
  rawNet: moneyStringSchema.nullable().optional(),
  matchedProductId: z.number().int().positive().nullable().optional(),
});

/**
 * A `DATE` column as the plain "YYYY-MM-DD" string form `mode: "string"` +
 * db/index.ts's `dateStrings: ["DATE"]` round-trips — same convention
 * `lib/validation/counts.ts`'s `openedAt` uses. Shared by `invoiceDate` and
 * `retentionUntil` below; both are calendar days, not moments in time (see
 * `db/schema.ts`'s comment on `invoice.invoiceDate`).
 */
const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD.");

/**
 * `invoice.total_gross`/`total_net` are `DECIMAL(10,4)` — a different
 * precision from `invoice_line`'s `DECIMAL(12,2)` columns `moneyStringSchema`
 * above validates, so this is a deliberately separate schema, not a reuse.
 * Up to 6 integer digits, an optional leading `-`, up to 4 decimal places.
 */
const invoiceTotalMoneyStringSchema = z
  .string()
  .regex(/^-?\d{1,6}(\.\d{1,4})?$/, "Must be a number with up to 4 decimal places.");

/**
 * `invoice.currency` is `varchar(3)`, documented on that column as "ISO 4217
 * code (e.g. \"USD\")." Accepts any letter case and normalizes to uppercase,
 * mirroring `lib/domain/extraction-pipeline.ts`'s own
 * `/^[A-Za-z]{3}$/` + `.toUpperCase()` normalization of an extracted currency
 * code, so a reviewer typing "usd" isn't rejected for a case difference the
 * document itself wouldn't have made legible either way.
 */
const currencyCodeSchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "Must be a 3-letter ISO 4217 currency code.")
  .transform((value) => value.toUpperCase());

/**
 * A reviewer's correction to one of `lib/domain/invoices.ts`'s
 * `REQUIRED_FOR_REVIEW` header columns — open item #32's fix. Every field is
 * optional (a reviewer typically corrects zero or one of these); omitted
 * means "leave this column alone," the same discipline `lineCorrectionSchema`
 * uses. Unlike line corrections, there is no `null`/clear case here: a submit
 * that both clears a required field back to NULL and tries to reach
 * `reviewed` in the same request could only ever fail `REQUIRED_FOR_REVIEW`'s
 * own null-check, so every field stays a bare optional string.
 */
export const headerCorrectionSchema = z.object({
  invoiceDate: dateStringSchema.optional(),
  invoiceNumber: z.string().trim().min(1).max(100).optional(),
  totalGross: invoiceTotalMoneyStringSchema.optional(),
  totalNet: invoiceTotalMoneyStringSchema.optional(),
  currency: currencyCodeSchema.optional(),
  retentionUntil: dateStringSchema.optional(),
});
export type HeaderCorrectionInput = z.infer<typeof headerCorrectionSchema>;

/**
 * The review screen's submit. `corrections` may be an empty array — a
 * reviewer who touched nothing still needs to be able to move the invoice
 * `needs_review -> reviewed` (e.g. the pipeline already matched every line
 * correctly and nothing needs changing). `headerCorrections` is likewise
 * optional and most often omitted entirely — most reviews correct zero
 * header fields; see `headerCorrectionSchema`'s own comment for what it
 * covers and why it exists.
 */
export const reviewInvoiceSchema = z.object({
  invoiceId: z.number().int().positive(),
  corrections: z.array(lineCorrectionSchema).max(500),
  headerCorrections: headerCorrectionSchema.optional(),
});
export type ReviewInvoiceInput = z.infer<typeof reviewInvoiceSchema>;

/**
 * A reason is required — an invoice rejection is a permanent, auditable
 * record (`invoice.rejectionReason`), not a silent status flip.
 */
export const rejectInvoiceSchema = z.object({
  invoiceId: z.number().int().positive(),
  reason: z.string().trim().min(1, "A rejection reason is required.").max(2000),
});
export type RejectInvoiceInput = z.infer<typeof rejectInvoiceSchema>;

export const resendToExtractionSchema = z.object({
  invoiceId: z.number().int().positive(),
});
export type ResendToExtractionInput = z.infer<typeof resendToExtractionSchema>;

/**
 * Phase 2.5, Slice 4 — the owner's `reviewed -> approved` submit. No body
 * beyond the invoice id: everything the approval writes (unit costs, the
 * `product_cost_history` snapshot, `approved_at`/`approved_by`) is derived
 * server-side inside `lib/domain/invoice-approval.ts:approveInvoice`, never
 * accepted from the client.
 */
export const approveInvoiceSchema = z.object({
  invoiceId: z.number().int().positive(),
});
export type ApproveInvoiceInput = z.infer<typeof approveInvoiceSchema>;

export { MAX_INVOICE_BYTES };
