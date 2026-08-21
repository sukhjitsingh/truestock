/**
 * Invoice review path — Phase 2.5, Slice 2 (docs/plans/phase-2.5-invoice-automation).
 *
 * Covers the layer Slice 1 left as forward-reference comments:
 * `getLinesForInvoice`, `applyLineReview`/`submitInvoiceReview` [AR-2],
 * `resendInvoiceToExtraction` [AR-4/AR-6], and the three new server actions
 * (`reviewInvoiceAction`, `rejectInvoiceAction`, `resendToExtractionAction`)
 * plus `getInvoiceLinesAction`. The job-lifecycle adversarial tests named in
 * 04-slices.md's Slice 2 section (`job_claim_is_atomic`,
 * `stuck_running_job_is_reaped`, `reaped_job_fails_after_three_tries`,
 * `job_transition_is_guarded`) already live in
 * `tests/extraction-job-lifecycle.test.ts` and are deliberately not repeated
 * here.
 *
 * Every test here is written to fail against the uncorrected behaviour it
 * covers; MUTATION-CHECKED tests have been verified by hand against the
 * specific mutation named in the test title.
 *
 * Session mocking follows `tests/invoice-write-path.test.ts`'s convention:
 * `next/headers` and `@/lib/auth` are mocked at module scope, and the
 * action modules under test are imported dynamically (inside each test) so
 * the mocks are in place first.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { invoice, invoiceLine, extractionJob } from "@/db/schema";
import { getLinesForInvoice, applyLineReview, submitInvoiceReview } from "@/lib/domain/invoice-lines";
import { updateInvoiceStatus, resendInvoiceToExtraction, createInvoiceForUpload } from "@/lib/domain/invoices";
import { getJobForInvoice } from "@/lib/domain/extraction";
import { NotFoundError, ConflictError, DomainError, InvoiceNotWritableError } from "@/lib/domain/errors";
import {
  migrateTestDatabase,
  resetDatabase,
  createFixtures,
  createInvoiceMissingHeaderField,
  type Fixtures,
} from "./helpers/test-db";

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

// ---------------------------------------------------------------------------
// Session mocks for the action-layer tests below.
// ---------------------------------------------------------------------------

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

async function selectLine(id: number) {
  const [row] = await db.select().from(invoiceLine).where(eq(invoiceLine.id, id));
  return row;
}

async function selectInvoice(id: number) {
  const [row] = await db.select().from(invoice).where(eq(invoice.id, id));
  return row;
}

// ---------------------------------------------------------------------------
// getLinesForInvoice
// ---------------------------------------------------------------------------

describe("getLinesForInvoice", () => {
  test("returns every line for the invoice, in line_number order", async () => {
    const lines = await getLinesForInvoice(fx.owner, fx.invoiceId);

    expect(lines.map((l) => l.id)).toEqual([fx.invoiceLineId, fx.matchedInvoiceLineId]);
    expect(lines[0].lineNumber).toBeLessThan(lines[1].lineNumber);
  });

  test(
    "a cross-tenant invoiceId is refused with NotFoundError, never an empty array — MUTATION-CHECKED: dropping the invoice ownership pre-check (and leaving only the invoiceLine.organizationId filter) still returns [] instead of throwing, which is indistinguishable from a real invoice with zero lines",
    async () => {
      const attempt = getLinesForInvoice(fx.owner, fx.otherInvoiceId);
      await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
    },
  );

  test("an unknown invoiceId also returns NotFoundError", async () => {
    const attempt = getLinesForInvoice(fx.owner, 999999);
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// applyLineReview / applyLineReviewTx — AR-2's batch ownership check
// ---------------------------------------------------------------------------

describe("applyLineReview", () => {
  test("updates the raw money columns and stamps reviewedBy/reviewedAt", async () => {
    await applyLineReview(fx.owner, fx.invoiceId, [
      { id: fx.invoiceLineId, rawGross: "300.00", rawDiscount: "5.00", rawNet: "295.00" },
    ]);

    const row = await selectLine(fx.invoiceLineId);
    expect(row.rawGross).toBe("300.00");
    expect(row.rawDiscount).toBe("5.00");
    expect(row.rawNet).toBe("295.00");
    expect(row.reviewedBy).toBe(fx.owner.userId);
    expect(row.reviewedAt).not.toBeNull();
  });

  test("setting matchedProductId derives matchMethod = manual and clears the 'unmatched item' badge", async () => {
    // fx.invoiceLineId starts unmatched with ["unmatched item"].
    await applyLineReview(fx.owner, fx.invoiceId, [
      { id: fx.invoiceLineId, matchedProductId: fx.secondProductId },
    ]);

    const row = await selectLine(fx.invoiceLineId);
    expect(row.matchedProductId).toBe(fx.secondProductId);
    expect(row.matchMethod).toBe("manual");
    expect(row.exceptionFlags ?? []).not.toContain("unmatched item");
  });

  test("clearing matchedProductId (explicit null) derives matchMethod = unmatched and re-adds the 'unmatched item' badge", async () => {
    // fx.matchedInvoiceLineId starts manual-matched to pricedProductId with no exceptions.
    await applyLineReview(fx.owner, fx.invoiceId, [{ id: fx.matchedInvoiceLineId, matchedProductId: null }]);

    const row = await selectLine(fx.matchedInvoiceLineId);
    expect(row.matchedProductId).toBeNull();
    expect(row.matchMethod).toBe("unmatched");
    expect(row.exceptionFlags ?? []).toContain("unmatched item");
  });

  test(
    "[AR-2] a matchedProductId belonging to another tenant is refused, and the line is left completely untouched — MUTATION-CHECKED: removing the batch product-ownership SELECT lets the cross-tenant id through and the FK (which has no app-level trust per db/schema.ts's own comment) does not stop it",
    async () => {
      const attempt = applyLineReview(fx.owner, fx.invoiceId, [
        { id: fx.invoiceLineId, matchedProductId: fx.otherProductId },
      ]);
      await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

      const row = await selectLine(fx.invoiceLineId);
      expect(row.matchedProductId).toBeNull();
      expect(row.matchMethod).toBe("unmatched");
    },
  );

  test("a line id belonging to a DIFFERENT invoice in the same org is refused — a foreign key proves the row exists, not that this review may touch it", async () => {
    const secondInvoice = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: "a".repeat(64),
      fileSizeBytes: 5,
    });
    const [strayLine] = await db
      .insert(invoiceLine)
      .values({
        organizationId: fx.organizationId,
        invoiceId: secondInvoice.id,
        lineNumber: 1,
        description: "Stray line on a different invoice",
        lineType: "product",
        matchMethod: "unmatched",
      })
      .$returningId();

    const attempt = applyLineReview(fx.owner, fx.invoiceId, [{ id: strayLine.id, rawGross: "1.00" }]);
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

    const row = await selectLine(strayLine.id);
    expect(row.rawGross).toBeNull();
  });

  test("a line id belonging to a different tenant is refused, and nothing is written", async () => {
    const attempt = applyLineReview(fx.owner, fx.invoiceId, [{ id: fx.otherInvoiceLineId, rawGross: "1.00" }]);
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

    const row = await selectLine(fx.otherInvoiceLineId);
    expect(row.rawGross).not.toBe("1.00");
  });

  test(
    "the ownership check runs BEFORE any row is written — a batch where only the SECOND correction is invalid leaves the FIRST one's target untouched too — MUTATION-CHECKED: writing rows in a loop without the up-front batch SELECT would apply the first correction before failing on the second",
    async () => {
      const attempt = applyLineReview(fx.owner, fx.invoiceId, [
        { id: fx.invoiceLineId, rawGross: "999.00" },
        { id: fx.matchedInvoiceLineId, matchedProductId: fx.otherProductId },
      ]);
      await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

      const untouched = await selectLine(fx.invoiceLineId);
      expect(untouched.rawGross).toBe("294.00");
    },
  );
});

// ---------------------------------------------------------------------------
// submitInvoiceReview — the CAS + corrections composed atomically
// ---------------------------------------------------------------------------

describe("submitInvoiceReview", () => {
  test("applies corrections and moves the invoice needs_review -> reviewed", async () => {
    const result = await submitInvoiceReview(fx.owner, fx.invoiceId, [
      { id: fx.invoiceLineId, matchedProductId: fx.secondProductId },
    ]);

    expect(result.status).toBe("reviewed");
    const row = await selectLine(fx.invoiceLineId);
    expect(row.matchedProductId).toBe(fx.secondProductId);
  });

  test("corrections may be an empty array — a reviewer who changed nothing can still move the invoice forward", async () => {
    const result = await submitInvoiceReview(fx.owner, fx.invoiceId, []);
    expect(result.status).toBe("reviewed");
  });

  test(
    "review_conflicts_when_status_moved — the CAS affects zero rows when the invoice moved on, raises ConflictError, and rolls back the line corrections too rather than stranding them — MUTATION-CHECKED: catching updateInvoiceStatusTx's ConflictError inside submitInvoiceReview (or running the correction and the CAS in separate transactions) lets rawGross land on a line whose invoice never actually reached reviewed",
    async () => {
      // Someone else rejects the invoice after this reviewer loaded the screen.
      await updateInvoiceStatus(fx.owner, fx.invoiceId, "needs_review", "rejected", {
        rejectionReason: "duplicate of an earlier invoice",
      });

      const attempt = submitInvoiceReview(fx.owner, fx.invoiceId, [
        { id: fx.invoiceLineId, rawGross: "999.00" },
      ]);
      await expect(attempt).rejects.toBeInstanceOf(ConflictError);

      const line = await selectLine(fx.invoiceLineId);
      expect(line.rawGross).toBe("294.00");
      const inv = await selectInvoice(fx.invoiceId);
      expect(inv.status).toBe("rejected");
    },
  );
});

// ---------------------------------------------------------------------------
// submitInvoiceReview — header-field corrections (open item #32)
// ---------------------------------------------------------------------------

describe("submitInvoiceReview — header corrections (open item #32)", () => {
  test(
    "a NULL currency still blocks needs_review -> reviewed when no header correction is supplied, naming the field in the error",
    async () => {
      const invoiceId = await createInvoiceMissingHeaderField(fx.organizationId, "currency");

      const attempt = submitInvoiceReview(fx.owner, invoiceId, []);
      await expect(attempt).rejects.toBeInstanceOf(InvoiceNotWritableError);
      await expect(attempt).rejects.toThrow(/currency/);

      const row = await selectInvoice(invoiceId);
      expect(row.status).toBe("needs_review");
      expect(row.currency).toBeNull();
    },
  );

  test(
    "supplying the missing currency as a headerCorrection lets the SAME submit reach reviewed, with the corrected value persisted",
    async () => {
      const invoiceId = await createInvoiceMissingHeaderField(fx.organizationId, "currency");

      // Called directly at the domain layer, bypassing
      // `headerCorrectionSchema`'s own uppercase normalization — that
      // normalization is a Zod-boundary concern, asserted separately below in
      // `reviewInvoiceAction`'s own describe block, which goes through the
      // real schema. The domain function itself persists whatever string it
      // is handed.
      const result = await submitInvoiceReview(fx.owner, invoiceId, [], { currency: "USD" });

      expect(result.status).toBe("reviewed");
      expect(result.currency).toBe("USD");
      const row = await selectInvoice(invoiceId);
      expect(row.status).toBe("reviewed");
      expect(row.currency).toBe("USD");
    },
  );

  test(
    "a NULL invoiceNumber is likewise blocked with no correction and unblocked once corrected — proves this isn't currency-specific",
    async () => {
      const invoiceId = await createInvoiceMissingHeaderField(fx.organizationId, "invoiceNumber");

      const blocked = submitInvoiceReview(fx.owner, invoiceId, []);
      await expect(blocked).rejects.toBeInstanceOf(InvoiceNotWritableError);
      await expect(blocked).rejects.toThrow(/invoiceNumber/);

      const result = await submitInvoiceReview(fx.owner, invoiceId, [], { invoiceNumber: "CORRECTED-001" });
      expect(result.status).toBe("reviewed");
      expect(result.invoiceNumber).toBe("CORRECTED-001");
    },
  );

  test(
    "correcting invoiceDate alone (retentionUntil NOT supplied) derives retentionUntil via computeRetentionUntil, rather than leaving it NULL and blocking the transition",
    async () => {
      const invoiceId = await createInvoiceMissingHeaderField(fx.organizationId, "invoiceDate");
      // This fixture only has invoiceDate NULL — retentionUntil starts NULL too,
      // since the pipeline itself can never derive one without a date.
      await db.update(invoice).set({ retentionUntil: null }).where(eq(invoice.id, invoiceId));

      const result = await submitInvoiceReview(fx.owner, invoiceId, [], { invoiceDate: "2026-01-01" });

      expect(result.status).toBe("reviewed");
      expect(result.invoiceDate).toBe("2026-01-01");
      expect(result.retentionUntil).toBe("2029-01-01");
    },
  );
});

// ---------------------------------------------------------------------------
// resendInvoiceToExtraction — the rejected -> processing re-extract entry point
// ---------------------------------------------------------------------------

describe("resendInvoiceToExtraction", () => {
  test("opens a new queued extraction_job and moves the invoice rejected -> processing, leaving the old job's error_message/retry_count untouched", async () => {
    await updateInvoiceStatus(fx.owner, fx.invoiceId, "needs_review", "rejected", {
      rejectionReason: "bad scan, re-upload requested",
    });
    await db
      .update(extractionJob)
      .set({ errorMessage: "sentinel from the first attempt", retryCount: 2 })
      .where(eq(extractionJob.id, fx.extractionJobId));

    const result = await resendInvoiceToExtraction(fx.owner, fx.invoiceId);

    expect(result.invoice.status).toBe("processing");
    expect(result.extractionJobId).not.toBe(fx.extractionJobId);

    const jobs = await db.select().from(extractionJob).where(eq(extractionJob.invoiceId, fx.invoiceId));
    expect(jobs).toHaveLength(2);
    const oldJob = jobs.find((j) => j.id === fx.extractionJobId)!;
    expect(oldJob.errorMessage).toBe("sentinel from the first attempt");
    expect(oldJob.retryCount).toBe(2);
    const newJob = jobs.find((j) => j.id === result.extractionJobId)!;
    expect(newJob.status).toBe("queued");
    expect(newJob.errorMessage).toBeNull();
  });

  test(
    "refuses when the invoice is not currently rejected — MUTATION-CHECKED: widening updateInvoiceStatusTx's `from` for this call to include needs_review lets a not-yet-reviewed invoice resend too",
    async () => {
      // fx.invoiceId starts at needs_review.
      const attempt = resendInvoiceToExtraction(fx.owner, fx.invoiceId);
      await expect(attempt).rejects.toBeInstanceOf(DomainError);

      const jobs = await db.select().from(extractionJob).where(eq(extractionJob.invoiceId, fx.invoiceId));
      expect(jobs).toHaveLength(1);
      const inv = await selectInvoice(fx.invoiceId);
      expect(inv.status).toBe("needs_review");
    },
  );

  test("getJobForInvoice returns the NEWEST job once a resend has created a second row for the same invoice", async () => {
    await updateInvoiceStatus(fx.owner, fx.invoiceId, "needs_review", "rejected", { rejectionReason: "x" });
    const { extractionJobId } = await resendInvoiceToExtraction(fx.owner, fx.invoiceId);

    const job = await getJobForInvoice(fx.organizationId, fx.invoiceId);
    expect(job.id).toBe(extractionJobId);
    expect(job.id).not.toBe(fx.extractionJobId);
  });
});

// ---------------------------------------------------------------------------
// Action layer — role gates, cross-tenant refusals, and payload shape [AR-7]
// ---------------------------------------------------------------------------

describe("getInvoiceAction / getInvoiceLinesAction — owner-only, tenant-scoped", () => {
  test("manager_cannot_open_review_screen — both actions refuse a manager", async () => {
    const { getInvoiceAction, getInvoiceLinesAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.manager.userId;

    const invoiceResult = await getInvoiceAction({ invoiceId: fx.invoiceId });
    expect(invoiceResult.ok).toBe(false);

    const linesResult = await getInvoiceLinesAction({ invoiceId: fx.invoiceId });
    expect(linesResult.ok).toBe(false);
  });

  test("staff is also refused on both", async () => {
    const { getInvoiceAction, getInvoiceLinesAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.staff.userId;

    expect((await getInvoiceAction({ invoiceId: fx.invoiceId })).ok).toBe(false);
    expect((await getInvoiceLinesAction({ invoiceId: fx.invoiceId })).ok).toBe(false);
  });

  test("get_invoice_cross_tenant_is_not_found — an owner from another org gets a not-found-shaped failure, never the row, through both actions", async () => {
    const { getInvoiceAction, getInvoiceLinesAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.otherOwner.userId;

    const invoiceResult = await getInvoiceAction({ invoiceId: fx.invoiceId });
    expect(invoiceResult.ok).toBe(false);

    const linesResult = await getInvoiceLinesAction({ invoiceId: fx.invoiceId });
    expect(linesResult.ok).toBe(false);
  });
});

describe("listInvoicesRedactedAction — the manager-visible status poll [AR-7]", () => {
  test(
    "extraction_status_hides_error_message — never present anywhere in the serialized payload, even when a job actually carries one",
    async () => {
      await db
        .update(extractionJob)
        .set({
          status: "failed",
          errorMessage: "Vendor line item: 24ct Grey Goose $812.50 — could not parse quantity",
        })
        .where(eq(extractionJob.id, fx.extractionJobId));

      const { listInvoicesRedactedAction } = await import("@/app/actions/invoices");
      sessionUserId = fx.manager.userId;
      const result = await listInvoicesRedactedAction();

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const serialized = JSON.stringify(result.data);
      expect(serialized).not.toContain("errorMessage");
      expect(serialized).not.toContain("Grey Goose");
    },
  );

  test(
    "manager_invoice_payload_has_no_money — asserted on the serialized payload, so a future column added to the query fails this test rather than silently shipping",
    async () => {
      const { listInvoicesRedactedAction } = await import("@/app/actions/invoices");
      sessionUserId = fx.manager.userId;
      const result = await listInvoicesRedactedAction();

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      const found = result.data.find((i) => i.id === fx.invoiceId);
      expect(found).toBeDefined();
      const serialized = JSON.stringify(found);
      for (const forbidden of ["totalGross", "totalNet", "totalDiscount", "totalTax", "310.5"]) {
        expect(serialized).not.toContain(forbidden);
      }
    },
  );
});

describe("reviewInvoiceAction", () => {
  test("owner: applies corrections and returns the invoice at reviewed", async () => {
    const { reviewInvoiceAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.owner.userId;

    const result = await reviewInvoiceAction({
      invoiceId: fx.invoiceId,
      corrections: [{ id: fx.invoiceLineId, matchedProductId: fx.secondProductId }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.status).toBe("reviewed");
  });

  test("review_conflicts_when_status_moved — surfaces as a failed ActionResult, never ok: true with a stale write applied", async () => {
    await updateInvoiceStatus(fx.owner, fx.invoiceId, "needs_review", "rejected", { rejectionReason: "x" });

    const { reviewInvoiceAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.owner.userId;
    const result = await reviewInvoiceAction({
      invoiceId: fx.invoiceId,
      corrections: [{ id: fx.invoiceLineId, rawGross: "999.00" }],
    });

    expect(result.ok).toBe(false);
    const line = await selectLine(fx.invoiceLineId);
    expect(line.rawGross).toBe("294.00");
  });

  test("[AR-2] a cross-tenant matchedProductId is refused at the action layer too, and nothing is written", async () => {
    const { reviewInvoiceAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.owner.userId;

    const result = await reviewInvoiceAction({
      invoiceId: fx.invoiceId,
      corrections: [{ id: fx.invoiceLineId, matchedProductId: fx.otherProductId }],
    });

    expect(result.ok).toBe(false);
    const line = await selectLine(fx.invoiceLineId);
    expect(line.matchedProductId).toBeNull();
  });

  test("manager and staff are refused, and nothing is written", async () => {
    const { reviewInvoiceAction } = await import("@/app/actions/invoices");
    for (const actor of [fx.manager, fx.staff]) {
      sessionUserId = actor.userId;
      const result = await reviewInvoiceAction({
        invoiceId: fx.invoiceId,
        corrections: [{ id: fx.invoiceLineId, rawGross: "1.00" }],
      });
      expect(result.ok).toBe(false);
    }
    const line = await selectLine(fx.invoiceLineId);
    expect(line.rawGross).toBe("294.00");
  });

  test(
    "headerCorrections (open item #32) — a NULL totalNet blocks the action, and supplying it in the SAME action call reaches reviewed",
    async () => {
      const invoiceId = await createInvoiceMissingHeaderField(fx.organizationId, "totalNet");
      const { reviewInvoiceAction } = await import("@/app/actions/invoices");
      sessionUserId = fx.owner.userId;

      const blocked = await reviewInvoiceAction({ invoiceId, corrections: [] });
      expect(blocked.ok).toBe(false);

      const corrected = await reviewInvoiceAction({
        invoiceId,
        corrections: [],
        headerCorrections: { totalNet: "50.0000" },
      });
      expect(corrected.ok).toBe(true);
      if (!corrected.ok) throw new Error("unreachable");
      expect(corrected.data.status).toBe("reviewed");
      expect(corrected.data.totalNet).toBe("50.0000");
    },
  );

  test(
    "headerCorrections' currency is normalized to uppercase by headerCorrectionSchema before it ever reaches the domain layer",
    async () => {
      const invoiceId = await createInvoiceMissingHeaderField(fx.organizationId, "currency");
      const { reviewInvoiceAction } = await import("@/app/actions/invoices");
      sessionUserId = fx.owner.userId;

      const result = await reviewInvoiceAction({
        invoiceId,
        corrections: [],
        headerCorrections: { currency: "usd" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.data.currency).toBe("USD");
    },
  );
});

describe("rejectInvoiceAction", () => {
  test("owner: needs_review -> rejected, with the reason recorded", async () => {
    const { rejectInvoiceAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.owner.userId;

    const result = await rejectInvoiceAction({
      invoiceId: fx.invoiceId,
      reason: "Vendor overcharged for case pricing on line 1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.status).toBe("rejected");

    const row = await selectInvoice(fx.invoiceId);
    expect(row.rejectionReason).toBe("Vendor overcharged for case pricing on line 1");
  });

  test(
    "refuses to reject an APPROVED invoice — AR-4 terminal state — MUTATION-CHECKED: adding 'approved' to the `from` list this action passes to updateInvoiceStatus lets it through",
    async () => {
      await updateInvoiceStatus(fx.owner, fx.invoiceId, "needs_review", "reviewed");
      await updateInvoiceStatus(fx.owner, fx.invoiceId, "reviewed", "approved");

      const { rejectInvoiceAction } = await import("@/app/actions/invoices");
      sessionUserId = fx.owner.userId;
      const result = await rejectInvoiceAction({ invoiceId: fx.invoiceId, reason: "too late" });

      expect(result.ok).toBe(false);
      const row = await selectInvoice(fx.invoiceId);
      expect(row.status).toBe("approved");
    },
  );

  test("manager and staff are refused, and nothing is written", async () => {
    const { rejectInvoiceAction } = await import("@/app/actions/invoices");
    for (const actor of [fx.manager, fx.staff]) {
      sessionUserId = actor.userId;
      const result = await rejectInvoiceAction({ invoiceId: fx.invoiceId, reason: "not allowed" });
      expect(result.ok).toBe(false);
    }
    const row = await selectInvoice(fx.invoiceId);
    expect(row.status).toBe("needs_review");
    expect(row.rejectionReason).toBeNull();
  });

  test("an empty reason is refused by validation before it ever reaches the domain layer", async () => {
    const { rejectInvoiceAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.owner.userId;

    const result = await rejectInvoiceAction({ invoiceId: fx.invoiceId, reason: "" });

    expect(result.ok).toBe(false);
    const row = await selectInvoice(fx.invoiceId);
    expect(row.status).toBe("needs_review");
  });
});

describe("resendToExtractionAction", () => {
  test("owner: rejected -> processing, with a fresh queued job", async () => {
    await updateInvoiceStatus(fx.owner, fx.invoiceId, "needs_review", "rejected", { rejectionReason: "x" });

    const { resendToExtractionAction } = await import("@/app/actions/invoices");
    sessionUserId = fx.owner.userId;
    const result = await resendToExtractionAction({ invoiceId: fx.invoiceId });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.status).toBe("processing");
    expect(result.data.extractionJobId).not.toBe(fx.extractionJobId);
  });

  test(
    "refuses when the invoice is not rejected (e.g. still needs_review) — MUTATION-CHECKED: same guard as resendInvoiceToExtraction's own domain-level test, exercised through the action",
    async () => {
      const { resendToExtractionAction } = await import("@/app/actions/invoices");
      sessionUserId = fx.owner.userId;
      const result = await resendToExtractionAction({ invoiceId: fx.invoiceId });

      expect(result.ok).toBe(false);
      const jobs = await db.select().from(extractionJob).where(eq(extractionJob.invoiceId, fx.invoiceId));
      expect(jobs).toHaveLength(1);
    },
  );

  test("manager and staff are refused, and no second job row is created", async () => {
    await updateInvoiceStatus(fx.owner, fx.invoiceId, "needs_review", "rejected", { rejectionReason: "x" });

    const { resendToExtractionAction } = await import("@/app/actions/invoices");
    for (const actor of [fx.manager, fx.staff]) {
      sessionUserId = actor.userId;
      const result = await resendToExtractionAction({ invoiceId: fx.invoiceId });
      expect(result.ok).toBe(false);
    }

    const jobs = await db.select().from(extractionJob).where(eq(extractionJob.invoiceId, fx.invoiceId));
    expect(jobs).toHaveLength(1);
    const row = await selectInvoice(fx.invoiceId);
    expect(row.status).toBe("rejected");
  });
});
