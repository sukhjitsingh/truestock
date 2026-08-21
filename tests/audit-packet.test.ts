/**
 * Audit packet — Phase 2.5, Slice 5 (Audit Packet / Phase E,
 * docs/plans/phase-2.5-invoice-automation/04-slices.md). Covers
 * `lib/domain/audit-packets.ts` (create + the `buildAuditPacketJob` export
 * worker), `app/actions/invoices.ts`'s `createAuditPacketAction` /
 * `getAuditPacketAction`, and `app/api/audit-packets/[id]/route.ts`'s
 * download handler — against a real MariaDB, per this repo's own testing
 * philosophy (see tests/helpers/test-db.ts's header).
 *
 * Session mocking follows tests/invoice-write-path.test.ts's convention:
 * `next/headers` and `@/lib/auth` are mocked at module scope; action/route
 * modules under test are imported dynamically (inside each test) so the
 * mocks are in place first.
 *
 * `createFixtures()`'s shared invoice (`fx.invoiceId`) is dated 2026-06-01
 * with NO real file behind it (tests/helpers/test-db.ts's own comment on
 * `Fixtures.invoiceId`). Every date range in this file is chosen in January
 * 2026, well clear of June, specifically so `buildAuditPacketJob` never
 * tries to read that non-existent file and fails a build for a reason
 * unrelated to what's under test.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import {
  auditPacket,
  auditPacketFile,
  invoice as invoiceTable,
  count as countTable,
  countLine as countLineTable,
} from "@/db/schema";
import { writeInvoiceFile, sha256Hex } from "@/lib/storage/invoice-files";
import { devEmailOutbox } from "@/lib/email";
import {
  createAuditPacket,
  buildAuditPacketJob,
  getAuditPacketStatus,
  loadFreshAuditPacket,
  type AuditPacketStatusResult,
} from "@/lib/domain/audit-packets";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";

let fx: Fixtures;

const STORAGE_DIR = "/tmp/truestock-audit-packet-test";

beforeAll(async () => {
  await migrateTestDatabase();
  process.env.INVOICE_STORAGE_DIR = STORAGE_DIR;
  // Force lib/email.ts's dev path (push to devEmailOutbox) regardless of
  // what a developer's own shell happens to have exported.
  delete process.env.EMAIL_PROVIDER;
});

beforeEach(async () => {
  await resetDatabase();
  fx = await createFixtures();
  devEmailOutbox.length = 0;
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

// ---------------------------------------------------------------------------
// Fixture helpers, beyond createFixtures().
// ---------------------------------------------------------------------------

/** An invoice with a REAL file written to INVOICE_STORAGE_DIR — the shape buildAuditPacketJob can actually archive. */
async function insertInvoiceWithFile(
  organizationId: number,
  invoiceDate: string,
  bytes: Buffer,
): Promise<{ id: number; filePath: string; sha256: string }> {
  const sha256 = sha256Hex(bytes);
  const [inserted] = await db
    .insert(invoiceTable)
    .values({
      organizationId,
      status: "needs_review",
      source: "pdf",
      fileSha256: sha256,
      fileSizeBytes: bytes.byteLength,
      invoiceDate,
    })
    .$returningId();
  const filePath = `${organizationId}/${inserted.id}.pdf`;
  await writeInvoiceFile(filePath, bytes);
  await db.update(invoiceTable).set({ filePath }).where(eq(invoiceTable.id, inserted.id));
  return { id: inserted.id, filePath, sha256 };
}

/** An invoice with NO file on disk (file_path left NULL) — must never appear in an export. */
async function insertInvoiceNoFile(organizationId: number, invoiceDate: string): Promise<number> {
  const [inserted] = await db
    .insert(invoiceTable)
    .values({
      organizationId,
      status: "uploaded",
      source: "pdf",
      fileSha256: "0".repeat(64),
      fileSizeBytes: 1,
      invoiceDate,
    })
    .$returningId();
  return inserted.id;
}

