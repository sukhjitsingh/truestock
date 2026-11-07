/**
 * `extraction_job` lifecycle — Phase 2.5, Slice 1.
 *
 * [AR-6] ONE state machine, declared once as data (`db/enums.ts`'s
 * `extractionJobStatusEnum`) and driven through exactly three entry points
 * here: `claimNextJob` (the cron's atomic claim), `updateJobStatus` (every
 * other transition, CAS-guarded), and `reapStuckJobs` (the timeout sweep,
 * itself built on `updateJobStatus`'s CAS — not a fourth way to write
 * `status`). Nothing else may write `extraction_job.status`.
 *
 * Lifecycle: `awaiting_upload -> queued -> running -> done | failed`. A job
 * is created `awaiting_upload` (lib/domain/invoices.ts:createInvoiceForUpload)
 * and only becomes `queued` once `markUploadConfirmed` has verified the
 * uploaded object's byte length and SHA-256 against what was declared at
 * upload time — see that function's comment for why the comparison must
 * never be against a value the same write already produced.
 *
 * This module is deliberately NOT organization-scoped for the claim query:
 * `extraction_job_status_id_idx` (db/schema.ts) is `(status, id)`, not
 * `(organization_id, status, id)`, because the cron is a system worker
 * claiming across every tenant, not a user-scoped read. `updateJobStatus` is
 * likewise id-based — its callers (this module's own cron functions, and
 * lib/domain/invoices.ts's `markUploadConfirmed`, which ownership-checks the
 * job row itself before calling this) are the ones responsible for having
 * resolved the id through a trustworthy path.
 */
import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { extractionJob } from "@/db/schema";
import { extractionJobStatusEnum } from "@/db/enums";
import {
  ConflictError,
  InvalidExtractionTransitionError,
  InvoiceNotWritableError,
  NotFoundError,
} from "@/lib/domain/errors";

/** `reapStuckJobs`'s default timeout — 10 minutes. See that function's comment. */
const DEFAULT_STALE_AFTER_MS = 600_000;

/** A job moves `running -> failed` (rather than another retry) once it has been reaped this many times. */
const MAX_RETRIES_BEFORE_FAILED = 3;

/**
 * [AR-6] The lifecycle, declared once as data — same shape and same reason as
 * `lib/domain/invoices.ts`'s `INVOICE_TRANSITIONS`. `queued -> running` is
 * listed even though `claimNextJob` normally drives that edge through its own
 * hardcoded atomic `UPDATE`, not through `updateJobStatusTx` — it stays a
 * legal edge here too so a test (or a future caller) exercising the same
 * transition through the generic CAS path is not refused a transition that
 * IS legal, just not the primitive that usually performs it.
 *
 * `running -> queued` is the reap sweep's retry edge (`reapStuckJobs`), not a
 * user-facing one. `done` and `failed` are both terminal — nothing transitions
 * out of either, mirroring `approved`'s terminality on the invoice machine.
 */
const EXTRACTION_JOB_TRANSITIONS: Record<ExtractionJobStatus, readonly ExtractionJobStatus[]> = {
  awaiting_upload: ["queued"],
  queued: ["running"],
  running: ["done", "failed", "queued"],
  done: [],
  failed: [],
};

/**
 * The transaction handle `db.transaction` hands its callback. Derived rather
 * than imported so it cannot drift from the actual driver/dialect pairing.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ExtractionJobStatus = (typeof extractionJobStatusEnum)[number];

export interface ExtractionJobRow {
  id: number;
  organizationId: number;
  invoiceId: number;
  status: ExtractionJobStatus;
  phase: (typeof extractionJob.$inferSelect)["phase"];
  pdfType: (typeof extractionJob.$inferSelect)["pdfType"];
  pagesNeedingOcr: number[] | null;
  errorMessage: string | null;
  claimedAt: Date | null;
  claimedBy: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  retryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function toJobRow(row: typeof extractionJob.$inferSelect): ExtractionJobRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    invoiceId: row.invoiceId,
    status: row.status,
    phase: row.phase,
    pdfType: row.pdfType,
    pagesNeedingOcr: row.pagesNeedingOcr ?? null,
    errorMessage: row.errorMessage,
    claimedAt: row.claimedAt,
    claimedBy: row.claimedBy,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    retryCount: row.retryCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The cron's atomic claim: the OLDEST `queued` job becomes `running` for
 * `workerId`, or nothing does.
 *
 * Two steps rather than one combined `UPDATE ... ORDER BY id LIMIT 1` — the
 * probe SELECT finds a *candidate* id, and the UPDATE re-asserts
 * `status = 'queued'` on that specific id as its own CAS. Zero rows affected
 * there means another worker won the race for that same candidate; this
 * returns `null` rather than retrying, matching db/schema.ts's
 * `extractionJob` comment ("zero rows affected means another worker won the
 * race, not an error") — the next cron tick will pick up whatever is still
 * `queued`.
 *
 * A job in `awaiting_upload` can never be returned here: the WHERE clause
 * only ever matches `status = 'queued'`.
 */
