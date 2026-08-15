/**
 * `extraction_job` lifecycle — Phase 2.5, Slice 1.
 *
 * [AR-6] ONE state machine, declared once as data (`db/enums.ts`'s
 * `extractionJobStatusEnum`) and driven through exactly two functions here:
 * `claimNextJob` (the cron's atomic claim) and `updateJobStatus` (every other
 * transition, CAS-guarded). Nothing else may write `extraction_job.status`.
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
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { extractionJob } from "@/db/schema";
import { extractionJobStatusEnum } from "@/db/enums";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";

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
 * Every OTHER `extraction_job` transition — CAS against a declared `from`,
 * never a silent no-op. Zero rows affected (the job doesn't exist, or is not
 * currently `from`) raises `ConflictError` rather than returning as though
 * the write happened; "the pipeline's own helper cannot bypass the
 * lifecycle" (04-slices.md, `job_transition_is_guarded`) is the point of this
 * function existing at all instead of callers writing `.set({status})`
 * directly.
 */
/**
 * The job belonging to one invoice, org-scoped.
 *
 * Exists so the upload route can ask "is this invoice still accepting bytes?"
 * without reaching past the domain layer into `extraction_job` itself, and so
 * a cross-tenant `invoiceId` produces the same `NotFoundError` every other
 * lookup does (invariant 9) rather than an answer confirming the row is real.
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
  return db.transaction(async (tx) => {
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
  });
}
