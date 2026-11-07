/**
 * Invoice domain functions — Phase 2.5, Slice 1 (OCR invoice automation,
 * upload + archive tracer bullet). `docs/plans/phase-2.5-invoice-automation/
 * 02-architecture.md` and `03-program-design.md` are the spec; only
 * `invoice` and `extraction_job` exist as tables in this slice, so
 * `invoice_line`, `vendor_alias`, `product_cost_history` and the
 * approve/reject/review flow are NOT built here.
 *
 * ## Two SELECTs, never one role-agnostic list [AR-7]
 *
 * `listInvoicesForOwner` and `listInvoicesRedacted` are separate query
 * functions, not one function with a role-conditional column filter applied
 * after the fact. A post-hoc filter is a promise that every future column
 * added to the owner query also gets remembered in the filter; a query that
 * never names a monetary column in the first place has nothing to forget.
 * `listInvoicesRedacted`'s SELECT list is intentionally spelled out in full
 * (never `select()`/`select(invoice)`) so that adding a money column to the
 * `invoice` table cannot silently widen what it returns.
 *
 * ## The upload/confirm handshake [AR-6]
 *
 * `createInvoiceForUpload` inserts `invoice` (status `uploaded`) and
 * `extraction_job` (status `awaiting_upload`, NOT `queued` — a job claimable
 * before the file exists gets picked up by the cron before there is
 * anything to extract) in one transaction, then stamps `file_path` once the
 * row's id is known. `markUploadConfirmed` is the only path from
 * `awaiting_upload` to `queued`, and only takes it once the bytes actually on
 * disk are re-hashed and re-measured and BOTH match what was declared at
 * upload time — comparing a declared value against itself would make the
 * verification decorative, so the comparison is always declared-vs-derived,
 * never declared-vs-declared.
 */
