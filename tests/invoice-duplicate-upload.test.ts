/**
 * F7, happy path (docs/plans/invoice-qa-fixes): one live copy of a file per
 * organization.
 *
 * The same bytes uploaded twice used to create two invoices that both went on
 * to be extracted, reviewed and costed. Now the second upload is refused and
 * names the first. Two mechanisms, deliberately:
 *
 *   - a lookup at the upload request refuses early, before any bytes move;
 *   - the claim (`invoice.live_file_sha256`, unique per organization) is taken
 *     at CONFIRM, in the transaction that queues the job, and is what actually
 *     decides a race. A lookup cannot, because two requests both pass it.
 *
 * Runs against a real MariaDB (the unique index and repeatable-read behaviour
 * are the thing under test). Fixtures are synthetic text; no supplier document.
 * The bottom half (slice 8) covers rejecting a copy to release its claim,
 * resend re-taking it, and the simultaneous-confirm races.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { db, closePool } from "@/db";
import { invoice, extractionJob, vendor } from "@/db/schema";
import {
  createInvoiceForUpload,
  markUploadConfirmed,
  resendInvoiceToExtraction,
  updateInvoiceStatus,
  claimFileTx,
  findLiveCopy,
  type CreateInvoiceForUploadResult,
  type DuplicateInvoice,
  type InvoiceRow,
} from "@/lib/domain/invoices";
import { isDuplicateKeyOnIndex, isTransientLockError } from "@/lib/domain/db-errors";
import { ConflictError } from "@/lib/domain/errors";
import { writeInvoiceFile, sha256Hex } from "@/lib/storage/invoice-files";
import type { Actor } from "@/lib/authz";
import {
  migrateTestDatabase,
  resetDatabase,
  createFixtures,
  type Fixtures,
} from "./helpers/test-db";

let fx: Fixtures;

beforeAll(async () => {
  await migrateTestDatabase();
  process.env.INVOICE_STORAGE_DIR = "/tmp/truestock-invoice-duplicate-upload-test";
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uploadInput(bytes: Buffer, vendorId?: number) {
  return {
    ...(vendorId != null ? { vendorId } : {}),
    source: "pdf" as const,
    contentType: "application/pdf",
    fileSha256: sha256Hex(bytes),
    fileSizeBytes: bytes.byteLength,
  };
}

/** Request an upload slot and expect a new invoice (not a refusal). */
async function requestUpload(actor: Actor, bytes: Buffer, vendorId?: number): Promise<InvoiceRow> {
  const result = await createInvoiceForUpload(actor, uploadInput(bytes, vendorId));
  if (result.outcome !== "created") {
    throw new Error("expected a new invoice, got a duplicate refusal");
  }
  return result.invoice;
}

/** Request a slot, write the bytes and confirm: the invoice now holds the claim. */
async function uploadAndConfirm(actor: Actor, bytes: Buffer, vendorId?: number): Promise<InvoiceRow> {
  const created = await requestUpload(actor, bytes, vendorId);
  await writeInvoiceFile(created.filePath!, bytes);
  const confirmed = await markUploadConfirmed(actor, created.id);
  expect(confirmed.matched).toBe(true);
  return created;
}

async function invoiceRow(id: number) {
  const [row] = await db.select().from(invoice).where(eq(invoice.id, id));
  return row;
}

async function jobFor(invoiceId: number) {
  const [row] = await db.select().from(extractionJob).where(eq(extractionJob.invoiceId, invoiceId));
  return row;
}
// (`jobsFor`, the plural, is declared with the slice 8 tests below.)

async function counts() {
  const invoices = await db.select({ id: invoice.id }).from(invoice);
  const jobs = await db.select({ id: extractionJob.id }).from(extractionJob);
  return { invoices: invoices.length, jobs: jobs.length };
}

function expectDuplicate(result: CreateInvoiceForUploadResult): DuplicateInvoice {
  if (result.outcome !== "duplicate") {
    throw new Error("expected a duplicate refusal, got a new invoice");
  }
  return result.duplicate;
}

