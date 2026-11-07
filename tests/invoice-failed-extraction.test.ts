/**
 * QA finding F8 (docs/qa/2026-11-06-invoice-failures-handoff.md): a failed
 * extraction leaves an invoice in `needs_review` with ZERO lines, and it could
 * be reviewed and approved with a hand-typed total. Covers:
 *
 *   - `submitInvoiceReview` and `approveInvoice` refuse a zero-line invoice,
 *     inside their transaction, without breaking the approved-replay path;
 *   - `resendInvoiceToExtraction` retries directly from `needs_review`, but
 *     only when the newest extraction job FAILED, org-scoped and with no
 *     duplicate job under a double click;
 *   - the owner-safe failure message, derived from `error_code`, never from the
 *     raw `error_message`.
 *
 * Each guard is mutation-checked by hand: revert it and the named tests fail.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { invoice, invoiceLine, extractionJob, productCostHistory } from "@/db/schema";
import { submitInvoiceReview } from "@/lib/domain/invoice-lines";
import { approveInvoice } from "@/lib/domain/invoice-approval";
import {
  resendInvoiceToExtraction,
  getInvoiceExtractionOutcome,
  describeExtractionFailure,
} from "@/lib/domain/invoices";
import { ConflictError, NoInvoiceLinesError, NotFoundError } from "@/lib/domain/errors";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";
import { resendExpectingResent } from "./helpers/resend";

let fx: Fixtures;

beforeAll(async () => {
  await migrateTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fx = await createFixtures();
});

afterAll(async () => {
  await closePool();
});

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
}));

let sessionUserId: number | null = null;

mock.module("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => {
        if (sessionUserId == null) return null;
        return { session: { id: "mock-session" }, user: { id: String(sessionUserId) } };
      },
    },
  },
}));

const RAW_INTERNAL_TEXT =
  "ENOENT: /srv/truestock/storage/7/secret-file.pdf; ANTHROPIC_API_KEY=sk-ant-DO-NOT-LEAK; at Object.<anonymous> (stack)";

/** The fixture invoice as a failed extraction leaves it: needs_review, zero lines, job failed. */
async function makeFailedExtraction(errorCode: string | null = "PIPELINE_ERROR") {
  const invoiceId = fx.invoiceId;
  const jobId = fx.extractionJobId;
  await db.delete(invoiceLine).where(eq(invoiceLine.invoiceId, invoiceId));
  await db
    .update(extractionJob)
    .set({ status: "failed", errorMessage: RAW_INTERNAL_TEXT, errorCode, completedAt: new Date() })
    .where(eq(extractionJob.id, jobId));
}

async function jobsFor(invoiceId: number) {
  return db.select().from(extractionJob).where(eq(extractionJob.invoiceId, invoiceId));
}

async function statusOf(invoiceId: number) {
  const [row] = await db.select({ status: invoice.status }).from(invoice).where(eq(invoice.id, invoiceId));
  return row.status;
}

// ---------------------------------------------------------------------------
// a) zero-line refusal
// ---------------------------------------------------------------------------