import { readFile } from "node:fs/promises";
import { and, count, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { invoice, invoiceLine, vendor } from "@/db/schema";
import { invoiceStatusEnum, invoiceSourceEnum } from "@/db/enums";
import type { Actor } from "@/lib/authz";
import {
  ConflictError,
  InvalidInvoiceTransitionError,
  InvoiceNotWritableError,
  NoInvoiceLinesError,
  NotFoundError,
} from "@/lib/domain/errors";
import {
  resolveStoredPath,
  invoiceStorageKey,
  sha256Hex,
} from "@/lib/storage/invoice-files";
import { lockJobForUpload, updateJobStatusTx } from "@/lib/domain/extraction";
import { extractionJob } from "@/db/schema";
import { isDuplicateKeyOnIndex, withLockRetry } from "@/lib/domain/db-errors";

export type InvoiceStatus = (typeof invoiceStatusEnum)[number];
export type InvoiceSource = (typeof invoiceSourceEnum)[number];

// Extracts the transaction-callback parameter type from `db.transaction`
// itself, matching lib/domain/counts.ts's `Tx` — stays correct regardless of
// exactly which class drizzle-orm's mysql2 driver hands back as `tx`.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * [AR-4] The invoice lifecycle, declared once as data. `uploaded` and
 * `processing` are Slice 1/2 territory; `reviewed`/`approved`/`rejected` are
 * exercised starting Slice 2, but the CAS machinery and the `reviewed`
 * NULL-field guard below are built now so a later slice's `reviewInvoice`
 * has a correct, tested primitive to call rather than reinventing this.
 *
 * `approved` is terminal — nothing transitions out of it. A correction to an
 * approved invoice is a new record, never a status edit (mirrors invariant
 * 1's "closed counts are immutable").
 */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  uploaded: ["processing"],
  processing: ["needs_review"],
  // needs_review -> processing is the owner's "retry extraction" edge. It is
  // legal only when the latest extraction job FAILED; that guard lives in
  // `resendInvoiceToExtraction`, not in this graph (F8).
  needs_review: ["reviewed", "rejected", "processing"],
  reviewed: ["approved", "rejected"],
  approved: [],
  rejected: ["processing"],
};

/** Columns that must be non-null before an invoice may become `reviewed`. */
const REQUIRED_FOR_REVIEW = [
  "invoiceDate",
  "invoiceNumber",
  "totalGross",
  "totalNet",
  "currency",
  "retentionUntil",
] as const;

export interface InvoiceRow {
  id: number;
  organizationId: number;
  vendorId: number | null;
  status: InvoiceStatus;
  source: InvoiceSource;
  filePath: string | null;
  fileSha256: string;
  fileSizeBytes: number;
  pageCount: number | null;
  invoiceDate: string | null;
  dueDate: string | null;
  invoiceNumber: string | null;
  totalGross: string | null;
  totalDiscount: string | null;
  totalNet: string | null;
  currency: string | null;
  retentionUntil: string | null;
  approvedAt: Date | null;
  approvedBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The manager/staff-safe shape [AR-7]: no monetary column, no storage path
 * (the file is only ever reachable through the authenticated, owner-only
 * `GET /api/invoices/[id]/file` route — see that route's comment), no
 * SHA-256/byte-length (upload-verification internals, not archive content).
 */
export interface InvoiceRowRedacted {
  id: number;
  organizationId: number;
  vendorId: number | null;
  status: InvoiceStatus;
  source: InvoiceSource;
  invoiceDate: string | null;
  dueDate: string | null;
  invoiceNumber: string | null;
  currency: string | null;
  retentionUntil: string | null;
  createdAt: Date;
}

/**
 * Exported for `lib/domain/invoice-approval.ts`, which needs to turn a raw
 * `invoice` row it read (and locked) inside its OWN transaction into the same
 * `InvoiceRow` shape every other read in this file returns — rather than
 * duplicating this mapping or re-selecting through a second, unlocked query.
 */
export function toInvoiceRow(row: typeof invoice.$inferSelect): InvoiceRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    vendorId: row.vendorId,
    status: row.status,
    source: row.source,
    filePath: row.filePath,
    fileSha256: row.fileSha256,
    fileSizeBytes: row.fileSizeBytes,
    pageCount: row.pageCount,
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate,
    invoiceNumber: row.invoiceNumber,
    totalGross: row.totalGross,
    totalDiscount: row.totalDiscount,
    totalNet: row.totalNet,
    currency: row.currency,
    retentionUntil: row.retentionUntil,
    approvedAt: row.approvedAt,
    approvedBy: row.approvedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function assertVendorOwned(tx: Tx, organizationId: number, vendorId: number): Promise<void> {
  const [owned] = await tx
    .select({ id: vendor.id })
    .from(vendor)
    .where(and(eq(vendor.id, vendorId), eq(vendor.organizationId, organizationId)))
    .limit(1);
  if (!owned) {
    throw new NotFoundError("Vendor");
  }
}

// ---------------------------------------------------------------------------
// Retention — spec §10
// ---------------------------------------------------------------------------

/**
 * `invoice_date + 3 years`.
 *
 * The documents disagreed and the disagreement is resolved here in the safe
 * direction, deliberately. A.A.C. R19-1-501 sets the legal FLOOR at two
 * years; spec §10 says "invoice_date + 2 years minimum (**3 is safer**)";
 * spec.md's own summary table and 03-program-design.md both say 3.
 *
 * The asymmetry decides it. `retention_until` is not an expiry — it is the
 * date before which an invoice must NEVER be deleted, and it is what the
 * retention sweep reads. Set it to 2 and every invoice becomes eligible for
 * deletion a year earlier than the plan intended; if the sweep ever runs, a
 * legally-required record is gone and no correction brings it back. Set it
 * to 3 and the cost is a year of disk. One mistake is unrecoverable and the
 * other is cheap, so this rounds up, and the two-year statutory minimum is
 * satisfied either way.
 *
 * Pure calendar-string arithmetic via `Date.UTC` — never a local-timezone
 * `Date`, for the same reason `count_line.opened_at` avoids one (see that
 * column's comment): a calendar day printed on a document must not shift by
 * a day depending on the server's timezone. `Date.UTC`'s day-of-month
 * overflow handles Feb 29 landing on a non-leap target year by rolling to
 * Mar 1, the conventional "add N years" behavior.
 */
export function computeRetentionUntil(invoiceDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(invoiceDate);
  if (!match) {
    throw new Error("invoiceDate must be in YYYY-MM-DD form.");
  }
  const [, yearStr, monthStr, dayStr] = match;
  const date = new Date(Date.UTC(Number(yearStr) + 3, Number(monthStr) - 1, Number(dayStr)));
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * A reviewer's correction to one of `REQUIRED_FOR_REVIEW`'s six columns —
 * open item #32's fix (`docs/open-items.md`). `lib/validation/invoices.ts`'s
 * `headerCorrectionSchema` is the Zod boundary for this same shape; every
 * field here is a bare optional string (never `null`) for the reason that
 * schema's own comment gives.
 */
export interface HeaderCorrection {
  invoiceDate?: string;
  invoiceNumber?: string;
  totalGross?: string;
  totalNet?: string;
  currency?: string;
  retentionUntil?: string;
}

/**
 * Turns a reviewer's `HeaderCorrection` into the `data` argument
 * `updateInvoiceStatusTx` already accepts — `lib/domain/invoice-lines.ts`'s
 * `submitInvoiceReview` passes the result straight through as that call's
 * `data`, in the SAME transaction as the line corrections, so a correction
 * that fills a previously-NULL field is visible to THAT SAME call's own
 * `merged` null-check (below, in `updateInvoiceStatusTx`): a correction makes
 * a field non-null, it never bypasses the requirement.
 *
 * One derived field: if the correction sets `invoiceDate` and does NOT also
 * separately correct `retentionUntil`, this fills `retentionUntil` in from
 * `computeRetentionUntil(invoiceDate)` above — the exact computation
 * `lib/domain/extraction-pipeline.ts` already trusts every time it
 * successfully reads an invoice date off a document. `computeRetentionUntil`'s
 * own comment names getting this date wrong as unrecoverable (it is the date
 * before which a legally-required record must never be deleted), so deriving
 * it here is safer than asking a reviewer to hand-calculate a three-years-out
 * calendar date and free-text it in — the one case that function's comment
 * warns is a real, silent risk. A correction that explicitly names
 * `retentionUntil` is always honored as given; this only fills a gap, it
 * never overrides an explicit value.
 */
export function resolveHeaderCorrectionData(
  correction: HeaderCorrection,
): Partial<typeof invoice.$inferInsert> {
  const data: Partial<typeof invoice.$inferInsert> = { ...correction };
  if (correction.invoiceDate != null && correction.retentionUntil == null) {
    data.retentionUntil = computeRetentionUntil(correction.invoiceDate);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Create — upload request
// ---------------------------------------------------------------------------

export interface CreateInvoiceForUploadInput {
  vendorId?: number | null;
  source: InvoiceSource;
  contentType: string;
  fileSha256: string;
  fileSizeBytes: number;
}

// ---------------------------------------------------------------------------
// One live copy of a file per organization (F7)
// ---------------------------------------------------------------------------

/**
 * The invoice that already holds the claim on a file, as shown to the person
 * whose upload was refused. Deliberately carries no money and no storage
 * detail: a manager receives this too, and these are only the fields that let
 * a person recognise the document. Always read org-scoped, so it can never
 * describe another tenant's invoice.
 */
export interface DuplicateInvoice {
  invoiceId: number;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  status: InvoiceStatus;
  uploadedAt: Date;
}

/** The unique index that makes "one live copy per organization" true. */
const LIVE_FILE_INDEX = "invoice_organization_live_file_sha256_unique";

type SelectExecutor = Pick<Tx, "select">;

async function toDuplicate(
  exec: SelectExecutor,
  orgId: number,
  row: typeof invoice.$inferSelect,
): Promise<DuplicateInvoice> {
  let vendorName: string | null = null;
  if (row.vendorId != null) {
    // A separate org-scoped select, not a join: the locking read that found
    // `row` must lock the invoice row only, and FOR UPDATE over a join would
    // lock the vendor row too.
    const [v] = await exec
      .select({ name: vendor.name })
      .from(vendor)
      .where(and(eq(vendor.id, row.vendorId), eq(vendor.organizationId, orgId)))
      .limit(1);
    vendorName = v?.name ?? null;
  }
  return {
    invoiceId: row.id,
    vendorName,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    status: row.status,
    uploadedAt: row.createdAt,
  };
}

/**
 * Plain (non-locking) lookup, for the upload request: a fast refusal before
 * any bytes move. NOT the guarantee — the unique index is; two simultaneous
 * uploads both pass this and one loses at confirm. Non-locking on purpose: a
 * `FOR UPDATE` that matches nothing takes a gap lock, and two concurrent
 * upload requests holding the same gap while each inserts an invoice row is a
 * deadlock.
 */
export async function findLiveCopy(orgId: number, sha256: string): Promise<DuplicateInvoice | null> {
  const [row] = await db
    .select()
    .from(invoice)
    .where(and(eq(invoice.organizationId, orgId), eq(invoice.liveFileSha256, sha256)))
    .limit(1);
  return row ? toDuplicate(db, orgId, row) : null;
}

/**
 * Locking lookup, for the loser of a claim race. MUST be `FOR UPDATE`: at
 * repeatable read a plain select after the 1062 reads from the transaction's
 * snapshot, which can predate the winner's commit and so miss the very row
 * that caused the collision, leaving a refusal with nothing to name. A
 * locking read is a current read and sees it.
 */
async function findLiveCopyTx(
  tx: Tx,
  orgId: number,
  sha256: string,
  excludeInvoiceId?: number,
): Promise<DuplicateInvoice | null> {
  const conditions = [eq(invoice.organizationId, orgId), eq(invoice.liveFileSha256, sha256)];
  // A claim must never name the invoice itself as its own duplicate.
  if (excludeInvoiceId != null) conditions.push(ne(invoice.id, excludeInvoiceId));
  const [row] = await tx
    .select()
    .from(invoice)
    .where(and(...conditions))
    .limit(1)
    .for("update");
  return row ? toDuplicate(tx, orgId, row) : null;
}

/**
 * Takes the claim on `sha256` for `invoiceId`, or names whoever holds it.
 * Returns null when the claim is ours (including when it already was), the
 * holder when it is not.
 *
 * Only a 1062 on THIS index means "someone else holds the claim"; a collision
 * on any other unique index is a different bug and is rethrown. A failed
 * statement does not abort the surrounding InnoDB transaction, so the caller
 * can read the winner in the same one.
 */
export async function claimFileTx(
  tx: Tx,
  orgId: number,
  invoiceId: number,
  sha256: string,
): Promise<DuplicateInvoice | null> {
  try {
    await tx
      .update(invoice)
      .set({ liveFileSha256: sha256 })
      .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, orgId)));
    return null;
  } catch (err) {
    if (!isDuplicateKeyOnIndex(err, LIVE_FILE_INDEX)) {
      throw err;
    }
  }
  const holder = await findLiveCopyTx(tx, orgId, sha256, invoiceId);
  if (!holder) {
    // The holder released the claim between the collision and the read (it
    // was rejected in that instant). Say so plainly rather than guess.
    throw new ConflictError("Another copy of this file was just changed. Try uploading again.");
  }
  return holder;
}

export type CreateInvoiceForUploadResult =
  | { outcome: "created"; invoice: InvoiceRow }
  | { outcome: "duplicate"; duplicate: DuplicateInvoice };

/**
 * If the organization already holds a live copy of this file, creates nothing
 * and returns it. Otherwise one transaction, three writes, all or none:
 *   1. INSERT `invoice` (status `uploaded`, the declared hash/size).
 *   2. UPDATE `file_path` — only computable once the id exists
 *      (`invoiceStorageKey` is `{org}/{id}.{ext}`).
 *   3. INSERT `extraction_job` (status `awaiting_upload`).
 * The claim (`live_file_sha256`) is NOT taken here: only bytes verified on
 * disk hold one, so an abandoned upload blocks nothing.
 *
 * `vendorId`, if supplied, is ownership-checked before anything is written
 * [AR-2] — the composite `invoice_organization_vendor_fk` is a backstop
 * (1452 on a cross-tenant id), not the primary check; the primary check is
 * this assertion, which returns the caller-safe `NotFoundError` instead of a
 * raw driver error.
 */
export async function createInvoiceForUpload(
  actor: Actor,
  input: CreateInvoiceForUploadInput,
): Promise<CreateInvoiceForUploadResult> {
  const existing = await findLiveCopy(actor.organizationId, input.fileSha256);
  if (existing) {
    return { outcome: "duplicate", duplicate: existing };
  }
  const created = await db.transaction(async (tx) => {
    if (input.vendorId != null) {
      await assertVendorOwned(tx, actor.organizationId, input.vendorId);
    }

    const [inserted] = await tx
      .insert(invoice)
      .values({
        organizationId: actor.organizationId,
        vendorId: input.vendorId ?? null,
        status: "uploaded",
        source: input.source,
        fileSha256: input.fileSha256,
        fileSizeBytes: input.fileSizeBytes,
      })
      .$returningId();

    const filePath = invoiceStorageKey(actor.organizationId, inserted.id, input.contentType);
    await tx
      .update(invoice)
      .set({ filePath })
      .where(and(eq(invoice.id, inserted.id), eq(invoice.organizationId, actor.organizationId)));

    await tx.insert(extractionJob).values({
      organizationId: actor.organizationId,
      invoiceId: inserted.id,
      status: "awaiting_upload",
    });

    const [row] = await tx
      .select()
      .from(invoice)
      .where(and(eq(invoice.id, inserted.id), eq(invoice.organizationId, actor.organizationId)))
      .limit(1);
    if (!row) {
      throw new NotFoundError("Invoice");
    }
    return toInvoiceRow(row);
  });
  return { outcome: "created", invoice: created };
}

// ---------------------------------------------------------------------------
// Confirm upload — the ONLY awaiting_upload -> queued edge [AR-6]
// ---------------------------------------------------------------------------

export interface ConfirmUploadResult {
  /**
   * Whether the bytes on disk matched what was declared at upload time AND
   * this invoice is now queued. False when `duplicate` is set even though the
   * bytes verified: a caller that predates F7 and only reads `matched` must
   * not report a refused upload as a success.
   */
  matched: boolean;
  invoice: InvoiceRow;
  /** Set when another live invoice in the organization already holds this file. */
  duplicate?: DuplicateInvoice;
}

/**
 * Re-derives SHA-256 and byte length from the bytes actually written to
 * `INVOICE_STORAGE_DIR` and compares them against `invoice.file_sha256` /
 * `invoice.file_size_bytes` — the values declared when the upload was
 * requested, before any byte existed to hash. That declared/derived split is
 * the whole point: comparing a value against itself would make this
 * verification decorative.
 *
 * A missing/unreadable object, or one whose stored path fails the
 * containment check in `resolveStoredPath`, is treated as "not yet
 * confirmable" (`matched: false`) rather than thrown — a client that PUTs
 * the file and then calls confirm before the write has landed, or retries a
 * confirm after a failed PUT, must get an ordinary answer back, not a crash.
 *
 * On a match, the `extraction_job` row is looked up ownership-scoped to
 * `actor.organizationId` first [AR-2] (its id is not client-supplied, but
 * the invoice id used to find it is), then CAS'd `awaiting_upload -> queued`
 * via `lib/domain/extraction.ts:updateJobStatus`. If the job has already
 * moved past `awaiting_upload` (a second confirm call, e.g. a retried
 * request), that is treated as an already-applied confirm — `matched: true`
 * with no further write — rather than a conflict; nothing about the object
 * changed between the two calls, so replaying the confirmation must produce
 * the same success it produced the first time.
 */
export async function markUploadConfirmed(
  actor: Actor,
  invoiceId: number,
): Promise<ConfirmUploadResult> {
  const [row] = await db
    .select()
    .from(invoice)
    .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError("Invoice");
  }

  if (!row.filePath) {
    return { matched: false, invoice: toInvoiceRow(row) };
  }
  const filePath = row.filePath;

  // The read, the hash and the CAS all run under the extraction_job row lock,
  // and so does the `PUT` that writes the file (`withUploadSlot`). Hashing
  // outside the lock would verify a file a concurrent writer is in the middle
  // of replacing: confirm would match the bytes it read, CAS the job to
  // `queued`, and the writer's bytes would land afterward over a file now
  // recorded as verified. See `lockJobForUpload`'s comment for the full
  // ordering argument.
  //
  // The claim on the file (F7) is taken here too, in the same transaction that
  // moves the job to `queued`, so only bytes verified on disk hold one and the
  // claim and the queueing commit or roll back together. The unique index, not
  // any lookup, decides a race: if another invoice won it, the job stays at
  // `awaiting_upload` and nothing is queued. `withLockRetry` re-runs the whole
  // transaction on a deadlock or a stale-snapshot (1020) from the locking read
  // that names the winner; nothing the first attempt did persisted.
  return withLockRetry(() => lockJobForUpload(actor.organizationId, invoiceId, async (jobRow, tx) => {
    let actualSha256: string;
    let actualSize: number;
    try {
      const bytes = await readFile(resolveStoredPath(filePath));
      actualSha256 = sha256Hex(bytes);
      actualSize = bytes.byteLength;
    } catch {
      // ENOENT (PUT hasn't landed / never happened) or a StoragePathError
      // (corrupt file_path) — either way, not yet confirmable. Never a crash.
      return { matched: false, invoice: toInvoiceRow(row) };
    }

    const matched = actualSha256 === row.fileSha256 && actualSize === row.fileSizeBytes;
    if (!matched) {
      return { matched: false, invoice: toInvoiceRow(row) };
    }

    if (jobRow.status === "awaiting_upload") {
      const holder = await claimFileTx(tx, actor.organizationId, invoiceId, row.fileSha256);
      if (holder) {
        return { matched: false, invoice: toInvoiceRow(row), duplicate: holder };
      }
      await updateJobStatusTx(tx, jobRow.id, "awaiting_upload", "queued");
    }
    // Any other status means a previous confirm already advanced it — treated
    // as an idempotent replay, not a conflict. Under the lock this is now the
    // only way a second confirm can reach here: it cannot observe
    // `awaiting_upload`, race the first caller's CAS, and lose. Before the
    // lock existed, two concurrent confirms both read `awaiting_upload`, one
    // CAS won and the other raised ConflictError out of a call this
    // function's own contract promises is safe to replay.

    return { matched: true, invoice: toInvoiceRow(row) };
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Owner-facing single-invoice read (role enforced by the caller, per the
 * lib/domain/counts.ts convention — this function's own contract is
 * tenant-scoping). Cross-tenant id -> `NotFoundError`, never a response that
 * confirms the row exists (invariant 9).
 */
export async function getInvoice(actor: Actor, invoiceId: number): Promise<InvoiceRow> {
  const [row] = await db
    .select()
    .from(invoice)
    .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError("Invoice");
  }
  return toInvoiceRow(row);
}

export interface InvoiceFilters {
  status?: InvoiceStatus;
  vendorId?: number;
  limit?: number;
}

/**
 * Slice 1's archive list: "queries `invoice` rows scoped to
 * `actor.organizationId` where `status != 'approved'`" (04-slices.md). An
 * explicit `filters.status` overrides that default exclusion — a future
 * "approved" tab passes it explicitly rather than needing a second function.
 */
function statusCondition(filters: InvoiceFilters) {
  return filters.status ? eq(invoice.status, filters.status) : ne(invoice.status, "approved");
}

/** Owner-only. Every column, including every monetary one. */
export async function listInvoicesForOwner(
  actor: Actor,
  filters: InvoiceFilters = {},
): Promise<InvoiceRow[]> {
  const conditions = [eq(invoice.organizationId, actor.organizationId), statusCondition(filters)];
  if (filters.vendorId != null) {
    conditions.push(eq(invoice.vendorId, filters.vendorId));
  }
  const rows = await db
    .select()
    .from(invoice)
    .where(and(...conditions))
    .orderBy(desc(invoice.createdAt))
    .limit(filters.limit ?? 50);
  return rows.map(toInvoiceRow);
}

/**
 * Manager/staff-safe archive list [AR-7]. The SELECT's column list is
 * spelled out and deliberately does not name `total_gross`, `total_discount`,
 * `total_net`, `file_sha256`, `file_size_bytes`, or `file_path` — there is
 * nothing here to leak, by construction, not by a filter applied afterward.
 */
export async function listInvoicesRedacted(
  actor: Actor,
  filters: InvoiceFilters = {},
): Promise<InvoiceRowRedacted[]> {
  const conditions = [eq(invoice.organizationId, actor.organizationId), statusCondition(filters)];
  if (filters.vendorId != null) {
    conditions.push(eq(invoice.vendorId, filters.vendorId));
  }
  const rows = await db
    .select({
      id: invoice.id,
      organizationId: invoice.organizationId,
      vendorId: invoice.vendorId,
      status: invoice.status,
      source: invoice.source,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      invoiceNumber: invoice.invoiceNumber,
      currency: invoice.currency,
      retentionUntil: invoice.retentionUntil,
      createdAt: invoice.createdAt,
    })
    .from(invoice)
    .where(and(...conditions))
    .orderBy(desc(invoice.createdAt))
    .limit(filters.limit ?? 50);
  return rows;
}

// ---------------------------------------------------------------------------
// Lifecycle CAS
// ---------------------------------------------------------------------------

/**
 * Compare-and-set an invoice's status. `from` may be a single status or any
 * of several (mirrors `lib/domain/counts.ts`'s `transitionCount`). Illegal
 * edges (not present in `INVOICE_TRANSITIONS` from ANY of the given `from`
 * statuses) are refused before touching the database. A legal edge whose
 * current row doesn't actually match `from` — someone else moved it first —
 * raises `ConflictError`, never a silent no-op; this is also what makes a
 * stale client's second submit of the same transition safe to retry against.
 *
 * `SELECT ... FOR UPDATE` (not a bare `UPDATE ... WHERE status IN (...)`)
 * because the `reviewed` NULL-field guard needs the row's current values —
 * merged with any `data` this same call is also writing — to decide whether
 * the transition is even allowed, not just whether it's contended.
 */
export async function updateInvoiceStatus(
  actor: Actor,
  invoiceId: number,
  from: InvoiceStatus | InvoiceStatus[],
  to: InvoiceStatus,
  data: Partial<typeof invoice.$inferInsert> = {},
): Promise<InvoiceRow> {
  return db.transaction((tx) => updateInvoiceStatusTx(tx, actor, invoiceId, from, to, data));
}

/**
 * The CAS's own core, split out of `updateInvoiceStatus` — Phase 2.5, Slice 2
 * — so a caller that must hold this transition inside a LARGER transaction
 * (`lib/domain/invoice-lines.ts:submitInvoiceReview` applies the reviewer's
 * line corrections and this CAS atomically, so a conflict rolls both back
 * together rather than leaving corrections applied against an invoice that
 * never actually became `reviewed`) can do so, mirroring
 * `lib/domain/extraction.ts`'s `updateJobStatus`/`updateJobStatusTx` split.
 * `updateInvoiceStatus` above is now just this function plus a transaction
 * of its own.
 */
export async function updateInvoiceStatusTx(
  tx: Tx,
  actor: Actor,
  invoiceId: number,
  from: InvoiceStatus | InvoiceStatus[],
  to: InvoiceStatus,
  data: Partial<typeof invoice.$inferInsert> = {},
): Promise<InvoiceRow> {
  const fromList = Array.isArray(from) ? from : [from];
  const legalFromAny = fromList.some((candidate) => INVOICE_TRANSITIONS[candidate].includes(to));
  if (!legalFromAny) {
    throw new InvalidInvoiceTransitionError(
      `Cannot move an invoice from ${fromList.join(" or ")} to ${to}.`,
    );
  }

  const [row] = await tx
    .select()
    .from(invoice)
    .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)))
    .for("update");
  if (!row) {
    throw new NotFoundError("Invoice");
  }
  if (!fromList.includes(row.status)) {
    throw new ConflictError(
      `Invoice ${invoiceId} must be ${fromList.join(" or ")} to move to ${to}, but it is ${row.status}.`,
    );
  }

  if (to === "reviewed") {
    const merged: Record<string, unknown> = { ...row, ...data };
    const missing = REQUIRED_FOR_REVIEW.filter((field) => merged[field] == null);
    if (missing.length > 0) {
      throw new InvoiceNotWritableError(
        `Invoice ${invoiceId} cannot move to reviewed — missing: ${missing.join(", ")}.`,
      );
    }
  }

  await tx
    .update(invoice)
    // Every route to `rejected` runs through here, so this is the one place a
    // rejected invoice releases its claim on the file (F7). Spread AFTER `data`
    // so a caller cannot re-assert a claim on the way out.
    .set({ status: to, ...data, ...(to === "rejected" ? { liveFileSha256: null } : {}) })
    .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)));

  const [updated] = await tx
    .select()
    .from(invoice)
    .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)))
    .limit(1);
  if (!updated) {
    throw new NotFoundError("Invoice");
  }
  return toInvoiceRow(updated);
}