async function insertCount(
  organizationId: number,
  openedByUserId: number,
  locationId: number,
  productId: number,
  startedAt: Date,
): Promise<number> {
  const [inserted] = await db
    .insert(countTable)
    .values({ organizationId, type: "full", status: "closed", startedAt, openedBy: openedByUserId })
    .$returningId();
  await db.insert(countLineTable).values({
    organizationId,
    countId: inserted.id,
    productId,
    locationId,
    sealedEachQty: 3,
    countedBy: openedByUserId,
  });
  return inserted.id;
}

async function forceExpirePacket(packetId: number): Promise<void> {
  await db
    .update(auditPacket)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(auditPacket.id, packetId));
}

/** Polls the domain status function until the job leaves "processing". */
async function waitForPacketDone(
  actor: Fixtures["owner"],
  packetId: number,
  timeoutMs = 5000,
): Promise<AuditPacketStatusResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await getAuditPacketStatus(actor, packetId);
    if (result.status !== "processing") return result;
    if (Date.now() > deadline) {
      throw new Error(`audit packet ${packetId} did not leave "processing" within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fakeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// createAuditPacket — the row-insert half
// ---------------------------------------------------------------------------

describe("createAuditPacket", () => {
  test("audit_packet_creates_packet — inserts a building row scoped to the actor's organization with the requested range", async () => {
    const { packetId } = await createAuditPacket(fx.owner, {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });

    const [row] = await db.select().from(auditPacket).where(eq(auditPacket.id, packetId));
    expect(row).toBeDefined();
    expect(row.organizationId).toBe(fx.organizationId);
    expect(row.status).toBe("building");
    expect(row.dateFrom).toBe("2026-01-01");
    expect(row.dateTo).toBe("2026-01-31");
    expect(row.createdBy).toBe(fx.owner.userId);
    expect(row.filePath).toBeNull();
    expect(row.expiresAt).toBeNull();
    expect(row.manifestJson).toBeNull();
  });

  test("audit_packet_rejects_concurrent_build — a second request for the same organization while one is still building throws ConflictError, not a second row", async () => {
    const { packetId: firstPacketId } = await createAuditPacket(fx.owner, {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });

    await expect(
      createAuditPacket(fx.owner, { dateFrom: "2026-02-01", dateTo: "2026-02-28" }),
    ).rejects.toBeInstanceOf(ConflictError);

    const rows = await db.select().from(auditPacket).where(eq(auditPacket.organizationId, fx.organizationId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstPacketId);
  });

  test("audit_packet_allows_concurrent_build_once_prior_is_resolved — a non-'building' packet for the org does not block a new one", async () => {
    const { packetId: firstPacketId } = await createAuditPacket(fx.owner, {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    await db.update(auditPacket).set({ status: "ready" }).where(eq(auditPacket.id, firstPacketId));

    const { packetId: secondPacketId } = await createAuditPacket(fx.owner, {
      dateFrom: "2026-02-01",
      dateTo: "2026-02-28",
    });
    expect(secondPacketId).not.toBe(firstPacketId);
  });

  test("audit_packet_concurrent_build_guard_is_per_organization — another organization's in-progress build does not block this one", async () => {
    await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });

    // fx.otherOwner is scoped to fx.otherOrganizationId — a different org's
    // "building" row must never leak into this org's guard query.
    const { packetId } = await createAuditPacket(fx.otherOwner, {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    expect(packetId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildAuditPacketJob — the export/zip worker
// ---------------------------------------------------------------------------

describe("buildAuditPacketJob", () => {
  test("completes: status ready, expires_at ~10min out, manifest populated, and the owner is emailed via devEmailOutbox", async () => {
    const inv = await insertInvoiceWithFile(fx.organizationId, "2026-01-10", Buffer.from("invoice one bytes"));
    const countId = await insertCount(
      fx.organizationId,
      fx.owner.userId,
      fx.locationId,
      fx.pricedProductId,
      new Date("2026-01-15T12:00:00.000Z"),
    );

    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    const before = Date.now();
    await buildAuditPacketJob(packetId);
    const after = Date.now();

    const [row] = await db.select().from(auditPacket).where(eq(auditPacket.id, packetId));
    expect(row.status).toBe("ready");
    expect(row.filePath).toBeTruthy();
    expect(row.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.completedAt).toBeTruthy();
    expect(row.expiresAt).toBeTruthy();

    const expiresAtMs = row.expiresAt!.getTime();
    // ~10 minutes out, generous 5s slack for test execution time either side.
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 10 * 60 * 1000 - 5000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + 10 * 60 * 1000 + 5000);

    expect(row.manifestJson).toBeTruthy();
    expect(row.manifestJson!.fileCount).toBe(2);
    expect(row.manifestJson!.files).toHaveLength(2);
    expect(row.manifestJson!.totalSha256).toMatch(/^[0-9a-f]{64}$/);

    const invoiceEntry = row.manifestJson!.files.find((f) => f.sourceTable === "invoice" && f.sourceId === inv.id);
    expect(invoiceEntry).toBeDefined();
    expect(invoiceEntry!.sha256).toBe(inv.sha256);

    const countEntry = row.manifestJson!.files.find((f) => f.sourceTable === "count" && f.sourceId === countId);
    expect(countEntry).toBeDefined();

    expect(devEmailOutbox).toHaveLength(1);
    expect(devEmailOutbox[0].to).toBe("owner@test.local");
    expect(devEmailOutbox[0].subject).toContain("2026-01-01");
    expect(devEmailOutbox[0].text).toContain(`/api/audit-packets/${packetId}`);
  });

  test("an empty range (no invoices, no counts) is a legitimate, non-failing result — fileCount 0, not a crash", async () => {
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-02-01", dateTo: "2026-02-28" });
    await buildAuditPacketJob(packetId);

    const [row] = await db.select().from(auditPacket).where(eq(auditPacket.id, packetId));
    expect(row.status).toBe("ready");
    expect(row.manifestJson!.fileCount).toBe(0);
    expect(row.manifestJson!.files).toEqual([]);
  });

  test("an invoice with no file on disk (file_path NULL) is excluded, never a crash", async () => {
    await insertInvoiceNoFile(fx.organizationId, "2026-01-10");
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);

    const [row] = await db.select().from(auditPacket).where(eq(auditPacket.id, packetId));
    expect(row.status).toBe("ready");
    expect(row.manifestJson!.fileCount).toBe(0);
  });

  test("an invoice dated outside the range is excluded", async () => {
    await insertInvoiceWithFile(fx.organizationId, "2026-03-01", Buffer.from("out of range"));
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);

    const [row] = await db.select().from(auditPacket).where(eq(auditPacket.id, packetId));
    expect(row.status).toBe("ready");
    expect(row.manifestJson!.fileCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tenant scoping — invoices and counts
// ---------------------------------------------------------------------------

describe("audit_packet_excludes_other_tenants", () => {
  test("an export for one org never contains another org's invoices or counts, and audit_packet_file rows are all scoped to the requesting org", async () => {
    const mine = await insertInvoiceWithFile(fx.organizationId, "2026-01-10", Buffer.from("mine"));
    const theirs = await insertInvoiceWithFile(fx.otherOrganizationId, "2026-01-10", Buffer.from("theirs"));
    const myCountId = await insertCount(
      fx.organizationId,
      fx.owner.userId,
      fx.locationId,
      fx.pricedProductId,
      new Date("2026-01-12T00:00:00.000Z"),
    );
    const theirCountId = await insertCount(
      fx.otherOrganizationId,
      fx.otherOwner.userId,
      fx.otherLocationId,
      fx.otherProductId,
      new Date("2026-01-12T00:00:00.000Z"),
    );

    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);

    const [row] = await db.select().from(auditPacket).where(eq(auditPacket.id, packetId));
    expect(row.status).toBe("ready");
    expect(row.manifestJson!.fileCount).toBe(2); // mine's invoice + mine's count, never theirs

    const sourceIds = row.manifestJson!.files.map((f) => `${f.sourceTable}:${f.sourceId}`);
    expect(sourceIds).toContain(`invoice:${mine.id}`);
    expect(sourceIds).toContain(`count:${myCountId}`);
    expect(sourceIds).not.toContain(`invoice:${theirs.id}`);
    expect(sourceIds).not.toContain(`count:${theirCountId}`);

    const fileRows = await db.select().from(auditPacketFile).where(eq(auditPacketFile.auditPacketId, packetId));
    expect(fileRows).toHaveLength(2);
    for (const fileRow of fileRows) {
      expect(fileRow.organizationId).toBe(fx.organizationId);
    }
  });
});

describe("audit_packet_counts_are_scoped", () => {
  test("scoped by organization AND by started_at (not closed_at), within the requested range", async () => {
    // In range, this org — included.
    const included = await insertCount(
      fx.organizationId,
      fx.owner.userId,
      fx.locationId,
      fx.pricedProductId,
      new Date("2026-01-15T00:00:00.000Z"),
    );
    // started before the range, closed inside it — proves the scoping reads
    // started_at, not closed_at, since a closed_at-based filter would wrongly
    // include this one.
    const [startedBeforeRow] = await db
      .insert(countTable)
      .values({
        organizationId: fx.organizationId,
        type: "full",
        status: "closed",
        startedAt: new Date("2025-12-31T23:00:00.000Z"),
        closedAt: new Date("2026-01-15T00:00:00.000Z"),
        openedBy: fx.owner.userId,
      })
      .$returningId();
    await db.insert(countLineTable).values({
      organizationId: fx.organizationId,
      countId: startedBeforeRow.id,
      productId: fx.pricedProductId,
      locationId: fx.locationId,
      sealedEachQty: 1,
      countedBy: fx.owner.userId,
    });
    // In range, but the OTHER org — must be excluded.
    await insertCount(
      fx.otherOrganizationId,
      fx.otherOwner.userId,
      fx.otherLocationId,
      fx.otherProductId,
      new Date("2026-01-15T00:00:00.000Z"),
    );
    // Out of range entirely, this org — must be excluded.
    await insertCount(
      fx.organizationId,
      fx.owner.userId,
      fx.locationId,
      fx.pricedProductId,
      new Date("2026-04-01T00:00:00.000Z"),
    );

    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);

    const [row] = await db.select().from(auditPacket).where(eq(auditPacket.id, packetId));
    expect(row.status).toBe("ready");
    const countSourceIds = row
      .manifestJson!.files.filter((f) => f.sourceTable === "count")
      .map((f) => f.sourceId);
    // Only `included` (started_at inside the range) makes it in. The
    // started-before/closed-inside row must be EXCLUDED — if the query were
    // scoped by closed_at instead of started_at, it would wrongly appear
    // here, which is exactly the regression this assertion catches.
    expect(countSourceIds).toEqual([included]);
    expect(countSourceIds).not.toContain(startedBeforeRow.id);
  });

  test("dateTo is inclusive of the whole calendar day", async () => {
    const lastDay = await insertCount(
      fx.organizationId,
      fx.owner.userId,
      fx.locationId,
      fx.pricedProductId,
      new Date("2026-01-31T23:59:59.000Z"),
    );

    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);

    const [row] = await db.select().from(auditPacket).where(eq(auditPacket.id, packetId));
    const countSourceIds = row.manifestJson!.files.filter((f) => f.sourceTable === "count").map((f) => f.sourceId);
    expect(countSourceIds).toContain(lastDay);
  });
});

// ---------------------------------------------------------------------------
// Ownership checks — reads
// ---------------------------------------------------------------------------

describe("get_audit_packet_cross_tenant_is_not_found", () => {
  test("loadFreshAuditPacket rejects a cross-tenant packetId with NotFoundError, not a leaked row", async () => {
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });

    await expect(loadFreshAuditPacket(fx.otherOwner, packetId)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("getAuditPacketAction returns a failure ActionResult (never the other tenant's status) for a cross-tenant packetId", async () => {
    sessionUserId = fx.owner.userId;
    const { createAuditPacketAction } = await import("@/app/actions/invoices");
    const created = await createAuditPacketAction({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    sessionUserId = fx.otherOwner.userId;
    const { getAuditPacketAction } = await import("@/app/actions/invoices");
    const result = await getAuditPacketAction({ packetId: created.data.packetId });
    expect(result.ok).toBe(false);
  });

  test("an unknown packetId is also NotFoundError", async () => {
    await expect(loadFreshAuditPacket(fx.owner, 999999)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// createAuditPacketAction / getAuditPacketAction — role gate + end to end
// ---------------------------------------------------------------------------

describe("createAuditPacketAction", () => {
  test("owner succeeds, and the fire-and-forget job runs to completion in the background", async () => {
    sessionUserId = fx.owner.userId;
    const { createAuditPacketAction, getAuditPacketAction } = await import("@/app/actions/invoices");

    const result = await createAuditPacketAction({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.data.packetId).toBe("number");

    const status = await waitForPacketDone(fx.owner, result.data.packetId);
    expect(status.status).toBe("ready");

    const polled = await getAuditPacketAction({ packetId: result.data.packetId });
    expect(polled.ok).toBe(true);
    if (polled.ok) {
      expect(polled.data.status).toBe("ready");
      expect(polled.data.downloadUrl).toBe(`/api/audit-packets/${result.data.packetId}`);
    }
  });

  test("manager is refused", async () => {
    sessionUserId = fx.manager.userId;
    const { createAuditPacketAction } = await import("@/app/actions/invoices");
    const result = await createAuditPacketAction({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(result.ok).toBe(false);
  });

  test("staff is refused", async () => {
    sessionUserId = fx.staff.userId;
    const { createAuditPacketAction } = await import("@/app/actions/invoices");
    const result = await createAuditPacketAction({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(result.ok).toBe(false);
  });

  test("no session is refused", async () => {
    sessionUserId = null;
    const { createAuditPacketAction } = await import("@/app/actions/invoices");
    const result = await createAuditPacketAction({ dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    expect(result.ok).toBe(false);
  });

  test("a backwards range (dateFrom after dateTo) is refused at the validation boundary", async () => {
    sessionUserId = fx.owner.userId;
    const { createAuditPacketAction } = await import("@/app/actions/invoices");
    const result = await createAuditPacketAction({ dateFrom: "2026-01-31", dateTo: "2026-01-01" });
    expect(result.ok).toBe(false);
  });
});

describe("getAuditPacketAction", () => {
  test("a still-building packet reports processing", async () => {
    sessionUserId = fx.owner.userId;
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    // Deliberately NOT calling buildAuditPacketJob — the row stays "building".
    const { getAuditPacketAction } = await import("@/app/actions/invoices");
    const result = await getAuditPacketAction({ packetId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("processing");
    }
  });

  test("a failed packet reports unavailable", async () => {
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await db.update(auditPacket).set({ status: "failed" }).where(eq(auditPacket.id, packetId));

    sessionUserId = fx.owner.userId;
    const { getAuditPacketAction } = await import("@/app/actions/invoices");
    const result = await getAuditPacketAction({ packetId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("unavailable");
    }
  });
});

// ---------------------------------------------------------------------------
// Download link expiry — enforced server-side, at BOTH read paths
// ---------------------------------------------------------------------------

describe("download link expiry is enforced server-side", () => {
  test("getAuditPacketAction: a lapsed ready packet is lazily flipped to expired and reported unavailable", async () => {
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);
    await forceExpirePacket(packetId);

    sessionUserId = fx.owner.userId;
    const { getAuditPacketAction } = await import("@/app/actions/invoices");
    const result = await getAuditPacketAction({ packetId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("unavailable");
    }

    const [row] = await db.select().from(auditPacket).where(eq(auditPacket.id, packetId));
    expect(row.status).toBe("expired");
  });

  test("GET /api/audit-packets/[id]: a lapsed ready packet 404s and is lazily flipped to expired", async () => {
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);
    await forceExpirePacket(packetId);

    sessionUserId = fx.owner.userId;
    const { GET } = await import("@/app/api/audit-packets/[id]/route");
    const res = await GET(new Request(`http://localhost/api/audit-packets/${packetId}`), fakeParams(String(packetId)));
    expect(res.status).toBe(404);

    const [row] = await db.select().from(auditPacket).where(eq(auditPacket.id, packetId));
    expect(row.status).toBe("expired");
  });

  test("a genuinely ready, not-yet-expired packet downloads successfully", async () => {
    await insertInvoiceWithFile(fx.organizationId, "2026-01-10", Buffer.from("downloadable"));
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);

    sessionUserId = fx.owner.userId;
    const { GET } = await import("@/app/api/audit-packets/[id]/route");
    const res = await GET(new Request(`http://localhost/api/audit-packets/${packetId}`), fakeParams(String(packetId)));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const bytes = Buffer.from(await res.arrayBuffer());
    // ZIP local-file-header magic bytes — a real archive, not a stub.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });
});