describe("zero-line invoices cannot be reviewed or approved", () => {
  test("CONTROL: an invoice with lines still moves needs_review -> reviewed", async () => {
    const row = await submitInvoiceReview(fx.owner, fx.invoiceId, []);
    expect(row.status).toBe("reviewed");
  });

  test("submitInvoiceReview refuses a zero-line invoice and leaves it in needs_review", async () => {
    await makeFailedExtraction();
    await expect(submitInvoiceReview(fx.owner, fx.invoiceId, [])).rejects.toBeInstanceOf(NoInvoiceLinesError);
    expect(await statusOf(fx.invoiceId)).toBe("needs_review");
  });

  test("approveInvoice refuses a zero-line reviewed invoice, writes no cost history, and leaves it reviewed", async () => {
    await db.delete(invoiceLine).where(eq(invoiceLine.invoiceId, fx.invoiceId));
    await db.update(invoice).set({ status: "reviewed" }).where(eq(invoice.id, fx.invoiceId));

    await expect(approveInvoice(fx.owner, fx.invoiceId)).rejects.toBeInstanceOf(NoInvoiceLinesError);

    expect(await statusOf(fx.invoiceId)).toBe("reviewed");
    const history = await db.select().from(productCostHistory).where(eq(productCostHistory.sourceInvoiceId, fx.invoiceId));
    expect(history).toHaveLength(0);
  });

  test("approveInvoice still replays an already-approved invoice, even one with zero lines (the original success, not an error)", async () => {
    await db.delete(invoiceLine).where(eq(invoiceLine.invoiceId, fx.invoiceId));
    await db.update(invoice).set({ status: "approved", approvedAt: new Date(), approvedBy: fx.owner.userId }).where(eq(invoice.id, fx.invoiceId));

    const result = await approveInvoice(fx.owner, fx.invoiceId);
    expect(result.invoice.status).toBe("approved");
    expect(result.costLinesApplied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// b) retry from needs_review
// ---------------------------------------------------------------------------

describe("resendInvoiceToExtraction from needs_review", () => {
  test("a failed job: moves needs_review -> processing and opens exactly one new queued job, leaving the failed job's diagnostics", async () => {
    await makeFailedExtraction();

    const result = await resendExpectingResent(fx.owner, fx.invoiceId);

    expect(result.invoice.status).toBe("processing");
    const jobs = await jobsFor(fx.invoiceId);
    expect(jobs).toHaveLength(2);
    const fresh = jobs.find((j) => j.id === result.extractionJobId)!;
    expect(fresh.status).toBe("queued");
    const old = jobs.find((j) => j.id === fx.extractionJobId)!;
    expect(old.status).toBe("failed");
    expect(old.errorMessage).toBe(RAW_INTERNAL_TEXT);
  });

  test("a double click opens one job: two concurrent retries, exactly one succeeds", async () => {
    await makeFailedExtraction();

    const settled = await Promise.allSettled([
      resendInvoiceToExtraction(fx.owner, fx.invoiceId),
      resendInvoiceToExtraction(fx.owner, fx.invoiceId),
    ]);

    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    expect(await jobsFor(fx.invoiceId)).toHaveLength(2);
    expect(await statusOf(fx.invoiceId)).toBe("processing");
  });

  test("a sequential second retry is refused and opens no third job", async () => {
    await makeFailedExtraction();
    await resendInvoiceToExtraction(fx.owner, fx.invoiceId);
    await expect(resendInvoiceToExtraction(fx.owner, fx.invoiceId)).rejects.toBeInstanceOf(ConflictError);
    expect(await jobsFor(fx.invoiceId)).toHaveLength(2);
  });

  for (const jobStatus of ["done", "queued", "running"] as const) {
    test(`refused when the newest job is ${jobStatus} (not failed): no new job, invoice stays needs_review`, async () => {
      await db.update(extractionJob).set({ status: jobStatus }).where(eq(extractionJob.id, fx.extractionJobId));

      await expect(resendInvoiceToExtraction(fx.owner, fx.invoiceId)).rejects.toBeInstanceOf(ConflictError);

      expect(await jobsFor(fx.invoiceId)).toHaveLength(1);
      expect(await statusOf(fx.invoiceId)).toBe("needs_review");
    });
  }

  test("only the NEWEST job counts: an old failed job under a newer done job does not allow retry", async () => {
    await makeFailedExtraction();
    await db.insert(extractionJob).values({ organizationId: fx.organizationId, invoiceId: fx.invoiceId, status: "done" });

    await expect(resendInvoiceToExtraction(fx.owner, fx.invoiceId)).rejects.toBeInstanceOf(ConflictError);
    expect(await jobsFor(fx.invoiceId)).toHaveLength(2);
  });

  test("tenant isolation: another org's owner gets NotFound for a failed invoice, and no job is created", async () => {
    await makeFailedExtraction();

    await expect(resendInvoiceToExtraction(fx.otherOwner, fx.invoiceId)).rejects.toBeInstanceOf(NotFoundError);

    expect(await jobsFor(fx.invoiceId)).toHaveLength(1);
    expect(await statusOf(fx.invoiceId)).toBe("needs_review");
  });

  test("tenant isolation: this org's owner cannot retry the other org's failed invoice", async () => {
    await db
      .update(extractionJob)
      .set({ status: "failed", errorCode: "PIPELINE_ERROR" })
      .where(eq(extractionJob.id, fx.otherExtractionJobId));

    await expect(resendInvoiceToExtraction(fx.owner, fx.otherInvoiceId)).rejects.toBeInstanceOf(NotFoundError);

    expect(await jobsFor(fx.otherInvoiceId)).toHaveLength(1);
    expect(await statusOf(fx.otherInvoiceId)).toBe("needs_review");
  });
});

describe("resendToExtractionAction from needs_review", () => {
  test("owner can retry a failed extraction; manager and staff are refused with no job created", async () => {
    await makeFailedExtraction();
    const { resendToExtractionAction } = await import("@/app/actions/invoices");

    for (const actor of [fx.manager, fx.staff]) {
      sessionUserId = actor.userId;
      const refused = await resendToExtractionAction({ invoiceId: fx.invoiceId });
      expect(refused.ok).toBe(false);
    }
    expect(await jobsFor(fx.invoiceId)).toHaveLength(1);

    sessionUserId = fx.owner.userId;
    const result = await resendToExtractionAction({ invoiceId: fx.invoiceId });
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.outcome !== "resent") throw new Error("unreachable");
    expect(result.data.status).toBe("processing");
    expect(await jobsFor(fx.invoiceId)).toHaveLength(2);
  });

  test("owner is refused for a needs_review invoice whose job did not fail", async () => {
    const { resendToExtractionAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.owner.userId;
    const result = await resendToExtractionAction({ invoiceId: fx.invoiceId });
    expect(result.ok).toBe(false);
    expect(await jobsFor(fx.invoiceId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// c) owner-safe failure message
// ---------------------------------------------------------------------------

describe("owner-safe failure message", () => {
  test("a failed job yields a plain message from the error code, never the raw error text", async () => {
    await makeFailedExtraction();

    const outcome = await getInvoiceExtractionOutcome(fx.owner, fx.invoiceId);

    expect(outcome).toMatchObject({ jobStatus: "failed", failed: true, canRetry: true, lineCount: 0 });
    expect(outcome.failureMessage).toBe(describeExtractionFailure("PIPELINE_ERROR"));
    const serialized = JSON.stringify(outcome);
    for (const leak of ["ENOENT", "/srv/", "secret-file", "ANTHROPIC", "sk-ant", "stack"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  test("the missing-API-key code reads 'Scanned invoices can't be read right now' and names no env var", async () => {
    await makeFailedExtraction("EXTRACTION_UNAVAILABLE");

    const outcome = await getInvoiceExtractionOutcome(fx.owner, fx.invoiceId);

    expect(outcome.failureMessage).toContain("Scanned invoices can't be read right now");
    expect(outcome.failureMessage).not.toMatch(/ANTHROPIC|API_KEY|env/i);
  });

  test("a null or unknown code falls back to the generic message", () => {
    expect(describeExtractionFailure(null)).toBe(describeExtractionFailure("SOMETHING_NEW"));
    expect(describeExtractionFailure(null)).toContain("couldn't read this invoice");
  });

  test("a job that did not fail reports no failure and no retry", async () => {
    const outcome = await getInvoiceExtractionOutcome(fx.owner, fx.invoiceId);
    expect(outcome).toMatchObject({ jobStatus: "done", failed: false, failureMessage: null, canRetry: false });
    expect(outcome.lineCount).toBeGreaterThan(0);
  });

  test("tenant isolation: a foreign invoice is NotFound", async () => {
    await expect(getInvoiceExtractionOutcome(fx.owner, fx.otherInvoiceId)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("the action is owner-only", async () => {
    await makeFailedExtraction();
    const { getInvoiceExtractionOutcomeAction } = await import("@/app/actions/invoices");

    sessionUserId = fx.manager.userId;
    expect((await getInvoiceExtractionOutcomeAction({ invoiceId: fx.invoiceId })).ok).toBe(false);

    sessionUserId = fx.owner.userId;
    const result = await getInvoiceExtractionOutcomeAction({ invoiceId: fx.invoiceId });
    expect(result.ok).toBe(true);
  });
});