// ---------------------------------------------------------------------------
// Resend to extraction — Phase 2.5, Slice 2. The `rejected -> processing`
// re-extract entry point [AR-4].
// ---------------------------------------------------------------------------

export type ResendToExtractionResult =
  | { outcome: "resent"; invoice: InvoiceRow; extractionJobId: number }
  | { outcome: "duplicate"; duplicate: DuplicateInvoice };

/**
 * CAS `rejected -> processing` (or `needs_review -> processing` after a failed
 * extraction), then opens a NEW `extraction_job` row starting at `queued` —
 * never `awaiting_upload`, because the file behind this invoice was already
 * confirmed on disk the first time around and nothing here re-collects it
 * [AR-6]. The invoice's CAS and the job insert run in one transaction: a
 * conflict on the CAS must not leave an orphaned job queued against an invoice
 * that never actually re-entered `processing`.
 *
 * F7: a rejected invoice released its claim on the file, so another invoice may
 * have taken it since. An invoice holding no claim therefore takes it first
 * (`claimFileTx`, same transaction, before any state change); if someone else
 * holds it, nothing is changed and the holder is returned. An invoice that
 * already holds the claim (`needs_review`) keeps it and skips this.
 * `withLockRetry` re-runs the whole transaction on a deadlock or 1020; a
 * rolled-back attempt wrote neither a claim nor a job, so a re-run cannot
 * create two jobs.
 *
 * The PREVIOUS job row (whatever it ended at — normally `failed`, with its
 * `error_message`/`retry_count` intact) is never touched by this function.
 * That is deliberate, not an oversight: those columns are the diagnostic
 * record of why the first attempt failed, and this is a fresh attempt, not a
 * correction to the old one. Two job rows now exist for one invoice — see
 * `lib/domain/extraction.ts:getJobForInvoice`/`lockJobForUpload`'s
 * `ORDER BY id DESC` for why that is load-bearing there.
 */