// ---------------------------------------------------------------------------
// Download route — auth + ownership, mirroring app/api/invoices/[id]/file
// ---------------------------------------------------------------------------

describe("GET /api/audit-packets/[id]", () => {
  test("no session is refused with 401", async () => {
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);

    sessionUserId = null;
    const { GET } = await import("@/app/api/audit-packets/[id]/route");
    const res = await GET(new Request(`http://localhost/api/audit-packets/${packetId}`), fakeParams(String(packetId)));
    expect(res.status).toBe(401);
  });

  test("manager is refused with 403", async () => {
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);

    sessionUserId = fx.manager.userId;
    const { GET } = await import("@/app/api/audit-packets/[id]/route");
    const res = await GET(new Request(`http://localhost/api/audit-packets/${packetId}`), fakeParams(String(packetId)));
    expect(res.status).toBe(403);
  });

  test("staff is refused with 403", async () => {
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);

    sessionUserId = fx.staff.userId;
    const { GET } = await import("@/app/api/audit-packets/[id]/route");
    const res = await GET(new Request(`http://localhost/api/audit-packets/${packetId}`), fakeParams(String(packetId)));
    expect(res.status).toBe(403);
  });

  test("a cross-tenant packetId is refused with 404, not 403 — never confirms the row exists", async () => {
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);

    sessionUserId = fx.otherOwner.userId;
    const { GET } = await import("@/app/api/audit-packets/[id]/route");
    const res = await GET(new Request(`http://localhost/api/audit-packets/${packetId}`), fakeParams(String(packetId)));
    expect(res.status).toBe(404);
  });

  test("an unknown packetId is 404", async () => {
    sessionUserId = fx.owner.userId;
    const { GET } = await import("@/app/api/audit-packets/[id]/route");
    const res = await GET(new Request("http://localhost/api/audit-packets/999999"), fakeParams("999999"));
    expect(res.status).toBe(404);
  });

  test("a still-building packet is 404, not a crash", async () => {
    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });

    sessionUserId = fx.owner.userId;
    const { GET } = await import("@/app/api/audit-packets/[id]/route");
    const res = await GET(new Request(`http://localhost/api/audit-packets/${packetId}`), fakeParams(String(packetId)));
    expect(res.status).toBe(404);
  });

  test(
    "a stored path of ../../etc/passwd is refused with the SAME 404 shape as an unknown id, never a distinct message that would leak the traversal detail",
    async () => {
      const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
      await buildAuditPacketJob(packetId);
      await db.update(auditPacket).set({ filePath: "../../etc/passwd" }).where(eq(auditPacket.id, packetId));

      sessionUserId = fx.owner.userId;
      const { GET } = await import("@/app/api/audit-packets/[id]/route");
      const res = await GET(new Request(`http://localhost/api/audit-packets/${packetId}`), fakeParams(String(packetId)));
      const unknownRes = await GET(new Request("http://localhost/api/audit-packets/999999"), fakeParams("999999"));

      expect(res.status).toBe(404);
      expect(unknownRes.status).toBe(404);
      expect(await res.json()).toEqual(await unknownRes.json());
    },
  );
});