export async function claimNextJob(workerId: string): Promise<ExtractionJobRow | null> {
  const [candidate] = await db
    .select({ id: extractionJob.id })
    .from(extractionJob)
    .where(eq(extractionJob.status, "queued"))
    .orderBy(asc(extractionJob.id))
    .limit(1);
  if (!candidate) {
    return null;
  }

  const now = new Date();
  const result = await db
    .update(extractionJob)
    .set({ status: "running", claimedAt: now, claimedBy: workerId, startedAt: now })
    .where(and(eq(extractionJob.id, candidate.id), eq(extractionJob.status, "queued")));
  if (result[0].affectedRows === 0) {
    // Lost the race for this candidate between the probe and the claim.
    return null;
  }

  const [row] = await db.select().from(extractionJob).where(eq(extractionJob.id, candidate.id)).limit(1);
  if (!row) {
    throw new NotFoundError("Extraction job");
  }
  return toJobRow(row);
}

/**
 * The job belonging to one invoice, org-scoped.
 *
 * Exists so the upload route can ask "is this invoice still accepting bytes?"
 * without reaching past the domain layer into `extraction_job` itself, and so
 * a cross-tenant `invoiceId` produces the same `NotFoundError` every other
 * lookup does (invariant 9) rather than an answer confirming the row is real.
 *
 * `ORDER BY id DESC LIMIT 1` — Phase 2.5, Slice 2's
 * `lib/domain/invoices.ts:resendInvoiceToExtraction` is the first thing that
 * can make more than one `extraction_job` row exist for one invoice (a fresh
 * attempt after a rejection, deliberately leaving the old row's diagnostics
 * alone). Before that, one invoice ever had exactly one job, so this ordering
 * was unobservable; now the newest row is the only one that answers "is this
 * invoice still accepting bytes" correctly.
 */
export async function getJobForInvoice(
  organizationId: number,
  invoiceId: number,
): Promise<ExtractionJobRow> {
  const [row] = await db
    .select()
    .from(extractionJob)
    .where(
      and(eq(extractionJob.invoiceId, invoiceId), eq(extractionJob.organizationId, organizationId)),
    )
    .orderBy(desc(extractionJob.id))
    .limit(1);
  if (!row) {
    throw new NotFoundError("Extraction job");
  }
  return toJobRow(row);
}

export async function updateJobStatus(
  id: number,
  from: ExtractionJobStatus,
  to: ExtractionJobStatus,
  data: Partial<typeof extractionJob.$inferInsert> = {},
): Promise<ExtractionJobRow> {
  return db.transaction((tx) => updateJobStatusTx(tx, id, from, to, data));
}

/**
 * Every OTHER `extraction_job` transition — graph-guarded, THEN CAS against a
 * declared `from`, never a silent no-op.
 *
 * Two separate refusals, deliberately not collapsed into one:
 *   1. `(from, to)` must be a legal edge in `EXTRACTION_JOB_TRANSITIONS`,
 *      checked BEFORE touching the database. This is what makes
 *      `updateJobStatus(id, 'done', 'queued')` throw even when the row
 *      genuinely is `done` right now — "the row happens to currently be
 *      `from`" and "this edge is one the lifecycle allows" are different
 *      questions, and a CAS alone only ever answers the first one
 *      (04-slices.md, `job_transition_is_guarded`).
 *   2. Zero rows affected by the `UPDATE` (the job doesn't exist, or isn't
 *      currently `from` even though the edge itself is legal) raises
 *      `ConflictError` — someone else moved it first, never treated as
 *      though this write happened.
 *
 * Exists so a caller that must hold `lockJobForUpload`'s row lock across
 * several steps can still perform the transition through THIS module rather
 * than issuing its own `.set({ status })` — AR-6's "nothing else may write
 * `extraction_job.status`" is a rule about there being one implementation,
 * not about there being one transaction. `updateJobStatus` above is now just
 * this function plus a transaction of its own.
 */