export async function resendInvoiceToExtraction(
  actor: Actor,
  invoiceId: number,
): Promise<ResendToExtractionResult> {
  return withLockRetry(() =>
    db.transaction(async (tx): Promise<ResendToExtractionResult> => {
      // Lock the invoice row (org-scoped) first so a double click serialises:
      // the second call sees `processing` and is refused by the CAS below
      // instead of opening a second job.
      const [row] = await tx
        .select({
          status: invoice.status,
          fileSha256: invoice.fileSha256,
          liveFileSha256: invoice.liveFileSha256,
        })
        .from(invoice)
        .where(and(eq(invoice.id, invoiceId), eq(invoice.organizationId, actor.organizationId)))
        .for("update");
      if (!row) {
        throw new NotFoundError("Invoice");
      }

      if (row.status === "needs_review") {
        // Retry straight from needs_review (F8) is only for a failed extraction.
        // A needs_review invoice whose job succeeded is a real draft awaiting
        // review; re-extracting it would discard the reviewer's work.
        const [latestJob] = await tx
          .select({ status: extractionJob.status })
          .from(extractionJob)
          .where(
            and(eq(extractionJob.invoiceId, invoiceId), eq(extractionJob.organizationId, actor.organizationId)),
          )
          .orderBy(desc(extractionJob.id))
          .limit(1);
        if (latestJob?.status !== "failed") {
          throw new ConflictError(
            "This invoice was read successfully, so it can't be re-read. Review it, or reject it first to start over.",
          );
        }
      }

      // Only for a status the CAS below would accept; any other status falls
      // through to it and is refused as a Conflict, not as a "duplicate".
      if (row.liveFileSha256 == null && (row.status === "rejected" || row.status === "needs_review")) {
        const holder = await claimFileTx(tx, actor.organizationId, invoiceId, row.fileSha256);
        if (holder) {
          return { outcome: "duplicate", duplicate: holder };
        }
      }

      const updated = await updateInvoiceStatusTx(tx, actor, invoiceId, ["rejected", "needs_review"], "processing");

      const [job] = await tx
        .insert(extractionJob)
        .values({
          organizationId: actor.organizationId,
          invoiceId,
          status: "queued",
        })
        .$returningId();

      return { outcome: "resent", invoice: updated, extractionJobId: job.id };
    }),
  );
}

