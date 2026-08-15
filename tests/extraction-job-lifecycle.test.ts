/**
 * `extraction_job` lifecycle — Phase 2.5, Slice 2. The four adversarial tests
 * 04-slices.md names for the cron machinery in `lib/domain/extraction.ts`:
 * `job_claim_is_atomic`, `stuck_running_job_is_reaped`,
 * `reaped_job_fails_after_three_tries`, `job_transition_is_guarded`.
 *
 * Deliberately a SEPARATE file from `tests/invoice-write-path.test.ts` (which
 * already covers `claimNextJob`'s sequential "already running" case and
 * `updateJobStatus`'s stale-`from` ConflictError) — these four exercise the
 * genuinely concurrent claim race and the reap sweep, which need their own
 * setup (backdated `claimed_at`, multiple reap cycles) that would otherwise
 * clutter that file's Slice 1 upload/confirm narrative.
 *
 * Each test is written to fail against the uncorrected behaviour it covers —
 * see each test's own comment for what a broken implementation would do
 * instead.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { extractionJob } from "@/db/schema";
import { createInvoiceForUpload, markUploadConfirmed } from "@/lib/domain/invoices";
import { claimNextJob, updateJobStatus, reapStuckJobs } from "@/lib/domain/extraction";
import { InvalidExtractionTransitionError, ConflictError } from "@/lib/domain/errors";
import { writeInvoiceFile, sha256Hex } from "@/lib/storage/invoice-files";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";

let fx: Fixtures;

const STORAGE_DIR = "/tmp/truestock-extraction-job-lifecycle-test";

beforeAll(async () => {
  await migrateTestDatabase();
  process.env.INVOICE_STORAGE_DIR = STORAGE_DIR;
});

beforeEach(async () => {
  await resetDatabase();
  fx = await createFixtures();
});

afterAll(async () => {
  await closePool();
});

/** A confirmed upload — its `extraction_job` is `queued`, ready to claim. */
async function createQueuedJob(): Promise<{ invoiceId: number; jobId: number }> {
  const bytes = Buffer.from(`invoice-${Math.random()}`);
  const created = await createInvoiceForUpload(fx.owner, {
    source: "pdf",
    contentType: "application/pdf",
    fileSha256: sha256Hex(bytes),
    fileSizeBytes: bytes.byteLength,
  });
  await writeInvoiceFile(created.filePath!, bytes);
  await markUploadConfirmed(fx.owner, created.id);

  const [job] = await db.select().from(extractionJob).where(eq(extractionJob.invoiceId, created.id));
  return { invoiceId: created.id, jobId: job.id };
}

async function getJob(jobId: number) {
  const [row] = await db.select().from(extractionJob).where(eq(extractionJob.id, jobId));
  return row;
}

/** Backdates `claimed_at` so `reapStuckJobs` treats the job as stuck. */
async function backdateClaim(jobId: number, ageMs: number): Promise<void> {
  await db
    .update(extractionJob)
    .set({ claimedAt: new Date(Date.now() - ageMs) })
    .where(eq(extractionJob.id, jobId));
}

describe("job_claim_is_atomic", () => {
  test(
    "two workers claiming the SAME queued job concurrently — exactly one gets it, the other gets null, and the row ends up running for the winner only. " +
      "MUTATION-CHECKED reasoning: if the claim were a bare `SELECT` candidate followed by an unconditional `UPDATE ... WHERE id = :id` (no `AND status = 'queued'` re-assertion), both concurrent calls would find the same candidate and both would successfully set it to running for their own workerId — the second write silently overwriting the first's claimedBy with no error, which is a job run twice, not zero or one times.",
    async () => {
      const { jobId } = await createQueuedJob();

      const [a, b] = await Promise.all([claimNextJob("worker-a"), claimNextJob("worker-b")]);

      const results = [a, b];
      const winners = results.filter((r) => r !== null);
      const losers = results.filter((r) => r === null);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      const row = await getJob(jobId);
      expect(row.status).toBe("running");
      expect(row.claimedBy).toBe(winners[0]!.claimedBy);
      expect(["worker-a", "worker-b"]).toContain(row.claimedBy!);
    },
  );

  test("with only one job available, three concurrent claimants produce exactly one winner", async () => {
    const { jobId } = await createQueuedJob();

    const results = await Promise.all([
      claimNextJob("worker-1"),
      claimNextJob("worker-2"),
      claimNextJob("worker-3"),
    ]);

    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);

    const row = await getJob(jobId);
    expect(row.status).toBe("running");
  });
});