export async function updateJobStatusTx(
  tx: Tx,
  id: number,
  from: ExtractionJobStatus,
  to: ExtractionJobStatus,
  data: Partial<typeof extractionJob.$inferInsert> = {},
): Promise<ExtractionJobRow> {
  if (!EXTRACTION_JOB_TRANSITIONS[from].includes(to)) {
    throw new InvalidExtractionTransitionError(
      `Cannot move an extraction job from ${from} to ${to}.`,
    );
  }

  const result = await tx
    .update(extractionJob)
    .set({ status: to, ...data })
    .where(and(eq(extractionJob.id, id), eq(extractionJob.status, from)));
  if (result[0].affectedRows === 0) {
    throw new ConflictError(`Extraction job ${id} is not ${from}.`);
  }
  const [row] = await tx.select().from(extractionJob).where(eq(extractionJob.id, id)).limit(1);
  if (!row) {
    throw new NotFoundError("Extraction job");
  }
  return toJobRow(row);
}

/**
 * Takes the `extraction_job` row's write lock for one invoice and holds it
 * for the duration of `body`.
 *
 * This is the serialization point between the two operations that race over
 * an invoice's bytes: the `PUT` that writes them and the `confirmUploadAction`
 * that hashes them. Both must run under this lock, or the check each performs
 * describes a file the other is concurrently replacing.
 *
 * The race it closes, which a status check alone does not: two `PUT`s for one
 * invoice are both in flight, both observe `awaiting_upload` and both pass.
 * A lands first; confirm hashes A's bytes, matches the declared SHA-256, and
 * CAS's the job to `queued`. B — already past the check — lands afterward and
 * overwrites the verified file. `file_sha256` still describes A's bytes, the
 * row reads confirmed, and only the archived document disagrees. Nothing ever
 * re-hashes it, so it surfaces years later in an audit packet against a
 * document under statutory retention.
 *
 * Note what a row lock does and does not buy here. Between two `PUT`s alone
 * it changes nothing — a `PUT` mutates no state the other would observe, so
 * both still see `awaiting_upload` and the last writer still wins, which is
 * the correct semantics for a retry. What it buys is ordering against
 * *confirm*: with both sides holding it, confirm's read-hash-CAS can no
 * longer interleave with a write, so either confirm runs first and B is then
 * refused with the job at `queued`, or B's bytes land first and confirm
 * hashes what is actually on disk. Both orderings are correct; the
 * interleaving was the only wrong one.
 *
 * A filesystem write runs inside this transaction, which is normally worth
 * avoiding. It is bounded at 25 MB to local disk (`MAX_INVOICE_BYTES`), and
 * the request body has already been fully read before the lock is taken, so
 * the lock is never held across the network.
 */
export async function lockJobForUpload<T>(
  organizationId: number,
  invoiceId: number,
  body: (job: ExtractionJobRow, tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // `ORDER BY id DESC LIMIT 1` — same reasoning as `getJobForInvoice`
    // above: Slice 2's `resendInvoiceToExtraction` can leave more than one
    // job row per invoice, and only the newest is the one a concurrent
    // upload/confirm should be serializing against. `LIMIT 1` also bounds
    // this to locking exactly one row rather than every job this invoice has
    // ever had.
    const [row] = await tx
      .select()
      .from(extractionJob)
      .where(
        and(
          eq(extractionJob.invoiceId, invoiceId),
          eq(extractionJob.organizationId, organizationId),
        ),
      )
      .orderBy(desc(extractionJob.id))
      .limit(1)
      .for("update");
    if (!row) {
      throw new NotFoundError("Extraction job");
    }
    return body(toJobRow(row), tx);
  });
}

/**
 * `lockJobForUpload` plus the assertion that the invoice is still accepting
 * bytes. Separated so `markUploadConfirmed` can take the same lock without
 * the assertion — confirm is legitimate against a job that has already left
 * `awaiting_upload` (it replays as a no-op), whereas a write is not.
 */