/**
 * Throws `NoInvoiceLinesError` when the invoice has no `invoice_line` rows.
 * Called INSIDE the caller's transaction, after its status CAS/lock, so a
 * failed extraction (which leaves zero lines in `needs_review`) can neither be
 * marked reviewed nor approved (F8). Org-scoped.
 */
export async function assertInvoiceHasLinesTx(tx: Tx, actor: Actor, invoiceId: number): Promise<void> {
  const [row] = await tx
    .select({ n: count() })
    .from(invoiceLine)
    .where(and(eq(invoiceLine.invoiceId, invoiceId), eq(invoiceLine.organizationId, actor.organizationId)));
  if (!row || Number(row.n) === 0) {
    throw new NoInvoiceLinesError(
      "This invoice has no line items, so it can't be reviewed or approved. Retry reading it, or reject it and upload a clearer copy.",
    );
  }
}

// ---------------------------------------------------------------------------
// Extraction outcome for the review page (F8)
// ---------------------------------------------------------------------------

/**
 * Maps a job's `error_code` to a message safe to show an owner. NEVER derived
 * from `error_message`, which is raw internal text (paths, env var names, SQL,
 * stack fragments). Unknown or null codes get the generic message.
 */
export function describeExtractionFailure(errorCode: string | null): string {
  switch (errorCode) {
    case "EXTRACTION_UNAVAILABLE":
      return "Scanned invoices can't be read right now. Try again later, or contact support if it keeps happening.";
    case "WORKER_TIMEOUT":
      return "Reading this invoice took too long and was stopped. Retry it; if it fails again, upload a clearer or smaller copy.";
    default:
      return "We couldn't read this invoice automatically. Retry it, or reject it and upload a clearer copy.";
  }
}

