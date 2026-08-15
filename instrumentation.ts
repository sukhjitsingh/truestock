/**
 * Process-lifecycle hook (Next.js 16, stable — no `experimental.instrumentationHook`
 * flag needed). `register()` runs once per server process, before any route
 * handler serves a request, in every runtime Next starts (`nodejs` AND `edge`
 * for middleware) — the `NEXT_RUNTIME` guard below is what keeps the cron out
 * of the edge runtime, which has neither `setInterval` semantics we want nor
 * a MySQL driver.
 *
 * This is Truestock's only cron: `processExtractionQueue` (extraction
 * pipeline, every 2 minutes) and `reapStuckJobs` (timeout sweep, every 5
 * minutes) — see `lib/domain/extraction-pipeline.ts` and
 * `lib/domain/extraction.ts` for the work itself. Nothing here is
 * authorization-relevant (mirrors `middleware.ts`'s own boundary): both
 * functions run as a system worker acting across every tenant by id, the same
 * "not a user-scoped read" design `extraction_job_status_id_idx` documents.
 *
 * ## Why a bounded loop lives HERE and not inside `processExtractionQueue`
 *
 * `processExtractionQueue` claims and runs exactly ONE job per call — a
 * deliberate shape (see that function's own comment) that keeps
 * "claim one job, run it, report its outcome" testable in isolation
 * (`job_claim_is_atomic` calls it directly and asserts exactly one of two
 * concurrent callers gets the job). 04-slices.md's "loop claimNextJob until
 * null or a per-tick cap (~5) is hit" is therefore satisfied at the CALLER —
 * this file — rather than by changing that function's contract: each tick
 * calls `processExtractionQueue` in a bounded loop, stopping at
 * `MAX_JOBS_PER_TICK` or the first `{claimed: false}`, whichever comes first.
 * The cap exists so one slow tick (several large PDFs claimed back to back)
 * can't run indefinitely and delay `reapStuckJobs`'s own interval from firing
 * — bounded, not starved.
 *
 * ## Failure isolation
 *
 * Every tick — the extraction loop and the reap sweep alike — runs inside its
 * own try/catch that only `console.error`s. `processExtractionQueue` and
 * `reapStuckJobs` already turn a claimed job's own failure into a recorded
 * `extraction_job.status = 'failed'` row rather than a thrown error (see
 * their own comments), so what lands here is the rarer case: a failure
 * BEFORE or AROUND a job claim (a dropped database connection, an unexpected
 * driver error) that would otherwise propagate out of the `setInterval`
 * callback and — because Node has no default handler for an exception thrown
 * from a timer callback other than crashing the process — take the whole
 * server down over one bad tick. A caught, logged tick is a missed two
 * minutes of extraction; an uncaught one is a full outage over an OCR hiccup.
 *
 * ## Dev HMR guard
 *
 * `next dev` re-evaluates this module on every server-side edit while the
 * Node process itself stays alive, which would otherwise stack a fresh pair
 * of `setInterval`s on every save with no way to reach the earlier ones to
 * clear them — a slow leak of duplicate cron workers that only shows up as
 * "extraction jobs are being claimed twice as often as expected" days later.
 * `globalThis` survives HMR (it's the same JS heap across module reloads),
 * so a flag stashed there is the one signal `register()` can check that a
 * previous invocation's intervals are still running.
 */
import { hostname } from "node:os";
import { processExtractionQueue } from "@/lib/domain/extraction-pipeline";
import { reapStuckJobs } from "@/lib/domain/extraction";

const EXTRACTION_TICK_MS = 2 * 60 * 1000;
const REAP_TICK_MS = 5 * 60 * 1000;

/** Bound on jobs claimed per extraction tick — see the file header. */
const MAX_JOBS_PER_TICK = 5;

const WORKER_ID = `${hostname()}-${process.pid}`;

declare global {
  // `var` is required here (TS ambient global declarations don't allow
  // `let`/`const`) — module-scoped `let`/`const` do not survive HMR anyway;
  // `globalThis` does.
  var __truestockCronRegistered: boolean | undefined;
}

async function extractionTick(): Promise<void> {
  try {
    for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
      const result = await processExtractionQueue(WORKER_ID);
      if (!result.claimed) {
        break;
      }
      if (result.outcome === "failed") {
        console.error(
          `[instrumentation] extraction job ${result.jobId} (invoice ${result.invoiceId}) failed: ${result.errorMessage}`,
        );
      }
    }
  } catch (err) {
    console.error("[instrumentation] extraction tick failed", err);
  }
}

async function reapTick(): Promise<void> {
  try {
    const { requeued, failed } = await reapStuckJobs();
    if (requeued > 0 || failed > 0) {
      console.error(`[instrumentation] reaped stuck jobs: ${requeued} requeued, ${failed} failed`);
    }
  } catch (err) {
    console.error("[instrumentation] reap tick failed", err);
  }
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  if (globalThis.__truestockCronRegistered) {
    return;
  }
  globalThis.__truestockCronRegistered = true;

  setInterval(() => {
    void extractionTick();
  }, EXTRACTION_TICK_MS);
  setInterval(() => {
    void reapTick();
  }, REAP_TICK_MS);
}