const BYTES = Buffer.from("synthetic invoice A");

// ---------------------------------------------------------------------------
// Refusal at the upload request
// ---------------------------------------------------------------------------

describe("upload request", () => {
  test("second_upload_refused_names_original: nothing is created, and the reply names the first invoice", async () => {
    const first = await uploadAndConfirm(fx.owner, BYTES, fx.vendorId);
    await db
      .update(invoice)
      .set({ invoiceNumber: "INV-7731", invoiceDate: "2026-10-30" })
      .where(eq(invoice.id, first.id));
    const before = await counts();

    const duplicate = expectDuplicate(await createInvoiceForUpload(fx.owner, uploadInput(BYTES)));

    expect(duplicate.invoiceId).toBe(first.id);
    expect(duplicate.invoiceNumber).toBe("INV-7731");
    expect(duplicate.invoiceDate).toBe("2026-10-30");
    expect(duplicate.vendorName).not.toBeNull();
    expect(duplicate.status).toBe("uploaded");
    expect(duplicate.uploadedAt).toBeInstanceOf(Date);
    // Refused means refused: no invoice row, no extraction job.
    expect(await counts()).toEqual(before);
  });

  test("a different file is not refused (positive control for the refusal above)", async () => {
    await uploadAndConfirm(fx.owner, BYTES);
    const second = await createInvoiceForUpload(fx.owner, uploadInput(Buffer.from("synthetic invoice B")));
    expect(second.outcome).toBe("created");
  });

  test("refused_across_orgs_is_not: the same bytes in another organization are allowed, and both can go live", async () => {
    const mine = await uploadAndConfirm(fx.owner, BYTES);

    const theirs = await requestUpload(fx.otherOwner, BYTES);
    await writeInvoiceFile(theirs.filePath!, BYTES);
    const confirmed = await markUploadConfirmed(fx.otherOwner, theirs.id);

    expect(confirmed.matched).toBe(true);
    expect(confirmed.duplicate).toBeUndefined();
    expect((await invoiceRow(mine.id)).liveFileSha256).toBe(sha256Hex(BYTES));
    expect((await invoiceRow(theirs.id)).liveFileSha256).toBe(sha256Hex(BYTES));
    expect((await jobFor(theirs.id)).status).toBe("queued");
  });

  test("reply_shows_no_other_tenant_detail: a refusal describes only the caller's own invoice", async () => {
    // The other tenant holds the same bytes, with identifiable details.
    const theirs = await uploadAndConfirm(fx.otherOwner, BYTES, fx.otherVendorId);
    await db
      .update(invoice)
      .set({ invoiceNumber: "OTHER-TENANT-9999", invoiceDate: "2020-01-02" })
      .where(eq(invoice.id, theirs.id));
    const [otherVendor] = await db.select().from(vendor).where(eq(vendor.id, fx.otherVendorId));

    // Caller's org has nothing live: it is allowed, and the reply is just its own new row.
    const mineResult = await createInvoiceForUpload(fx.owner, uploadInput(BYTES));
    expect(mineResult.outcome).toBe("created");
    expect(await findLiveCopy(fx.organizationId, sha256Hex(BYTES))).toBeNull();
    expect(JSON.stringify(mineResult)).not.toContain("OTHER-TENANT-9999");

    // Once the caller's org holds a live copy, the refusal names THAT one only.
    const mine = await uploadAndConfirm(fx.owner, Buffer.from("a second synthetic document"), fx.vendorId);
    await db.update(invoice).set({ invoiceNumber: "MINE-1" }).where(eq(invoice.id, mine.id));
    const refusal = expectDuplicate(
      await createInvoiceForUpload(fx.owner, uploadInput(Buffer.from("a second synthetic document"))),
    );
    const text = JSON.stringify(refusal);
    expect(refusal.invoiceId).toBe(mine.id);
    expect(text).toContain("MINE-1");
    expect(text).not.toContain("OTHER-TENANT-9999");
    expect(text).not.toContain(otherVendor.name);
    // Exactly the documented fields: nothing money-bearing or path-bearing rides along.
    expect(Object.keys(refusal).sort()).toEqual(
      ["invoiceDate", "invoiceId", "invoiceNumber", "status", "uploadedAt", "vendorName"].sort(),
    );
  });

  test("abandoned_upload_blocks_nothing: a slot that was never confirmed holds no claim", async () => {
    // Slot requested, bytes even written, but confirm never called.
    const abandoned = await requestUpload(fx.owner, BYTES);
    await writeInvoiceFile(abandoned.filePath!, BYTES);
    expect((await invoiceRow(abandoned.id)).liveFileSha256).toBeNull();

    const retry = await uploadAndConfirm(fx.owner, BYTES);

    expect(retry.id).not.toBe(abandoned.id);
    expect((await invoiceRow(retry.id)).liveFileSha256).toBe(sha256Hex(BYTES));
    expect((await jobFor(abandoned.id)).status).toBe("awaiting_upload");
  });
});