describe("stuck_running_job_is_reaped", () => {
  test(
    "a job claimed and then abandoned (worker died mid-extraction) is returned to queued by the sweep, and completes on the NEXT claim rather than staying stranded forever. " +
      "MUTATION-CHECKED reasoning: if reapStuckJobs only flipped `status` back to `queued` without also clearing `claimed_at`/`claimed_by`, a second sweep pass before the job is re-claimed would immediately treat it as stuck again off the same stale timestamp — this test's second assertion (claim + complete) is what actually proves the invoice is unstuck, not just that one column changed.",
    async () => {
      const { invoiceId, jobId } = await createQueuedJob();

      const claimed = await claimNextJob("worker-doomed");
      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe("running");

      // Simulate the worker dying mid-extraction: claimed_at is far older
      // than the sweep's threshold, and nothing ever moved the job to
      // done/failed.
      await backdateClaim(jobId, 20 * 60 * 1000); // 20 minutes old

      const result = await reapStuckJobs(10 * 60 * 1000); // 10-minute threshold
      expect(result.requeued).toBe(1);
      expect(result.failed).toBe(0);

      const reaped = await getJob(jobId);
      expect(reaped.status).toBe("queued");
      expect(reaped.retryCount).toBe(1);
      expect(reaped.claimedAt).toBeNull();
      expect(reaped.claimedBy).toBeNull();

      // The invoice is not stranded: a fresh worker can claim it and drive
      // it to completion.
      const reclaimed = await claimNextJob("worker-fresh");
      expect(reclaimed).not.toBeNull();
      expect(reclaimed!.invoiceId).toBe(invoiceId);
      expect(reclaimed!.status).toBe("running");

      const completed = await updateJobStatus(jobId, "running", "done");
      expect(completed.status).toBe("done");
    },
  );

  test("a running job younger than the threshold is left alone", async () => {
    const { jobId } = await createQueuedJob();
    await claimNextJob("worker-active");
    // claimed_at defaults to "now" — well within any reasonable threshold.

    const result = await reapStuckJobs(10 * 60 * 1000);
    expect(result.requeued).toBe(0);
    expect(result.failed).toBe(0);

    const row = await getJob(jobId);
    expect(row.status).toBe("running");
  });

  test("a queued (never-claimed) job is never touched by the sweep", async () => {
    const { jobId } = await createQueuedJob();

    const result = await reapStuckJobs(0); // even a zero threshold must not touch it
    expect(result.requeued).toBe(0);
    expect(result.failed).toBe(0);

    const row = await getJob(jobId);
    expect(row.status).toBe("queued");
  });
});

