/**
 * Invoice write path — Phase 2.5, Slice 1 (docs/plans/phase-2.5-invoice-automation).
 *
 * Every test here is written to fail against the uncorrected behaviour it
 * covers — dropping the guard under test must fail the specific test, not
 * merely "some test somewhere." Each MUTATION-CHECKED test has been verified
 * this way by hand (see the backend agent's final report for the exact
 * mutation applied and restored per case).
 *
 * Session mocking follows `tests/location-write-path.test.ts`'s convention:
 * `next/headers` and `@/lib/auth` are mocked at module scope so
 * `requireSession`'s own DB lookup still runs for real, and the route/action
 * modules under test are imported dynamically (inside each test) so the
 * mocks are in place before those modules — or anything importing
 * `@/lib/authz` transitively — are ever resolved.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db, closePool } from "@/db";
import { invoice, extractionJob } from "@/db/schema";
import {
  createInvoiceForUpload,
  markUploadConfirmed,
  getInvoice,
  listInvoicesForOwner,
  listInvoicesRedacted,
  updateInvoiceStatus,
  computeRetentionUntil,
  type InvoiceRow,
} from "@/lib/domain/invoices";
import { claimNextJob, updateJobStatus } from "@/lib/domain/extraction";
import {
  NotFoundError,
  ConflictError,
  InvoiceNotWritableError,
  InvalidInvoiceTransitionError,
} from "@/lib/domain/errors";
import { readFile } from "node:fs/promises";
import { writeInvoiceFile, sha256Hex, resolveStoredPath } from "@/lib/storage/invoice-files";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";

let fx: Fixtures;

const STORAGE_DIR = "/tmp/truestock-invoice-write-path-test";

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

// ---------------------------------------------------------------------------
// Session mocks for the action/route-layer tests below.
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

async function getJobForInvoice(invoiceId: number) {
  const [row] = await db.select().from(extractionJob).where(eq(extractionJob.invoiceId, invoiceId));
  return row;
}

async function uploadAndWriteMatchingFile(actor: Fixtures["owner"]): Promise<InvoiceRow> {
  const created = await createInvoiceForUpload(actor, {
    source: "pdf",
    contentType: "application/pdf",
    fileSha256: sha256Hex(Buffer.from("hello invoice")),
    fileSizeBytes: Buffer.byteLength("hello invoice"),
  });
  await writeInvoiceFile(created.filePath!, Buffer.from("hello invoice"));
  return created;
}

// ---------------------------------------------------------------------------
// computeRetentionUntil — spec §10's retention window
// ---------------------------------------------------------------------------

describe("computeRetentionUntil", () => {
  test("adds exactly 3 years to an ordinary date", () => {
    expect(computeRetentionUntil("2026-03-15")).toBe("2029-03-15");
  });

  test("rolls Feb 29 forward to Mar 1 when the target year is not a leap year", () => {
    // 2024 is a leap year; 2024 + 3 = 2027 is not.
    expect(computeRetentionUntil("2024-02-29")).toBe("2027-03-01");
  });

  test("rejects a malformed date rather than silently misparsing it", () => {
    expect(() => computeRetentionUntil("03/15/2026")).toThrow();
  });

  test("is never shorter than the two-year statutory floor, for any date", () => {
    // The assertion that actually matters, and the reason it is written as an
    // inequality rather than a second equality: A.A.C. R19-1-501 requires two
    // years, `retention_until` is the date before which an invoice must never
    // be deleted, and the retention sweep reads it. Shortening this window is
    // the one edit here whose failure mode is unrecoverable — the record is
    // gone and no correction brings it back — while lengthening it costs
    // disk. So this fails on any future change that rounds the window DOWN,
    // including back to the bare statutory minimum, without caring whether
    // someone later lengthens it further.
    for (const date of ["2026-03-15", "2024-02-29", "2026-12-31", "2026-01-01"]) {
      const floor = new Date(`${date}T00:00:00Z`);
      floor.setUTCFullYear(floor.getUTCFullYear() + 2);
      expect(new Date(`${computeRetentionUntil(date)}T00:00:00Z`).getTime()).toBeGreaterThanOrEqual(
        floor.getTime(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// createInvoiceForUpload — the three-write transaction
// ---------------------------------------------------------------------------

describe("createInvoiceForUpload", () => {
  test("inserts invoice (uploaded) + extraction_job (awaiting_upload), and stamps file_path", async () => {
    const created = await createInvoiceForUpload(fx.owner, {
      vendorId: fx.vendorId,
      source: "photo",
      contentType: "image/jpeg",
      fileSha256: "a".repeat(64),
      fileSizeBytes: 1024,
    });

    expect(created.status).toBe("uploaded");
    expect(created.filePath).toBe(`${fx.organizationId}/${created.id}.jpg`);

    const job = await getJobForInvoice(created.id);
    expect(job).toBeDefined();
    expect(job.status).toBe("awaiting_upload");
    expect(job.organizationId).toBe(fx.organizationId);
  });

  test("a cross-tenant vendorId is refused with NotFoundError, and nothing is written", async () => {
    const attempt = createInvoiceForUpload(fx.owner, {
      vendorId: fx.otherVendorId,
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: "b".repeat(64),
      fileSizeBytes: 2048,
    });
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);

    const rows = await db.select().from(invoice).where(eq(invoice.organizationId, fx.organizationId));
    expect(rows).toHaveLength(0);
  });

  test(
    "a cross-tenant vendor_id is ALSO refused at the database layer (MariaDB 1452) if the domain check is bypassed — the composite FK is a real backstop, not decorative",
    async () => {
      // Wrapped in an async IIFE rather than passed as the bare drizzle
      // builder: the builder is a thenable, not a genuine `Promise`
      // instance, and bun:test's `expect(...).rejects` requires the latter.
      const attempt = (async () => {
        await db.insert(invoice).values({
          organizationId: fx.organizationId,
          vendorId: fx.otherVendorId,
          status: "uploaded",
          source: "pdf",
          fileSha256: "c".repeat(64),
          fileSizeBytes: 10,
        });
      })();
      await expect(attempt).rejects.toThrow();
    },
  );
});

// ---------------------------------------------------------------------------
// markUploadConfirmed — the ONLY awaiting_upload -> queued edge
// ---------------------------------------------------------------------------

describe("markUploadConfirmed", () => {
  test("matching hash + size advances the job to queued", async () => {
    const created = await uploadAndWriteMatchingFile(fx.owner);

    const result = await markUploadConfirmed(fx.owner, created.id);

    expect(result.matched).toBe(true);
    const job = await getJobForInvoice(created.id);
    expect(job.status).toBe("queued");
  });

  test(
    "a mismatched hash leaves the job at awaiting_upload — MUTATION-CHECKED: comparing a declared value against itself instead of the derived one makes this always match",
    async () => {
      const created = await createInvoiceForUpload(fx.owner, {
        source: "pdf",
        contentType: "application/pdf",
        fileSha256: sha256Hex(Buffer.from("declared bytes")),
        fileSizeBytes: Buffer.byteLength("declared bytes"),
      });
      // Different bytes actually land on disk than what was declared.
      await writeInvoiceFile(created.filePath!, Buffer.from("swapped bytes!!"));

      const result = await markUploadConfirmed(fx.owner, created.id);

      expect(result.matched).toBe(false);
      const job = await getJobForInvoice(created.id);
      expect(job.status).toBe("awaiting_upload");
    },
  );

  test("no file on disk yet is 'not yet confirmable', not a crash", async () => {
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: "d".repeat(64),
      fileSizeBytes: 5,
    });

    const result = await markUploadConfirmed(fx.owner, created.id);

    expect(result.matched).toBe(false);
    const job = await getJobForInvoice(created.id);
    expect(job.status).toBe("awaiting_upload");
  });

  test("a second confirm call after the job already moved past awaiting_upload is an idempotent replay, not a conflict", async () => {
    const created = await uploadAndWriteMatchingFile(fx.owner);
    const first = await markUploadConfirmed(fx.owner, created.id);
    expect(first.matched).toBe(true);

    const second = await markUploadConfirmed(fx.owner, created.id);
    expect(second.matched).toBe(true);

    const job = await getJobForInvoice(created.id);
    expect(job.status).toBe("queued");
  });

  test("a cross-tenant invoiceId is refused with NotFoundError", async () => {
    const created = await uploadAndWriteMatchingFile(fx.owner);
    const attempt = markUploadConfirmed(fx.otherOwner, created.id);
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// getInvoice — invariant 9
// ---------------------------------------------------------------------------

describe("getInvoice", () => {
  test("returns the invoice scoped to the caller's organization", async () => {
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: "e".repeat(64),
      fileSizeBytes: 5,
    });

    const fetched = await getInvoice(fx.owner, created.id);
    expect(fetched.id).toBe(created.id);
  });

  test(
    "a cross-tenant invoiceId returns NotFoundError, never a response confirming the row exists — MUTATION-CHECKED: dropping the organizationId predicate returns the other tenant's row instead",
    async () => {
      const created = await createInvoiceForUpload(fx.owner, {
        source: "pdf",
        contentType: "application/pdf",
        fileSha256: "f".repeat(64),
        fileSizeBytes: 5,
      });

      const attempt = getInvoice(fx.otherOwner, created.id);
      await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
    },
  );

  test("an unknown invoiceId also returns NotFoundError", async () => {
    const attempt = getInvoice(fx.owner, 999999);
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// listInvoicesForOwner / listInvoicesRedacted
// ---------------------------------------------------------------------------

describe("listInvoicesForOwner / listInvoicesRedacted", () => {
  test("both exclude status = approved by default", async () => {
    const uploaded = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: "1".repeat(64),
      fileSizeBytes: 5,
    });
    const toApprove = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: "2".repeat(64),
      fileSizeBytes: 5,
    });
    // Force straight to approved for list-filtering purposes — the lifecycle
    // CAS itself is exercised separately below.
    await db.update(invoice).set({ status: "approved" }).where(eq(invoice.id, toApprove.id));

    const ownerList = await listInvoicesForOwner(fx.owner);
    expect(ownerList.some((i) => i.id === uploaded.id)).toBe(true);
    expect(ownerList.some((i) => i.id === toApprove.id)).toBe(false);

    const redactedList = await listInvoicesRedacted(fx.owner);
    expect(redactedList.some((i) => i.id === uploaded.id)).toBe(true);
    expect(redactedList.some((i) => i.id === toApprove.id)).toBe(false);
  });

  test("only returns the caller's own organization's invoices", async () => {
    await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: "3".repeat(64),
      fileSizeBytes: 5,
    });
    await createInvoiceForUpload(fx.otherOwner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: "4".repeat(64),
      fileSizeBytes: 5,
    });

    const list = await listInvoicesForOwner(fx.owner);
    expect(list.every((i) => i.organizationId === fx.organizationId)).toBe(true);
  });

  test(
    "listInvoicesRedacted's rows never carry a monetary or file-identity field — asserted on the returned object's own keys, not a value check — MUTATION-CHECKED: selecting the whole row instead of the explicit column list adds totalGross/fileSha256/filePath back",
    async () => {
      await createInvoiceForUpload(fx.owner, {
        source: "pdf",
        contentType: "application/pdf",
        fileSha256: "5".repeat(64),
        fileSizeBytes: 5,
      });

      const [row] = await listInvoicesRedacted(fx.owner);
      expect(row).toBeDefined();
      const keys = Object.keys(row as object);
      for (const forbidden of [
        "totalGross",
        "totalDiscount",
        "totalNet",
        "filePath",
        "fileSha256",
        "fileSizeBytes",
        "approvedAt",
        "approvedBy",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// updateInvoiceStatus — lifecycle CAS
// ---------------------------------------------------------------------------

describe("updateInvoiceStatus", () => {
  test("a legal transition succeeds and persists", async () => {
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: "6".repeat(64),
      fileSizeBytes: 5,
    });

    const updated = await updateInvoiceStatus(fx.owner, created.id, "uploaded", "processing");
    expect(updated.status).toBe("processing");
  });

  test(
    "an illegal transition is refused before touching the database — approved is terminal",
    async () => {
      const created = await createInvoiceForUpload(fx.owner, {
        source: "pdf",
        contentType: "application/pdf",
        fileSha256: "7".repeat(64),
        fileSizeBytes: 5,
      });
      await db.update(invoice).set({ status: "approved" }).where(eq(invoice.id, created.id));

      const attempt = updateInvoiceStatus(fx.owner, created.id, "approved", "processing");
      await expect(attempt).rejects.toBeInstanceOf(InvalidInvoiceTransitionError);

      const [row] = await db.select().from(invoice).where(eq(invoice.id, created.id));
      expect(row.status).toBe("approved");
    },
  );

  test(
    "a stale `from` — the row already moved on — raises ConflictError, never a silent no-op — MUTATION-CHECKED: dropping the fromList.includes(row.status) check lets a stale transition overwrite the current status",
    async () => {
      const created = await createInvoiceForUpload(fx.owner, {
        source: "pdf",
        contentType: "application/pdf",
        fileSha256: "8".repeat(64),
        fileSizeBytes: 5,
      });
      await updateInvoiceStatus(fx.owner, created.id, "uploaded", "processing");

      // Second caller still believes it's "uploaded" — e.g. a retried submit
      // racing the first one.
      const attempt = updateInvoiceStatus(fx.owner, created.id, "uploaded", "processing");
      await expect(attempt).rejects.toBeInstanceOf(ConflictError);

      const [row] = await db.select().from(invoice).where(eq(invoice.id, created.id));
      expect(row.status).toBe("processing");
    },
  );

  test(
    "a transition INTO reviewed is refused while any required document field is still NULL — MUTATION-CHECKED: removing the REQUIRED_FOR_REVIEW guard lets it through with every field NULL",
    async () => {
      const created = await createInvoiceForUpload(fx.owner, {
        source: "pdf",
        contentType: "application/pdf",
        fileSha256: "9".repeat(64),
        fileSizeBytes: 5,
      });
      await updateInvoiceStatus(fx.owner, created.id, "uploaded", "processing");
      await updateInvoiceStatus(fx.owner, created.id, "processing", "needs_review");

      const attempt = updateInvoiceStatus(fx.owner, created.id, "needs_review", "reviewed");
      await expect(attempt).rejects.toBeInstanceOf(InvoiceNotWritableError);

      const [row] = await db.select().from(invoice).where(eq(invoice.id, created.id));
      expect(row.status).toBe("needs_review");
    },
  );

  test("a transition into reviewed succeeds once every required field is populated, either already on the row or via this same call's data", async () => {
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: "0".repeat(64),
      fileSizeBytes: 5,
    });
    await updateInvoiceStatus(fx.owner, created.id, "uploaded", "processing");
    await updateInvoiceStatus(fx.owner, created.id, "processing", "needs_review");

    const updated = await updateInvoiceStatus(fx.owner, created.id, "needs_review", "reviewed", {
      invoiceDate: "2026-01-15",
      invoiceNumber: "INV-100",
      totalGross: "100.0000",
      totalNet: "100.0000",
      currency: "USD",
      retentionUntil: computeRetentionUntil("2026-01-15"),
    });

    expect(updated.status).toBe("reviewed");
    expect(updated.retentionUntil).toBe("2029-01-15");
  });

  test("a cross-tenant invoiceId is refused with NotFoundError", async () => {
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: "a1".padEnd(64, "1"),
      fileSizeBytes: 5,
    });

    const attempt = updateInvoiceStatus(fx.otherOwner, created.id, "uploaded", "processing");
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// extraction_job — claimNextJob / updateJobStatus
// ---------------------------------------------------------------------------

describe("claimNextJob", () => {
  test(
    "job_not_claimable_before_upload — a job still awaiting_upload is never returned, even when it is the only job — MUTATION-CHECKED: dropping the status = 'queued' predicate from the UPDATE's WHERE clause claims it (the probe SELECT alone is not the guard — the UPDATE re-asserting status is)",
    async () => {
      await createInvoiceForUpload(fx.owner, {
        source: "pdf",
        contentType: "application/pdf",
        fileSha256: "b1".padEnd(64, "1"),
        fileSizeBytes: 5,
      });

      const claimed = await claimNextJob("worker-1");
      expect(claimed).toBeNull();
    },
  );

  test("claims the oldest queued job and sets running/claimed_at/claimed_by", async () => {
    const created = await uploadAndWriteMatchingFile(fx.owner);
    await markUploadConfirmed(fx.owner, created.id);

    const claimed = await claimNextJob("worker-1");
    expect(claimed).not.toBeNull();
    expect(claimed!.invoiceId).toBe(created.id);
    expect(claimed!.status).toBe("running");
    expect(claimed!.claimedBy).toBe("worker-1");
  });

  test("a job already running is not claimed again by a second worker", async () => {
    const created = await uploadAndWriteMatchingFile(fx.owner);
    await markUploadConfirmed(fx.owner, created.id);
    await claimNextJob("worker-1");

    const secondClaim = await claimNextJob("worker-2");
    expect(secondClaim).toBeNull();
  });
});

describe("updateJobStatus", () => {
  test("a legal CAS transition succeeds", async () => {
    const created = await uploadAndWriteMatchingFile(fx.owner);
    await markUploadConfirmed(fx.owner, created.id);
    const job = await getJobForInvoice(created.id);

    const updated = await updateJobStatus(job.id, "queued", "running");
    expect(updated.status).toBe("running");
  });

  test(
    "a stale `from` raises ConflictError rather than silently overwriting — MUTATION-CHECKED: ignoring affectedRows === 0 returns as though the write happened",
    async () => {
      const created = await uploadAndWriteMatchingFile(fx.owner);
      await markUploadConfirmed(fx.owner, created.id);
      const job = await getJobForInvoice(created.id);

      const attempt = updateJobStatus(job.id, "awaiting_upload", "queued");
      await expect(attempt).rejects.toBeInstanceOf(ConflictError);

      const [row] = await db.select().from(extractionJob).where(eq(extractionJob.id, job.id));
      expect(row.status).toBe("queued");
    },
  );

  test(
    "job_status_enum_is_closed — writing a value outside extractionJobStatusEnum is rejected by the database itself",
    async () => {
      const created = await uploadAndWriteMatchingFile(fx.owner);
      const job = await getJobForInvoice(created.id);

      const rawAttempt = db.execute(
        sql`UPDATE extraction_job SET status = 'ready_for_classify' WHERE id = ${job.id}`,
      );
      await expect(rawAttempt).rejects.toThrow();

      const [row] = await db.select().from(extractionJob).where(eq(extractionJob.id, job.id));
      expect(row.status).toBe("awaiting_upload");
    },
  );
});

// ---------------------------------------------------------------------------
// GET/PUT /api/invoices/[id]/file — the only path invoice bytes travel
// ---------------------------------------------------------------------------

function fakeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/invoices/[id]/file", () => {
  test("invoice_file_requires_owner — no session is refused with 401", async () => {
    sessionUserId = null;
    const { GET } = await import("@/app/api/invoices/[id]/file/route");

    const created = await uploadAndWriteMatchingFile(fx.owner);
    const res = await GET(new Request(`http://localhost/api/invoices/${created.id}/file`), fakeParams(String(created.id)));

    expect(res.status).toBe(401);
  });

  test("invoice_file_requires_owner — manager is refused with 403", async () => {
    const created = await uploadAndWriteMatchingFile(fx.owner);
    sessionUserId = fx.manager.userId;
    const { GET } = await import("@/app/api/invoices/[id]/file/route");

    const res = await GET(new Request(`http://localhost/api/invoices/${created.id}/file`), fakeParams(String(created.id)));

    expect(res.status).toBe(403);
  });

  test("invoice_file_requires_owner — staff is refused with 403", async () => {
    const created = await uploadAndWriteMatchingFile(fx.owner);
    sessionUserId = fx.staff.userId;
    const { GET } = await import("@/app/api/invoices/[id]/file/route");

    const res = await GET(new Request(`http://localhost/api/invoices/${created.id}/file`), fakeParams(String(created.id)));

    expect(res.status).toBe(403);
  });

  test("owner succeeds and receives the exact bytes with an attachment disposition", async () => {
    const created = await uploadAndWriteMatchingFile(fx.owner);
    sessionUserId = fx.owner.userId;
    const { GET } = await import("@/app/api/invoices/[id]/file/route");

    const res = await GET(new Request(`http://localhost/api/invoices/${created.id}/file`), fakeParams(String(created.id)));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.toString()).toBe("hello invoice");
  });

  test("a cross-tenant invoice id is refused with 404, not 403 — never confirms the row exists", async () => {
    const created = await uploadAndWriteMatchingFile(fx.owner);
    sessionUserId = fx.otherOwner.userId;
    const { GET } = await import("@/app/api/invoices/[id]/file/route");

    const res = await GET(new Request(`http://localhost/api/invoices/${created.id}/file`), fakeParams(String(created.id)));

    expect(res.status).toBe(404);
  });

  test("an unknown invoice id is 404", async () => {
    sessionUserId = fx.owner.userId;
    const { GET } = await import("@/app/api/invoices/[id]/file/route");

    const res = await GET(new Request("http://localhost/api/invoices/999999/file"), fakeParams("999999"));

    expect(res.status).toBe(404);
  });

  test("a NULL file_path is 404, not a crash", async () => {
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: "c1".padEnd(64, "1"),
      fileSizeBytes: 5,
    });
    // file_path is set by createInvoiceForUpload's own transaction, so force
    // it back to NULL to exercise the defensive branch directly.
    await db.update(invoice).set({ filePath: null }).where(eq(invoice.id, created.id));

    sessionUserId = fx.owner.userId;
    const { GET } = await import("@/app/api/invoices/[id]/file/route");
    const res = await GET(new Request(`http://localhost/api/invoices/${created.id}/file`), fakeParams(String(created.id)));

    expect(res.status).toBe(404);
  });

  test(
    "invoice_file_rejects_path_traversal — a file_path of ../../etc/passwd is refused with the SAME 404 shape as an unknown id, never the StoragePathError message — MUTATION-CHECKED: catching StoragePathError and returning its own message instead of notFound() leaks the traversal detail",
    async () => {
      const created = await uploadAndWriteMatchingFile(fx.owner);
      await db.update(invoice).set({ filePath: "../../etc/passwd" }).where(eq(invoice.id, created.id));

      sessionUserId = fx.owner.userId;
      const { GET } = await import("@/app/api/invoices/[id]/file/route");
      const res = await GET(new Request(`http://localhost/api/invoices/${created.id}/file`), fakeParams(String(created.id)));

      expect(res.status).toBe(404);
      const unknownRes = await GET(new Request("http://localhost/api/invoices/999999/file"), fakeParams("999999"));
      const body = await res.json();
      const unknownBody = await unknownRes.json();
      expect(body).toEqual(unknownBody);
    },
  );
});

describe("PUT /api/invoices/[id]/file", () => {
  test("owner can upload the file", async () => {
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: sha256Hex(Buffer.from("put body")),
      fileSizeBytes: Buffer.byteLength("put body"),
    });

    sessionUserId = fx.owner.userId;
    const { PUT } = await import("@/app/api/invoices/[id]/file/route");
    const res = await PUT(
      new Request(`http://localhost/api/invoices/${created.id}/file`, { method: "PUT", body: "put body" }),
      fakeParams(String(created.id)),
    );

    expect(res.status).toBe(200);
    const confirmed = await markUploadConfirmed(fx.owner, created.id);
    expect(confirmed.matched).toBe(true);
  });

  test("manager can upload the file — positive control matching the upload action's own role gate", async () => {
    const created = await createInvoiceForUpload(fx.manager, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: sha256Hex(Buffer.from("manager body")),
      fileSizeBytes: Buffer.byteLength("manager body"),
    });

    sessionUserId = fx.manager.userId;
    const { PUT } = await import("@/app/api/invoices/[id]/file/route");
    const res = await PUT(
      new Request(`http://localhost/api/invoices/${created.id}/file`, { method: "PUT", body: "manager body" }),
      fakeParams(String(created.id)),
    );

    expect(res.status).toBe(200);
  });

  test("staff is refused with 403 and nothing is written", async () => {
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: sha256Hex(Buffer.from("staff body")),
      fileSizeBytes: Buffer.byteLength("staff body"),
    });

    sessionUserId = fx.staff.userId;
    const { PUT } = await import("@/app/api/invoices/[id]/file/route");
    const res = await PUT(
      new Request(`http://localhost/api/invoices/${created.id}/file`, { method: "PUT", body: "staff body" }),
      fakeParams(String(created.id)),
    );

    expect(res.status).toBe(403);
    const confirmed = await markUploadConfirmed(fx.owner, created.id);
    expect(confirmed.matched).toBe(false);
  });

  test("a cross-tenant invoice id is refused with 404", async () => {
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: sha256Hex(Buffer.from("cross tenant")),
      fileSizeBytes: Buffer.byteLength("cross tenant"),
    });

    sessionUserId = fx.otherOwner.userId;
    const { PUT } = await import("@/app/api/invoices/[id]/file/route");
    const res = await PUT(
      new Request(`http://localhost/api/invoices/${created.id}/file`, { method: "PUT", body: "cross tenant" }),
      fakeParams(String(created.id)),
    );

    expect(res.status).toBe(404);
  });

  test("invoice_file_is_write_once — a second PUT after the upload is confirmed cannot replace the archived bytes", async () => {
    // The gap this closes. Role, ownership and the traversal guard all say
    // yes to this request: it is the real owner, their own invoice, a
    // perfectly contained path. Nothing about WHEN was checked.
    //
    // So once `markUploadConfirmed` has re-hashed the bytes on disk against
    // the declared `file_sha256` and released the job to `queued`, a second
    // PUT used to overwrite the file and leave `file_sha256` describing bytes
    // that are no longer there. That is silent by construction — the row
    // still reads verified, the archive list looks identical, and the only
    // thing that disagrees is the file itself. It surfaces two years later in
    // an audit packet (Slice 5) against a document with a 3-year statutory
    // retention, which is the worst possible moment to discover it.
    //
    // `awaiting_upload` is exactly the window in which an upload is
    // legitimate, so that is the guard: the same state machine that already
    // stops the extraction worker from claiming an unwritten file (AR-6) also
    // stops a writer from touching a confirmed one.
    const body = "original archived bytes";
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: sha256Hex(Buffer.from(body)),
      fileSizeBytes: Buffer.byteLength(body),
    });

    sessionUserId = fx.owner.userId;
    const { PUT } = await import("@/app/api/invoices/[id]/file/route");
    const first = await PUT(
      new Request(`http://localhost/api/invoices/${created.id}/file`, { method: "PUT", body }),
      fakeParams(String(created.id)),
    );
    expect(first.status).toBe(200);

    const confirmed = await markUploadConfirmed(fx.owner, created.id);
    expect(confirmed.matched).toBe(true);

    const second = await PUT(
      new Request(`http://localhost/api/invoices/${created.id}/file`, {
        method: "PUT",
        body: "tampered replacement bytes",
      }),
      fakeParams(String(created.id)),
    );
    expect(second.status).toBe(409);

    // The assertion that actually matters: the archived document is still the
    // one whose hash was verified, byte for byte. A 409 with the file already
    // overwritten would be a worse outcome than no guard at all, because it
    // would read as a refusal.
    const onDisk = await readFile(resolveStoredPath(created.filePath!));
    expect(onDisk.toString()).toBe(body);
    expect(sha256Hex(onDisk)).toBe(created.fileSha256);
  });

  test("invoice_file_write_once_survives_a_concurrent_put — a PUT already in flight when the confirm lands cannot overwrite the verified bytes", async () => {
    // The sequential test above passes even with the guard placed where it
    // cannot hold: it checks `awaiting_upload` once, near the top of the
    // handler, and then spends an unbounded amount of time reading up to
    // 25 MB off the wire before writing. Between those two moments the job
    // can be confirmed by someone else, and nothing re-checks.
    //
    // The real sequence, which is an ordinary flaky-mobile double-submit and
    // not a contrived attack:
    //   1. PUT A and PUT B are both issued; both observe `awaiting_upload`.
    //   2. A lands first.
    //   3. confirm re-hashes A's bytes, matches the declared SHA-256, and
    //      CAS's the job to `queued`.
    //   4. B — still mid-body-read, already past the check — finally writes.
    // The archived file is now B's bytes while `file_sha256` still describes
    // A's. The row reads verified. Nothing ever re-hashes it again, so the
    // disagreement surfaces years later in a Slice 5 audit packet, against a
    // document under a 3-year statutory retention.
    //
    // Driven deterministically rather than by racing two real requests: B's
    // body is a stream this test holds open, so step 3 provably happens while
    // B sits between its check and its write. A timing-dependent version of
    // this test would be worse than none — it would pass most runs and be
    // read as evidence.
    const body = "original archived bytes";
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: sha256Hex(Buffer.from(body)),
      fileSizeBytes: Buffer.byteLength(body),
    });

    sessionUserId = fx.owner.userId;
    const { PUT } = await import("@/app/api/invoices/[id]/file/route");

    const first = await PUT(
      new Request(`http://localhost/api/invoices/${created.id}/file`, { method: "PUT", body }),
      fakeParams(String(created.id)),
    );
    expect(first.status).toBe(200);

    // B's body: one chunk delivered immediately so the handler is past its
    // status check, then the stream stays open until this test closes it.
    let releaseBody: () => void;
    const bodyReleased = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    let firstChunkDelivered: () => void;
    const handlerIsReading = new Promise<void>((resolve) => {
      firstChunkDelivered = resolve;
    });

    const slowBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode("tampered "));
        firstChunkDelivered();
        await bodyReleased;
        controller.enqueue(new TextEncoder().encode("replacement bytes"));
        controller.close();
      },
    });

    const inFlight = PUT(
      new Request(`http://localhost/api/invoices/${created.id}/file`, {
        method: "PUT",
        body: slowBody,
        // Required by the Fetch spec for a streaming request body.
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      fakeParams(String(created.id)),
    );

    // B is now demonstrably past its `awaiting_upload` check and blocked on
    // its body — the exact window the bug lives in.
    await handlerIsReading;

    const confirmed = await markUploadConfirmed(fx.owner, created.id);
    expect(confirmed.matched).toBe(true);

    releaseBody!();
    const second = await inFlight;

    // B must lose. Not "B wins but we noticed" — the bytes on disk are the
    // ones whose hash was verified, and the response says so.
    expect(second.status).toBe(409);

    // And it must lose to the LOCK, not to the fast-path check at the top of
    // the handler. Without this assertion the test passes for the wrong
    // reason: if the body stream is drained before the handler's status read,
    // confirm lands first, the fast path returns 409, and the window under
    // test is never entered. That false pass is not hypothetical — the first
    // version of this test did exactly that, and survived deleting the fix.
    const secondBody = (await second.json()) as { error: string };
    expect(secondBody.error).toBe(
      "This invoice's upload was confirmed while these bytes were still arriving.",
    );

    const onDisk = await readFile(resolveStoredPath(created.filePath!));
    expect(onDisk.toString()).toBe(body);
    expect(sha256Hex(onDisk)).toBe(created.fileSha256);
  });

  test("confirm_replay_is_safe_under_concurrency — two simultaneous confirms both succeed instead of one raising ConflictError", async () => {
    // `markUploadConfirmed`'s contract says replaying a confirm "must produce
    // the same success it produced the first time". That held only for the
    // sequential case. Concurrently, both callers used to read
    // `awaiting_upload` before either wrote, one CAS won, and the loser's
    // `UPDATE ... WHERE status = 'awaiting_upload'` affected zero rows and
    // raised ConflictError straight out to the client — a hard failure on a
    // call documented as safe to retry, which is precisely what a client does
    // after a request times out but actually succeeded.
    //
    // Holding the extraction_job row lock across the read and the CAS makes
    // the two serialize, so the second caller observes `queued` and takes the
    // idempotent-replay path it was always supposed to take.
    const body = "bytes confirmed twice at once";
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: sha256Hex(Buffer.from(body)),
      fileSizeBytes: Buffer.byteLength(body),
    });
    await writeInvoiceFile(created.filePath!, Buffer.from(body));

    const [a, b] = await Promise.all([
      markUploadConfirmed(fx.owner, created.id),
      markUploadConfirmed(fx.owner, created.id),
    ]);

    expect(a.matched).toBe(true);
    expect(b.matched).toBe(true);

    const [job] = await db
      .select()
      .from(extractionJob)
      .where(eq(extractionJob.invoiceId, created.id));
    expect(job.status).toBe("queued");
  });

  test("confirm_after_a_409_still_reports_verified — the retry path's premise holds", async () => {
    // `components/office/invoice-upload-form.tsx` treats a 409 from the PUT
    // as "already uploaded, go confirm" rather than as a failure, because the
    // only way its retry button can produce one is a confirm whose RESPONSE
    // was lost: the bytes are on disk, the job is already past
    // `awaiting_upload`, and the invoice is in the archive. Showing "the file
    // failed to upload" there would loop the user on work that is done.
    //
    // That behaviour is only correct if confirm actually replays cleanly
    // after the 409 — which is a SERVER guarantee, asserted here rather than
    // assumed from the client. If `markUploadConfirmed` ever starts throwing
    // or returning `matched: false` on an already-confirmed invoice, the form
    // silently starts reporting a successful archive as a verification
    // failure, and this test is what catches it.
    const body = "bytes that land exactly once";
    const created = await createInvoiceForUpload(fx.owner, {
      source: "pdf",
      contentType: "application/pdf",
      fileSha256: sha256Hex(Buffer.from(body)),
      fileSizeBytes: Buffer.byteLength(body),
    });

    sessionUserId = fx.owner.userId;
    const { PUT } = await import("@/app/api/invoices/[id]/file/route");
    expect(
      (
        await PUT(
          new Request(`http://localhost/api/invoices/${created.id}/file`, { method: "PUT", body }),
          fakeParams(String(created.id)),
        )
      ).status,
    ).toBe(200);

    expect((await markUploadConfirmed(fx.owner, created.id)).matched).toBe(true);

    // The retry: its PUT is refused, and the confirm that follows must still
    // say verified.
    const refused = await PUT(
      new Request(`http://localhost/api/invoices/${created.id}/file`, { method: "PUT", body }),
      fakeParams(String(created.id)),
    );
    expect(refused.status).toBe(409);

    const replay = await markUploadConfirmed(fx.owner, created.id);
    expect(replay.matched).toBe(true);

    // And the refused write left the archived bytes alone.
    const onDisk = await readFile(resolveStoredPath(created.filePath!));
    expect(onDisk.toString()).toBe(body);
  });
});