export interface InvoiceExtractionOutcome {
  /** Status of the newest extraction job; null if the invoice has none. */
  jobStatus: (typeof extractionJob.$inferSelect)["status"] | null;
  /** True only when the newest job is `failed`. */
  failed: boolean;
  /** Owner-safe plain-language message when `failed`, else null. */
  failureMessage: string | null;
  /** True when "Retry extraction" may be offered (needs_review with a failed job). */
  canRetry: boolean;
  lineCount: number;
}

/**
 * What the review page needs to explain an empty invoice and offer Retry.
 * Org-scoped: a foreign invoiceId is `NotFoundError`. Returns no raw error
 * text. Call it from an owner-gated server component or action (it carries no
 * money, but the page it serves is owner-only).
 */
export async function getInvoiceExtractionOutcome(
  actor: Actor,
  invoiceId: number,
): Promise<InvoiceExtractionOutcome> {
  const inv = await getInvoice(actor, invoiceId);
  const [job] = await db
    .select({ status: extractionJob.status, errorCode: extractionJob.errorCode })
    .from(extractionJob)
    .where(and(eq(extractionJob.invoiceId, invoiceId), eq(extractionJob.organizationId, actor.organizationId)))
    .orderBy(desc(extractionJob.id))
    .limit(1);
  const [lines] = await db
    .select({ n: count() })
    .from(invoiceLine)
    .where(and(eq(invoiceLine.invoiceId, invoiceId), eq(invoiceLine.organizationId, actor.organizationId)));
  const failed = job?.status === "failed";
  return {
    jobStatus: job?.status ?? null,
    failed,
    failureMessage: failed ? describeExtractionFailure(job.errorCode) : null,
    canRetry: failed && inv.status === "needs_review",
    lineCount: Number(lines?.n ?? 0),
  };
}