// ---------------------------------------------------------------------------
// The claim at confirm
// ---------------------------------------------------------------------------

describe("claim at confirm", () => {
  test("claim_set_at_confirm_only: not at request, not at PUT, only once the bytes verify and the job queues", async () => {
    const created = await requestUpload(fx.owner, BYTES);
    expect((await invoiceRow(created.id)).liveFileSha256).toBeNull();

    await writeInvoiceFile(created.filePath!, BYTES);
    expect((await invoiceRow(created.id)).liveFileSha256).toBeNull();

    // Confirm with the wrong bytes on disk: not verified, so no claim, no queueing.
    await writeInvoiceFile(created.filePath!, Buffer.from("something else entirely"));
    const bad = await markUploadConfirmed(fx.owner, created.id);
    expect(bad.matched).toBe(false);
    expect((await invoiceRow(created.id)).liveFileSha256).toBeNull();
    expect((await jobFor(created.id)).status).toBe("awaiting_upload");

    await writeInvoiceFile(created.filePath!, BYTES);
    const good = await markUploadConfirmed(fx.owner, created.id);
    expect(good.matched).toBe(true);
    expect((await invoiceRow(created.id)).liveFileSha256).toBe(sha256Hex(BYTES));
    expect((await jobFor(created.id)).status).toBe("queued");
  });

  test("a replayed confirm by the winner is still a success, not a duplicate of itself", async () => {
    const created = await uploadAndConfirm(fx.owner, BYTES);
    const replay = await markUploadConfirmed(fx.owner, created.id);
    expect(replay.matched).toBe(true);
    expect(replay.duplicate).toBeUndefined();
  });

  test("loser_at_confirm_stays_awaiting_upload_with_a_named_duplicate", async () => {
    // Both uploads pass the lookup (neither is confirmed yet): that is the race.
    const winner = await requestUpload(fx.owner, BYTES, fx.vendorId);
    const loser = await requestUpload(fx.owner, BYTES);
    await writeInvoiceFile(winner.filePath!, BYTES);
    await writeInvoiceFile(loser.filePath!, BYTES);

    expect((await markUploadConfirmed(fx.owner, winner.id)).matched).toBe(true);
    const result = await markUploadConfirmed(fx.owner, loser.id);

    expect(result.matched).toBe(false);
    expect(result.duplicate?.invoiceId).toBe(winner.id);
    expect(result.duplicate?.vendorName).not.toBeNull();
    // The loser is left exactly as an abandoned upload is: no claim, not queued.
    expect((await invoiceRow(loser.id)).liveFileSha256).toBeNull();
    expect((await jobFor(loser.id)).status).toBe("awaiting_upload");
    // The winner is untouched.
    expect((await invoiceRow(winner.id)).liveFileSha256).toBe(sha256Hex(BYTES));
    expect((await jobFor(winner.id)).status).toBe("queued");
  });

  test("the unique index, not the lookup, decides: a lookup that finds nothing still cannot create a second live copy", async () => {
    const a = await requestUpload(fx.owner, BYTES);
    const b = await requestUpload(fx.owner, BYTES);
    await db.update(invoice).set({ liveFileSha256: sha256Hex(BYTES) }).where(eq(invoice.id, a.id));

    // Straight at the database: a second claim in the same organization is refused.
    const attempt = db.update(invoice).set({ liveFileSha256: sha256Hex(BYTES) }).where(eq(invoice.id, b.id));
    await expect((async () => attempt)()).rejects.toThrow();
  });

  test("claimFileTx_after_an_older_snapshot_never_answers_with_nobody: a locking read finds the winner or fails retryably, a plain one would see nobody", async () => {
    const winner = await requestUpload(fx.owner, BYTES);
    const loser = await requestUpload(fx.owner, BYTES);
    const sha = sha256Hex(BYTES);

    // The loser's transaction takes its consistent-read snapshot BEFORE the
    // winner commits: the repeatable-read hazard. A plain select after the
    // 1062 reads that older snapshot and finds nobody, which would surface as a
    // refusal with nothing to name. A locking read is a current read: it finds
    // the winner, or (MariaDB 11.8, innodb_snapshot_isolation) refuses with
    // 1020 ER_CHECKREAD, which `withLockRetry` retries from a fresh snapshot.
    // Either is correct; "no holder" is the one wrong answer.
    let outcome: "holder" | "transient" | "wrong" = "wrong";
    let holder: DuplicateInvoice | null = null;
    try {
      await db.transaction(async (tx) => {
        await tx.select({ id: invoice.id }).from(invoice).where(eq(invoice.id, loser.id));
        await db.update(invoice).set({ liveFileSha256: sha }).where(eq(invoice.id, winner.id));
        holder = await claimFileTx(tx, fx.organizationId, loser.id, sha);
      });
      outcome = "holder";
    } catch (err) {
      outcome = isTransientLockError(err) ? "transient" : "wrong";
    }

    expect(["holder", "transient"]).toContain(outcome);
    if (outcome === "holder") {
      expect((holder as DuplicateInvoice | null)?.invoiceId).toBe(winner.id);
    }
  });

  test("a 1062 on some OTHER unique index is not mistaken for a duplicate file", async () => {
    const driver = (message: string) =>
      new DrizzleQueryError(
        "update ...",
        [],
        Object.assign(new Error(message), { code: "ER_DUP_ENTRY", errno: 1062 }),
      );
    expect(
      isDuplicateKeyOnIndex(
        driver("Duplicate entry '1-5' for key 'invoice_organization_live_file_sha256_unique'"),
        "invoice_organization_live_file_sha256_unique",
      ),
    ).toBe(true);
    expect(
      isDuplicateKeyOnIndex(
        driver("Duplicate entry '1-5' for key 'invoice_organization_id_id_unique'"),
        "invoice_organization_live_file_sha256_unique",
      ),
    ).toBe(false);
    expect(
      isDuplicateKeyOnIndex(new Error("invoice_organization_live_file_sha256_unique"), "invoice_organization_live_file_sha256_unique"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Server actions: who may open the duplicate
// ---------------------------------------------------------------------------

describe("actions", () => {
  async function uploadAs(actor: Actor, bytes: Buffer) {
    sessionUserId = actor.userId;
    const { uploadInvoiceAction } = await import("@/app/actions/invoices");
    return uploadInvoiceAction(uploadInput(bytes));
  }

  test("owner_gets_canOpen_true", async () => {
    const first = await uploadAndConfirm(fx.owner, BYTES);
    const result = await uploadAs(fx.owner, BYTES);

    expect(result.ok).toBe(true);
    if (!result.ok || result.data.outcome !== "duplicate") throw new Error("expected duplicate");
    expect(result.data.canOpen).toBe(true);
    expect(result.data.duplicate.invoiceId).toBe(first.id);
  });

  test("manager_gets_canOpen_false: still told which invoice it is, but no link to open it", async () => {
    const first = await uploadAndConfirm(fx.owner, BYTES);
    await db.update(invoice).set({ invoiceNumber: "INV-1" }).where(eq(invoice.id, first.id));
    const result = await uploadAs(fx.manager, BYTES);

    expect(result.ok).toBe(true);
    if (!result.ok || result.data.outcome !== "duplicate") throw new Error("expected duplicate");
    expect(result.data.canOpen).toBe(false);
    expect(result.data.duplicate.invoiceNumber).toBe("INV-1");
  });

  test("staff may not upload at all, duplicate or not", async () => {
    await uploadAndConfirm(fx.owner, BYTES);
    const result = await uploadAs(fx.staff, BYTES);
    expect(result.ok).toBe(false);
  });

  test("a new file through the action is outcome created with an upload url", async () => {
    const result = await uploadAs(fx.manager, BYTES);
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.outcome !== "created") throw new Error("expected created");
    expect(result.data.uploadUrl).toBe(`/api/invoices/${result.data.invoiceId}/file`);
    expect(result.data.status).toBe("uploaded");
  });

  test("confirm passes the duplicate through with canOpen by role", async () => {
    const winner = await requestUpload(fx.owner, BYTES);
    const ownerLoser = await requestUpload(fx.owner, BYTES);
    const managerLoser = await requestUpload(fx.manager, BYTES);
    for (const row of [winner, ownerLoser, managerLoser]) await writeInvoiceFile(row.filePath!, BYTES);
    await markUploadConfirmed(fx.owner, winner.id);

    const { confirmUploadAction } = await import("@/app/actions/invoices");

    sessionUserId = fx.owner.userId;
    const asOwner = await confirmUploadAction({ invoiceId: ownerLoser.id });
    sessionUserId = fx.manager.userId;
    const asManager = await confirmUploadAction({ invoiceId: managerLoser.id });

    if (!asOwner.ok || !asManager.ok) throw new Error("confirm should answer, not error");
    expect(asOwner.data.matched).toBe(false);
    expect(asOwner.data.duplicate?.invoiceId).toBe(winner.id);
    expect(asOwner.data.canOpen).toBe(true);
    expect(asManager.data.duplicate?.invoiceId).toBe(winner.id);
    expect(asManager.data.canOpen).toBe(false);
    expect(asManager.data.status).toBe("uploaded");
  });
});

// ---------------------------------------------------------------------------
// Slice 8: rejecting releases the claim, resend re-takes it, and the races
// ---------------------------------------------------------------------------

/** A confirmed invoice holds the claim; park it at `status` the way the pipeline would. */
async function confirmedAt(
  actor: Actor,
  bytes: Buffer,
  status: "needs_review" | "reviewed",
  jobStatus: "done" | "failed" = "done",
): Promise<InvoiceRow> {
  const created = await uploadAndConfirm(actor, bytes);
  await db.update(invoice).set({ status }).where(eq(invoice.id, created.id));
  await db.update(extractionJob).set({ status: jobStatus }).where(eq(extractionJob.invoiceId, created.id));
  return created;
}

async function reject(actor: Actor, id: number, from: "needs_review" | "reviewed") {
  return updateInvoiceStatus(actor, id, from, "rejected", { rejectionReason: "synthetic" });
}

async function jobsFor(invoiceId: number) {
  return db.select().from(extractionJob).where(eq(extractionJob.invoiceId, invoiceId));
}

describe("reject releases the claim", () => {
  for (const source of ["needs_review", "reviewed"] as const) {
    test(`reject_releases_claim_on_every_source_status: from ${source}`, async () => {
      const a = await confirmedAt(fx.owner, BYTES, source);
      expect((await invoiceRow(a.id)).liveFileSha256).toBe(sha256Hex(BYTES));

      const rejected = await reject(fx.owner, a.id, source);

      expect(rejected.status).toBe("rejected");
      expect((await invoiceRow(a.id)).liveFileSha256).toBeNull();
      expect(await findLiveCopy(fx.organizationId, sha256Hex(BYTES))).toBeNull();
    });
  }

  test("reject_releases_claim_on_every_source_status: a caller cannot re-assert the claim through data", async () => {
    const a = await confirmedAt(fx.owner, BYTES, "needs_review");
    await updateInvoiceStatus(fx.owner, a.id, "needs_review", "rejected", {
      rejectionReason: "synthetic",
      liveFileSha256: sha256Hex(BYTES),
    });
    expect((await invoiceRow(a.id)).liveFileSha256).toBeNull();
  });

  test("a status change that is not a rejection keeps the claim", async () => {
    const a = await confirmedAt(fx.owner, BYTES, "needs_review");
    await db
      .update(invoice)
      .set({ invoiceDate: "2026-10-01", invoiceNumber: "X", totalGross: "1.00", totalNet: "1.00" })
      .where(eq(invoice.id, a.id));
    await updateInvoiceStatus(fx.owner, a.id, "needs_review", "processing");
    expect((await invoiceRow(a.id)).liveFileSha256).toBe(sha256Hex(BYTES));
  });

  test("rejected_copy_allows_reupload: the same bytes go live again once the earlier copy is rejected", async () => {
    const a = await confirmedAt(fx.owner, BYTES, "needs_review");
    expect((await createInvoiceForUpload(fx.owner, uploadInput(BYTES))).outcome).toBe("duplicate");

    await reject(fx.owner, a.id, "needs_review");
    const b = await uploadAndConfirm(fx.owner, BYTES);

    expect(b.id).not.toBe(a.id);
    expect((await invoiceRow(b.id)).liveFileSha256).toBe(sha256Hex(BYTES));
    expect((await jobFor(b.id)).status).toBe("queued");
    expect((await invoiceRow(a.id)).liveFileSha256).toBeNull();
  });
});

describe("resend and the claim", () => {
  test("resend of a rejected invoice with no live rival re-claims the file", async () => {
    const a = await confirmedAt(fx.owner, BYTES, "needs_review");
    await reject(fx.owner, a.id, "needs_review");

    const result = await resendInvoiceToExtraction(fx.owner, a.id);

    expect(result.outcome).toBe("resent");
    expect((await invoiceRow(a.id)).status).toBe("processing");
    expect((await invoiceRow(a.id)).liveFileSha256).toBe(sha256Hex(BYTES));
    expect(await jobsFor(a.id)).toHaveLength(2);
    // And it now blocks a fresh upload of the same bytes again.
    expect((await createInvoiceForUpload(fx.owner, uploadInput(BYTES))).outcome).toBe("duplicate");
  });

  test("resend_refused_when_live_copy_appeared: named, no job change, no status change", async () => {
    const a = await confirmedAt(fx.owner, BYTES, "needs_review");
    await reject(fx.owner, a.id, "needs_review");
    const b = await uploadAndConfirm(fx.owner, BYTES, fx.vendorId);
    await db.update(invoice).set({ invoiceNumber: "INV-B" }).where(eq(invoice.id, b.id));
    const jobsBefore = await jobsFor(a.id);
    const rowBefore = await invoiceRow(a.id);

    const result = await resendInvoiceToExtraction(fx.owner, a.id);

    if (result.outcome !== "duplicate") throw new Error("expected a refusal");
    expect(result.duplicate.invoiceId).toBe(b.id);
    expect(result.duplicate.invoiceNumber).toBe("INV-B");
    const rowAfter = await invoiceRow(a.id);
    expect(rowAfter.status).toBe("rejected");
    expect(rowAfter.liveFileSha256).toBeNull();
    expect(rowAfter.rejectionReason).toBe(rowBefore.rejectionReason);
    expect(await jobsFor(a.id)).toEqual(jobsBefore);
    // The holder is untouched.
    expect((await invoiceRow(b.id)).liveFileSha256).toBe(sha256Hex(BYTES));
    expect((await jobFor(b.id)).status).toBe("queued");
  });

  test("resend_from_needs_review_keeps_claim: a failed read retried in place still holds the file", async () => {
    const a = await confirmedAt(fx.owner, BYTES, "needs_review", "failed");

    const result = await resendInvoiceToExtraction(fx.owner, a.id);

    expect(result.outcome).toBe("resent");
    expect((await invoiceRow(a.id)).status).toBe("processing");
    expect((await invoiceRow(a.id)).liveFileSha256).toBe(sha256Hex(BYTES));
    expect(await jobsFor(a.id)).toHaveLength(2);
  });

  test("resend of an invoice that cannot be resent is a conflict, never a false 'already uploaded'", async () => {
    // Old approved rows hold no claim, so this shape is reachable: the status
    // check must answer before the claim is even looked at.
    const a = await confirmedAt(fx.owner, BYTES, "needs_review");
    await reject(fx.owner, a.id, "needs_review");
    const b = await uploadAndConfirm(fx.owner, BYTES);
    await db.update(invoice).set({ status: "approved" }).where(eq(invoice.id, a.id));
    const jobsBefore = await jobsFor(a.id);

    await expect(resendInvoiceToExtraction(fx.owner, a.id)).rejects.toBeInstanceOf(ConflictError);

    const row = await invoiceRow(a.id);
    expect(row.status).toBe("approved");
    expect(row.liveFileSha256).toBeNull();
    expect(await jobsFor(a.id)).toEqual(jobsBefore);
    expect((await invoiceRow(b.id)).liveFileSha256).toBe(sha256Hex(BYTES));
  });

  test("a claim never names the invoice itself: claiming a file you already hold is a clean yes", async () => {
    const a = await uploadAndConfirm(fx.owner, BYTES);
    const holder = await db.transaction((tx) => claimFileTx(tx, fx.organizationId, a.id, sha256Hex(BYTES)));
    expect(holder).toBeNull();
  });

  test("resend by the owner through the action passes the duplicate with canOpen", async () => {
    const a = await confirmedAt(fx.owner, BYTES, "needs_review");
    await reject(fx.owner, a.id, "needs_review");
    const b = await uploadAndConfirm(fx.owner, BYTES);
    sessionUserId = fx.owner.userId;
    const { resendToExtractionAction } = await import("@/app/actions/invoices");

    const result = await resendToExtractionAction({ invoiceId: a.id });

    if (!result.ok || result.data.outcome !== "duplicate") throw new Error("expected a duplicate");
    expect(result.data.canOpen).toBe(true);
    expect(result.data.duplicate.invoiceId).toBe(b.id);
  });

  test("resend by a manager is refused outright, duplicate or not", async () => {
    const a = await confirmedAt(fx.owner, BYTES, "needs_review");
    await reject(fx.owner, a.id, "needs_review");
    sessionUserId = fx.manager.userId;
    const { resendToExtractionAction } = await import("@/app/actions/invoices");
    const result = await resendToExtractionAction({ invoiceId: a.id });
    expect(result.ok).toBe(false);
    expect((await invoiceRow(a.id)).status).toBe("rejected");
  });

  test("a double click on resend of a rejected invoice opens one job and holds one claim", async () => {
    const a = await confirmedAt(fx.owner, BYTES, "needs_review");
    await reject(fx.owner, a.id, "needs_review");

    const settled = await Promise.allSettled([
      resendInvoiceToExtraction(fx.owner, a.id),
      resendInvoiceToExtraction(fx.owner, a.id),
    ]);

    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(await jobsFor(a.id)).toHaveLength(2);
    expect((await invoiceRow(a.id)).liveFileSha256).toBe(sha256Hex(BYTES));
  });
});

describe("races", () => {
  const ROUNDS = 25;

  test("simultaneous_confirms_one_wins: two connections, one claim, the loser gets the duplicate and stays awaiting_upload", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const bytes = Buffer.from(`synthetic race document ${round}`);
      const x = await requestUpload(fx.owner, bytes);
      const y = await requestUpload(fx.owner, bytes);
      await writeInvoiceFile(x.filePath!, bytes);
      await writeInvoiceFile(y.filePath!, bytes);

      const results = await Promise.all([
        markUploadConfirmed(fx.owner, x.id),
        markUploadConfirmed(fx.owner, y.id),
      ]);

      const winners = results.filter((r) => r.matched);
      const losers = results.filter((r) => !r.matched);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const winnerId = winners[0].invoice.id;
      const loserId = losers[0].invoice.id;
      expect(losers[0].duplicate?.invoiceId).toBe(winnerId);

      const live = (await db.select().from(invoice)).filter((r) => r.liveFileSha256 === sha256Hex(bytes));
      expect(live.map((r) => r.id)).toEqual([winnerId]);
      expect((await invoiceRow(loserId)).liveFileSha256).toBeNull();
      expect((await jobFor(loserId)).status).toBe("awaiting_upload");
      expect((await jobFor(winnerId)).status).toBe("queued");
    }
  });

  test("a resend racing a fresh confirm of the same bytes: exactly one invoice ends up holding the file", async () => {
    for (let round = 0; round < 15; round++) {
      const bytes = Buffer.from(`synthetic resend race ${round}`);
      const a = await confirmedAt(fx.owner, bytes, "needs_review");
      await reject(fx.owner, a.id, "needs_review");
      const b = await requestUpload(fx.owner, bytes);
      await writeInvoiceFile(b.filePath!, bytes);

      const [resent, confirmed] = await Promise.all([
        resendInvoiceToExtraction(fx.owner, a.id),
        markUploadConfirmed(fx.owner, b.id),
      ]);

      const live = (await db.select().from(invoice)).filter((r) => r.liveFileSha256 === sha256Hex(bytes));
      expect(live).toHaveLength(1);
      if (resent.outcome === "resent") {
        expect(confirmed.matched).toBe(false);
        expect(confirmed.duplicate?.invoiceId).toBe(a.id);
        expect(live[0].id).toBe(a.id);
        expect((await jobFor(b.id)).status).toBe("awaiting_upload");
        expect(await jobsFor(a.id)).toHaveLength(2);
      } else {
        expect(confirmed.matched).toBe(true);
        expect(resent.duplicate.invoiceId).toBe(b.id);
        expect(live[0].id).toBe(b.id);
        expect((await invoiceRow(a.id)).status).toBe("rejected");
        expect(await jobsFor(a.id)).toHaveLength(1);
      }
    }
  });
});

describe("claimFileTx and other unique indexes", () => {
  test("a 1062 on a DIFFERENT unique index is rethrown, not reported as a duplicate file", async () => {
    // Nothing in the normal schema can make this update collide anywhere but
    // the live-file index, so provoke it: a temporary index that is global
    // rather than per-organization makes the same bytes claimed in two
    // organizations collide on an index claimFileTx has no business answering.
    await uploadAndConfirm(fx.owner, BYTES);
    const theirs = await requestUpload(fx.otherOwner, BYTES);
    await db.execute(sql.raw("ALTER TABLE invoice ADD UNIQUE INDEX tmp_live_file_global (live_file_sha256)"));
    try {
      let caught: unknown = null;
      try {
        await db.transaction((tx) => claimFileTx(tx, fx.otherOrganizationId, theirs.id, sha256Hex(BYTES)));
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      expect(isDuplicateKeyOnIndex(caught, "tmp_live_file_global")).toBe(true);
      expect(isDuplicateKeyOnIndex(caught, "invoice_organization_live_file_sha256_unique")).toBe(false);
    } finally {
      await db.execute(sql.raw("ALTER TABLE invoice DROP INDEX tmp_live_file_global"));
    }
  });
});