describe("reaped_job_fails_after_three_tries", () => {
  test(
    "a reliably-fatal PDF (stuck on every attempt) lands in failed on the third reap, not re-queued forever. " +
      "MUTATION-CHECKED reasoning: if the sweep didn't persist/consult retry_count (e.g. always re-queued a stuck job unconditionally), this loop would requeue-and-restick on every pass indefinitely, and the job would never reach a terminal state a human could act on.",
    async () => {
      const { jobId } = await createQueuedJob();

      // Cycle 1: claim, go stale, reap -> requeued, retryCount 1.
      await claimNextJob("worker-1");
      await backdateClaim(jobId, 20 * 60 * 1000);
      let result = await reapStuckJobs(10 * 60 * 1000);
      expect(result).toEqual({ requeued: 1, failed: 0 });
      expect((await getJob(jobId)).status).toBe("queued");
      expect((await getJob(jobId)).retryCount).toBe(1);

      // Cycle 2: claim again, go stale again, reap -> requeued, retryCount 2.
      await claimNextJob("worker-2");
      await backdateClaim(jobId, 20 * 60 * 1000);
      result = await reapStuckJobs(10 * 60 * 1000);
      expect(result).toEqual({ requeued: 1, failed: 0 });
      expect((await getJob(jobId)).status).toBe("queued");
      expect((await getJob(jobId)).retryCount).toBe(2);

      // Cycle 3: claim again, go stale again, reap -> retryCount would become
      // 3, which meets MAX_RETRIES_BEFORE_FAILED — the job fails instead of
      // requeuing.
      await claimNextJob("worker-3");
      await backdateClaim(jobId, 20 * 60 * 1000);
      result = await reapStuckJobs(10 * 60 * 1000);
      expect(result).toEqual({ requeued: 0, failed: 1 });

      const failedRow = await getJob(jobId);
      expect(failedRow.status).toBe("failed");
      expect(failedRow.retryCount).toBe(3);
      expect(failedRow.errorMessage).toBe("worker timeout");
      expect(failedRow.claimedAt).toBeNull();
      expect(failedRow.claimedBy).toBeNull();

      // A failed job is terminal: claimNextJob's predicate is status='queued',
      // so it is never picked up again, and a further sweep (nothing running)
      // leaves it untouched rather than resurrecting it.
      const claimAfterFailed = await claimNextJob("worker-4");
      expect(claimAfterFailed).toBeNull();

      const sweepAfterFailed = await reapStuckJobs(0);
      expect(sweepAfterFailed).toEqual({ requeued: 0, failed: 0 });
      expect((await getJob(jobId)).status).toBe("failed");
    },
  );
});

describe("job_transition_is_guarded", () => {
  test(
    "updateJobStatus(id, 'done', 'queued') throws even when the row genuinely IS 'done' right now — the lifecycle graph is checked before the row's actual state, not instead of it. " +
      "MUTATION-CHECKED reasoning: a CAS built only from `UPDATE ... WHERE status = :from` (no graph check) would happily perform this write, because the row really is 'done' — a job the lifecycle declares terminal would be silently un-terminated back onto the queue.",
    async () => {
      const { jobId } = await createQueuedJob();
      await claimNextJob("worker-1");
      const done = await updateJobStatus(jobId, "running", "done");
      expect(done.status).toBe("done");

      const attempt = updateJobStatus(jobId, "done", "queued");
      await expect(attempt).rejects.toBeInstanceOf(InvalidExtractionTransitionError);

      // Refused before ever touching the database — the row is still done,
      // not queued.
      const row = await getJob(jobId);
      expect(row.status).toBe("done");
    },
  );

  test("updateJobStatus(id, 'failed', 'running') is refused the same way — failed is terminal too", async () => {
    const { jobId } = await createQueuedJob();
    await claimNextJob("worker-1");
    const failed = await updateJobStatus(jobId, "running", "failed", { errorMessage: "boom" });
    expect(failed.status).toBe("failed");

    const attempt = updateJobStatus(jobId, "failed", "running");
    await expect(attempt).rejects.toBeInstanceOf(InvalidExtractionTransitionError);
  });

  test("an illegal edge is refused even against a row that doesn't currently match `from` at all — InvalidExtractionTransitionError, never ConflictError, since the edge itself is what's wrong", async () => {
    const { jobId } = await createQueuedJob();
    // Row is `queued` right now; `queued -> done` was never a declared edge.
    const attempt = updateJobStatus(jobId, "queued", "done");
    await expect(attempt).rejects.toBeInstanceOf(InvalidExtractionTransitionError);
    await expect(attempt).not.toBeInstanceOf(ConflictError as never);

    const row = await getJob(jobId);
    expect(row.status).toBe("queued");
  });
});