export async function withUploadSlot<T>(
  organizationId: number,
  invoiceId: number,
  write: () => Promise<T>,
): Promise<T> {
  return lockJobForUpload(organizationId, invoiceId, async (job) => {
    if (job.status !== "awaiting_upload") {
      throw new InvoiceNotWritableError(
        `Invoice ${invoiceId} has already been uploaded and verified.`,
      );
    }
    return write();
  });
}

/**
 * [AR-6] The missing edge back out of `running`. A worker that dies
 * mid-extraction (deploy, OOM on a 10-page scan, process restart) otherwise
 * strands its job in `running` forever: `claimNextJob`'s predicate is
 * `status = 'queued'`, so nothing ever re-claims it, and the owning invoice
 * shows `processing` indefinitely with no error surfaced anywhere.
 *
 * Every `running` job whose `claimed_at` is older than `staleAfterMs`
 * (default 10 minutes) is swept:
 *   - `retry_count` is incremented. If the incremented count is still below
 *     the limit, the job returns to `queued` — the next `claimNextJob` call
 *     picks it up and re-runs the pipeline from the top.
 *   - Once the incremented count reaches `MAX_RETRIES_BEFORE_FAILED` (3), the
 *     job moves to `failed` instead, with `error_message = 'worker timeout'`
 *     — a reliably-fatal document (corrupt PDF, a page that hangs the
 *     classifier) must stop re-entering the queue on every sweep rather than
 *     looping forever.
 *
 * `claimed_at` / `claimed_by` are cleared either way: once a job is out of
 * `running`, whichever worker last held it is no longer meaningful — a
 * `queued` job is about to be claimed fresh, and a `failed` job's useful
 * diagnostic is `error_message` + `retry_count`, not a stale worker id.
 *
 * Re-running the pipeline after a reap is safe: `lib/domain/invoice-lines.ts`
 * `writeExtractedLines` deletes and re-inserts an invoice's drafts as one
 * unit, and this can only ever run BEFORE the owning invoice reaches
 * `needs_review` (no job that already wrote drafts and finished is still
 * `running`), so there is nothing downstream for a reclaim to disturb.
 *
 * Each job's CAS runs independently, after a single probe `SELECT` — the
 * same two-step shape as `claimNextJob`, for the same reason: a sweep and a
 * worker's own completion can race (the job finishes and moves to `done`
 * between this function's probe and its CAS), and losing that race for one
 * job must not abort the sweep for every other stuck job it already found.
 * A `ConflictError` from that race is swallowed for exactly that reason; any
 * other error propagates, since it does not represent "someone else already
 * handled this."
 */
export async function reapStuckJobs(
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): Promise<{ requeued: number; failed: number }> {
  const cutoff = new Date(Date.now() - staleAfterMs);

  const stuck = await db
    .select({ id: extractionJob.id, retryCount: extractionJob.retryCount })
    .from(extractionJob)
    .where(
      and(
        eq(extractionJob.status, "running"),
        // `claimed_at < cutoff` alone would never match a NULL claimed_at
        // (SQL's `NULL < x` is unknown, not true) — currently unreachable,
        // since claimNextJob's atomic UPDATE always sets claimed_at in the
        // same statement that sets status to running, but the transition
        // graph's own comment allows queued -> running through the generic
        // CAS path too, which has no such guarantee. Defense in depth: a
        // running job with no claimed_at is stuck by definition and must
        // still be reaped, not silently skipped forever.
        or(lt(extractionJob.claimedAt, cutoff), isNull(extractionJob.claimedAt)),
      ),
    );

  let requeued = 0;
  let failed = 0;

  for (const job of stuck) {
    const nextRetryCount = job.retryCount + 1;
    try {
      if (nextRetryCount >= MAX_RETRIES_BEFORE_FAILED) {
        await updateJobStatus(job.id, "running", "failed", {
          retryCount: nextRetryCount,
          errorMessage: "worker timeout",
          errorCode: "WORKER_TIMEOUT",
          claimedAt: null,
          claimedBy: null,
          completedAt: new Date(),
        });
        failed += 1;
      } else {
        await updateJobStatus(job.id, "running", "queued", {
          retryCount: nextRetryCount,
          claimedAt: null,
          claimedBy: null,
        });
        requeued += 1;
      }
    } catch (err) {
      if (err instanceof ConflictError) {
        continue;
      }
      throw err;
    }
  }

  return { requeued, failed };
}