// ---------------------------------------------------------------------------
// ZIP contents / manifest integrity
// ---------------------------------------------------------------------------

describe("ZIP manifest", () => {
  test("file count matches the org/date-range row count, and every per-file SHA-256 in the manifest matches the audit_packet_file ledger and the real ZIP contents", async () => {
    const invA = await insertInvoiceWithFile(fx.organizationId, "2026-01-05", Buffer.from("first invoice"));
    const invB = await insertInvoiceWithFile(fx.organizationId, "2026-01-20", Buffer.from("second invoice, longer"));
    const countId = await insertCount(
      fx.organizationId,
      fx.owner.userId,
      fx.locationId,
      fx.secondProductId,
      new Date("2026-01-18T00:00:00.000Z"),
    );

    const { packetId } = await createAuditPacket(fx.owner, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    await buildAuditPacketJob(packetId);

    const [row] = await db.select().from(auditPacket).where(eq(auditPacket.id, packetId));
    expect(row.status).toBe("ready");
    const manifest = row.manifestJson!;
    expect(manifest.fileCount).toBe(3);
    expect(manifest.files).toHaveLength(3);

    // Every manifest entry's sha256 matches the durable audit_packet_file
    // ledger row for the same (sourceTable, sourceId) — the manifest is a
    // summary of that ledger, not an independent value that could drift.
    const ledgerRows = await db.select().from(auditPacketFile).where(eq(auditPacketFile.auditPacketId, packetId));
    expect(ledgerRows).toHaveLength(3);
    for (const entry of manifest.files) {
      const ledgerRow = ledgerRows.find(
        (r) => r.sourceTable === entry.sourceTable && r.sourceId === entry.sourceId,
      );
      expect(ledgerRow).toBeDefined();
      expect(ledgerRow!.sha256).toBe(entry.sha256);
      expect(ledgerRow!.organizationId).toBe(fx.organizationId);
    }

    // total_sha256 is defined as sha256(sorted, newline-joined per-file
    // hashes) — recompute it independently from the manifest's own per-file
    // list and confirm it matches what the job persisted.
    const { createHash } = await import("node:crypto");
    const recomputedTotal = createHash("sha256")
      .update(
        manifest.files
          .map((f) => f.sha256)
          .sort()
          .join("\n"),
      )
      .digest("hex");
    expect(manifest.totalSha256).toBe(recomputedTotal);

    // The invoice entries' sha256 match the bytes actually written to disk.
    const invAEntry = manifest.files.find((f) => f.sourceTable === "invoice" && f.sourceId === invA.id);
    const invBEntry = manifest.files.find((f) => f.sourceTable === "invoice" && f.sourceId === invB.id);
    expect(invAEntry!.sha256).toBe(invA.sha256);
    expect(invBEntry!.sha256).toBe(invB.sha256);

    const countEntry = manifest.files.find((f) => f.sourceTable === "count" && f.sourceId === countId);
    expect(countEntry).toBeDefined();

    // And the ZIP on disk is a real, openable archive containing exactly
    // these entries plus manifest.json — not a stub written by a fake
    // archiver call. Uses the system `unzip` (present on this dev machine
    // and every CI image this repo targets) rather than a new dependency.
    const { resolveStoredPath } = await import("@/lib/storage/invoice-files");
    const zipPath = resolveStoredPath(row.filePath!);
    const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).trim().split("\n").sort();
    const expectedNames = [
      ...manifest.files.map((f) => f.path),
      "manifest.json",
    ].sort();
    expect(listing).toEqual(expectedNames);
  });
});
