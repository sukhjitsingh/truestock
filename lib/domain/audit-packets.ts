/**
 * Audit packet domain logic — Phase 2.5, Slice 5
 * (`docs/plans/phase-2.5-invoice-automation/04-slices.md`, "Slice 5 — Audit
 * Packet (Phase E)"). An owner requests a date-range export; a background
 * job builds a ZIP of every invoice original and every count (as JSON) in
 * that range, plus a SHA-256 manifest, and emails a download link.
 *
 * ## Two entry points, two very different trust boundaries
 *
 * `createAuditPacket` runs inside a request, with a real `Actor` —
 * `organizationId` comes from `requireRole`, re-read from the database on
 * every call (invariant 9).
 *
 * `buildAuditPacketJob(packetId)` does NOT. It is invoked fire-and-forget
 * from `app/actions/invoices.ts:createAuditPacketAction`, decoupled from
 * that request/response — by the time it runs, the HTTP request that
 * started it may already have returned. It is handed only a `packetId` and
 * NEVER accepts an organization from a caller — `orgId` is read from the
 * `audit_packet` row itself, and every query the job makes filters on that
 * value **[AR-3]**. The earlier draft of this slice queried invoices by
 * date range alone; tenants share a calendar, so that ZIP would have
 * silently contained every organization's invoices for the range, emailed
 * as a durable file, with nothing appearing broken.
 *
 * ## The [AR-3] backstop, and why candidate rows carry the SOURCE row's own organizationId
 *
 * Before anything is written, the job asserts every candidate
 * `audit_packet_file` row shares exactly one distinct `organizationId`,
 * matching `orgId`. That assertion is only meaningful because each
 * candidate's `organizationId` is copied from the `invoice`/`count` row it
 * was built from (`inv.organizationId` / `c.organizationId`), NOT
 * hardcoded to the expected `orgId` — copying the expected value onto every
 * row would make the assertion pass unconditionally regardless of whether
 * the query above it actually filtered correctly, which is exactly the
 * silent-regression shape [AR-3] exists to catch. If the assertion ever
 * fires, it is treated as an internal invariant failure: throw, let the
 * job's own top-level catch mark the packet `failed`, and log loudly —
 * never silently drop the offending rows to make the assertion pass.
 *
 * ## Never throws past its own boundary
 *
 * Mirrors `lib/domain/extraction-pipeline.ts:processExtractionQueue`'s own
 * reasoning: a background job with no request to return an error to must
 * record its own failure rather than produce an unhandled rejection. Every
 * failure inside `buildAuditPacketJob` — a missing file on disk, an [AR-3]
 * violation, a database error — is caught at the top level, written onto
 * `audit_packet.status = 'failed'`, logged server-side, and NOT rethrown.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
// archiver@8 is ESM with named exports only (no default `archiver('zip', ...)`
// factory) — `@types/archiver`'s d.ts reflects that, so this is `new
// ZipArchive(options)`, not `archiver('zip', options)` (the pre-8 API most
// examples online still show).
import { ZipArchive } from "archiver";
import { and, eq, gte, inArray, isNotNull, lt, lte } from "drizzle-orm";
import { db } from "@/db";
import { auditPacket, auditPacketFile, count, countLine, invoice, user } from "@/db/schema";
import type { auditPacketSourceTableEnum } from "@/db/enums";
import type { Actor } from "@/lib/authz";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";
import { resolveStoredPath, sha256Hex } from "@/lib/storage/invoice-files";
import { sendEmail } from "@/lib/email";

export type AuditPacketRow = typeof auditPacket.$inferSelect;
type AuditPacketSourceTable = (typeof auditPacketSourceTableEnum)[number];

// ---------------------------------------------------------------------------
// createAuditPacket
// ---------------------------------------------------------------------------

export interface CreateAuditPacketInput {
  dateFrom: string;
  dateTo: string;
}

export interface CreateAuditPacketResult {
  packetId: number;
}

/**
 * Inserts the `audit_packet` row (status `building`) and hands back its id.
 *
 * Refuses a second concurrent build for the same organization first
 * (security review finding, 2026-08-20): `buildAuditPacketJob` buffers every
 * matched invoice's bytes in memory before archiving and runs several
 * queries against this app's shared 5-10 connection pool (AGENTS.md — that
 * pool is shared with the production website, on a small Hostinger Cloud
 * Startup plan). Nothing stops a client from calling this twice — a second
 * browser tab, or a click before the UI's `submitting` state (which is
 * UI-only, not server-enforced) disables the button — and two concurrent
 * jobs for the same org roughly doubles that memory/connection pressure for
 * no benefit, since the org only wants one packet. This check is a plain
 * SELECT-then-INSERT, not a DB-level constraint, so it narrows the race
 * without claiming to close it outright — an actual double-submit within the
 * same few milliseconds could still slip both inserts through, but the
 * realistic trigger here (a slow human re-clicking, or a second tab) is
 * seconds apart, not milliseconds, so this is worth having even though it
 * isn't airtight.
 */
export async function createAuditPacket(
  actor: Actor,
  input: CreateAuditPacketInput,
): Promise<CreateAuditPacketResult> {
  const [existingBuild] = await db
    .select({ id: auditPacket.id })
    .from(auditPacket)
    .where(and(eq(auditPacket.organizationId, actor.organizationId), eq(auditPacket.status, "building")))
    .limit(1);
  if (existingBuild) {
    throw new ConflictError(
      "An audit packet is already being built for this organization. Wait for it to finish before requesting another.",
    );
  }

  const [inserted] = await db
    .insert(auditPacket)
    .values({
      organizationId: actor.organizationId,
      status: "building",
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      createdBy: actor.userId,
    })
    .$returningId();
  return { packetId: inserted.id };
}

// ---------------------------------------------------------------------------
// Ownership-checked reads + lazy expiry
// ---------------------------------------------------------------------------

/**
 * Ownership-checked load. The `organizationId` predicate is in the WHERE
 * clause itself, never checked after the fact — a foreign key (or a bare
 * `id` lookup) proves the row exists, not whose it is (invariant 9), so a
 * cross-tenant `packetId` must read exactly like an unknown one.
 */
async function loadOwnedPacket(actor: Actor, packetId: number): Promise<AuditPacketRow> {
  const [row] = await db
    .select()
    .from(auditPacket)
    .where(and(eq(auditPacket.id, packetId), eq(auditPacket.organizationId, actor.organizationId)))
    .limit(1);
  if (!row) {
    throw new NotFoundError("Audit packet");
  }
  return row;
}

/**
 * Ownership-checked load that also lazily expires a `ready` packet whose
 * `expires_at` has lapsed. There is no cron sweep for this download TTL
 * (04-slices.md) — every read path that cares whether a packet is still
 * downloadable (`getAuditPacketStatus` below, and the download route
 * handler) calls this rather than trusting `status` alone, so an expired
 * link is refused at request time even if `status` still says `ready`.
 *
 * The CAS'd UPDATE only fires FROM `ready`, so two concurrent callers both
 * racing this on the same lapsed packet are harmless — the loser's WHERE
 * simply matches zero rows, and both return the same `expired` view.
 */
export async function loadFreshAuditPacket(actor: Actor, packetId: number): Promise<AuditPacketRow> {
  const row = await loadOwnedPacket(actor, packetId);
  if (row.status !== "ready") {
    return row;
  }
  if (row.expiresAt && row.expiresAt.getTime() > Date.now()) {
    return row;
  }
  await db
    .update(auditPacket)
    .set({ status: "expired" })
    .where(
      and(
        eq(auditPacket.id, row.id),
        eq(auditPacket.organizationId, actor.organizationId),
        eq(auditPacket.status, "ready"),
      ),
    );
  return { ...row, status: "expired" };
}

export interface AuditPacketStatusResult {
  status: "ready" | "processing" | "unavailable";
  downloadUrl?: string;
  expiresAt?: string;
}

/**
 * The office UI's poll: `building` -> `processing`; `ready` (and not yet
 * expired, checked at request time via `loadFreshAuditPacket`) ->
 * `{downloadUrl, expiresAt}`; `expired` / `failed` (including `ready` that
 * just got lazily expired above) -> `unavailable`. `downloadUrl` is a
 * same-origin path, matching `uploadInvoiceAction`'s own `uploadUrl` shape.
 */
export async function getAuditPacketStatus(actor: Actor, packetId: number): Promise<AuditPacketStatusResult> {
  const row = await loadFreshAuditPacket(actor, packetId);
  if (row.status === "building") {
    return { status: "processing" };
  }
  if (row.status === "ready" && row.expiresAt) {
    return {
      status: "ready",
      downloadUrl: `/api/audit-packets/${row.id}`,
      expiresAt: row.expiresAt.toISOString(),
    };
  }
  // "expired" | "failed", or a "ready" row with no expiresAt (should never
  // happen once the job completes — treated as unavailable rather than
  // trusted, same plausible-but-wrong-default discipline as everywhere else).
  return { status: "unavailable" };
}

// ---------------------------------------------------------------------------
// buildAuditPacketJob
// ---------------------------------------------------------------------------

interface AuditPacketFileCandidate {
  organizationId: number;
  auditPacketId: number;
  sourceTable: AuditPacketSourceTable;
  sourceId: number;
  /** The path WITHIN the zip archive — see `auditPacketFile`'s own comment. */
  filePath: string;
  sha256: string;
}

interface ZipEntry {
  name: string;
  bytes: Buffer;
}

/**
 * `count.started_at` is a TIMESTAMP (a moment in time), while
 * `packet.date_from`/`date_to` are plain "YYYY-MM-DD" calendar days
 * (db/index.ts's `dateStrings: ["DATE"]`). `dateTo` is INCLUSIVE of that
 * whole calendar day, so the upper bound is the FOLLOWING day at 00:00 UTC,
 * compared with `<` rather than `<=` against some end-of-day instant.
 * MariaDB's server is pinned to `--default-time-zone=+00:00`
 * (docker-compose.yml) and mysql2 returns TIMESTAMP columns as real JS
 * `Date` objects here, so a plain UTC boundary is correct with no
 * local-timezone conversion involved.
 */
function countRangeBounds(dateFrom: string, dateTo: string): { startInclusive: Date; endExclusive: Date } {
  const startInclusive = new Date(`${dateFrom}T00:00:00.000Z`);
  const endExclusive = new Date(new Date(`${dateTo}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000);
  return { startInclusive, endExclusive };
}

/**
 * Deterministic, stable-field-order JSON for one count + its lines — the
 * exported file needs to represent the actual count content, not just the
 * header row. Field order is written out explicitly (never `...row`) so it
 * cannot drift silently if a column is added to either table later.
 */
function serializeCountForArchive(
  row: typeof count.$inferSelect,
  lines: (typeof countLine.$inferSelect)[],
): unknown {
  return {
    id: row.id,
    organizationId: row.organizationId,
    type: row.type,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    openedBy: row.openedBy,
    closedBy: row.closedBy,
    totalValue: row.totalValue,
    notes: row.notes,
    lines: lines
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((line) => ({
        id: line.id,
        productId: line.productId,
        locationId: line.locationId,
        sealedCaseQty: line.sealedCaseQty,
        sealedEachQty: line.sealedEachQty,
        partialFills: line.partialFills,
        unitCostAtCount: line.unitCostAtCount,
        caseSizeAtCount: line.caseSizeAtCount,
        countedBy: line.countedBy,
        countedAt: line.countedAt.toISOString(),
        openedAt: line.openedAt,
      })),
  };
}

/**
 * The actual export/zip worker. See the module header for the trust
 * boundary this operates under: handed only `packetId`, derives `orgId`
 * from the row itself, and every query below filters on that value
 * **[AR-3]**. Never throws past its own boundary — see the module header.
 */
export async function buildAuditPacketJob(packetId: number): Promise<void> {
  try {
    const [packet] = await db.select().from(auditPacket).where(eq(auditPacket.id, packetId)).limit(1);
    if (!packet) {
      throw new Error(`buildAuditPacketJob: audit_packet ${packetId} does not exist`);
    }
    // Read from the row, never from a caller — the whole point of [AR-3].
    const orgId = packet.organizationId;

    const invoiceRows = await db
      .select()
      .from(invoice)
      .where(
        and(
          eq(invoice.organizationId, orgId),
          isNotNull(invoice.filePath),
          gte(invoice.invoiceDate, packet.dateFrom),
          lte(invoice.invoiceDate, packet.dateTo),
        ),
      );

    const { startInclusive, endExclusive } = countRangeBounds(packet.dateFrom, packet.dateTo);
    const countRows = await db
      .select()
      .from(count)
      .where(
        and(eq(count.organizationId, orgId), gte(count.startedAt, startInclusive), lt(count.startedAt, endExclusive)),
      );

    const countLineRows = countRows.length
      ? await db
          .select()
          .from(countLine)
          .where(
            and(
              eq(countLine.organizationId, orgId),
              inArray(
                countLine.countId,
                countRows.map((row) => row.id),
              ),
            ),
          )
      : [];
    const linesByCountId = new Map<number, (typeof countLineRows)[number][]>();
    for (const line of countLineRows) {
      const bucket = linesByCountId.get(line.countId);
      if (bucket) {
        bucket.push(line);
      } else {
        linesByCountId.set(line.countId, [line]);
      }
    }

    // Build every candidate entry (bytes + hash + manifest row) BEFORE
    // opening the zip on disk. This is deliberate: the [AR-3] assertion
    // below must run — and be able to abort the job — before a single byte
    // is written to a file that could later be marked `ready` and made
    // downloadable, not just before the database writes.
    const zipEntries: ZipEntry[] = [];
    const candidates: AuditPacketFileCandidate[] = [];

    for (const inv of invoiceRows) {
      // `isNotNull(invoice.filePath)` above guarantees this at runtime;
      // Drizzle's result type doesn't narrow on a WHERE clause.
      const storedPath = inv.filePath as string;
      const absolutePath = resolveStoredPath(storedPath);
      const bytes = await readFile(absolutePath);
      const sha256 = sha256Hex(bytes);
      const entryName = path.posix.join("invoices", `${inv.id}${path.extname(storedPath)}`);
      zipEntries.push({ name: entryName, bytes });
      candidates.push({
        // The SOURCE row's own organizationId, not the expected `orgId` —
        // see the module header for why this matters to the assertion below.
        organizationId: inv.organizationId,
        auditPacketId: packetId,
        sourceTable: "invoice",
        sourceId: inv.id,
        filePath: entryName,
        sha256,
      });
    }

    for (const row of countRows) {
      const lines = linesByCountId.get(row.id) ?? [];
      const json = JSON.stringify(serializeCountForArchive(row, lines), null, 2);
      const bytes = Buffer.from(json, "utf8");
      const sha256 = sha256Hex(bytes);
      const entryName = path.posix.join("counts", `${row.id}.json`);
      zipEntries.push({ name: entryName, bytes });
      candidates.push({
        organizationId: row.organizationId,
        auditPacketId: packetId,
        sourceTable: "count",
        sourceId: row.id,
        filePath: entryName,
        sha256,
      });
    }

    // [AR-3] backstop — a cheap check that turns a future regression (a
    // query that loses its organization predicate) into a failed build
    // instead of a silent cross-tenant ZIP. An empty range (0 invoices, 0
    // counts) is a legitimate, non-violating result and must not trip this.
    if (candidates.length > 0) {
      const distinctOrgIds = new Set(candidates.map((c) => c.organizationId));
      if (distinctOrgIds.size !== 1 || !distinctOrgIds.has(orgId)) {
        throw new Error(
          `[AR-3] buildAuditPacketJob ${packetId}: candidate files span organization ids ` +
            `${[...distinctOrgIds].join(", ")} (expected exactly one: ${orgId}). Refusing to ` +
            "build a cross-tenant archive.",
        );
      }
    }

    // total_sha256 is defined as the SHA-256 of the sorted, newline-joined
    // list of every per-file sha256 — sorted so the value is independent of
    // query/insertion order, deterministic for the same file set. Computed
    // from the per-file hashes above, not re-derived from the zip's own
    // bytes, so it stays stable even if the zip container format's own
    // encoding ever changes (compression level, entry order, etc.).
    const totalSha256 = createHash("sha256")
      .update(
        candidates
          .map((c) => c.sha256)
          .sort()
          .join("\n"),
      )
      .digest("hex");
    const manifest = {
      fileCount: candidates.length,
      totalSha256,
      files: candidates.map((c) => ({
        path: c.filePath,
        sourceTable: c.sourceTable,
        sourceId: c.sourceId,
        sha256: c.sha256,
      })),
    };

    // Stored under INVOICE_STORAGE_DIR/audit-packets/ — same env var and
    // same outside-the-web-root discipline every other stored file in this
    // app uses (lib/storage/invoice-files.ts's header) — never under
    // public/. Named deterministically by organization + packet id.
    const zipRelativePath = path.posix.join("audit-packets", `truestock-audit-${orgId}-${packetId}.zip`);
    const zipAbsolutePath = resolveStoredPath(zipRelativePath);
    await mkdir(path.dirname(zipAbsolutePath), { recursive: true });

    await writeZipFile(zipAbsolutePath, zipEntries, manifest);

    const zipBytes = await readFile(zipAbsolutePath);
    const zipSha256 = sha256Hex(zipBytes);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const completedAt = new Date();

    await db.transaction(async (tx) => {
      if (candidates.length > 0) {
        await tx.insert(auditPacketFile).values(candidates);
      }
      await tx
        .update(auditPacket)
        .set({
          status: "ready",
          filePath: zipRelativePath,
          fileSha256: zipSha256,
          manifestJson: manifest,
          expiresAt,
          completedAt,
        })
        .where(and(eq(auditPacket.id, packetId), eq(auditPacket.organizationId, orgId)));
    });

    await notifyPacketCreator(packet, packetId, manifest.fileCount, zipSha256);
  } catch (err) {
    console.error(`[audit-packets] buildAuditPacketJob(${packetId}) failed`, err);
    try {
      // Keyed by primary key alone, not organization-scoped: `packetId` is
      // an internal value this job was handed by our own
      // `createAuditPacketAction`, never client input at this point, and if
      // the packet row couldn't even be loaded above there is no `orgId` to
      // scope by. Wrapped in its own try/catch so a failure to RECORD a
      // failure can never itself become an unhandled rejection — mirrors
      // `processExtractionQueue`'s own fallback (lib/domain/extraction-pipeline.ts).
      await db.update(auditPacket).set({ status: "failed" }).where(eq(auditPacket.id, packetId));
    } catch (markFailedErr) {
      console.error(`[audit-packets] buildAuditPacketJob(${packetId}): could not mark packet failed`, markFailedErr);
    }
  }
}

/** Streams a real ZIP (archiver), never a stub, to `absolutePath`. */
async function writeZipFile(absolutePath: string, entries: ZipEntry[], manifest: unknown): Promise<void> {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const output = createWriteStream(absolutePath);

  const done = new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    // Nothing here uses directory globbing (every entry is appended from an
    // in-memory buffer), so archiver has no benign reason to warn — any
    // warning event means something unexpected happened and the job should
    // fail loudly rather than silently ship a truncated archive.
    archive.on("warning", reject);
  });

  archive.pipe(output);
  for (const entry of entries) {
    archive.append(entry.bytes, { name: entry.name });
  }
  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
  await archive.finalize();
  await done;
}

/**
 * Emails the packet's requester (joined via `createdBy` -> `user.email`) a
 * download link. Best-effort and genuinely never throws past this
 * boundary: the packet is already committed `ready` (filePath, hash,
 * manifest all persisted) by the time this runs, so nothing in here —
 * including the `user` lookup, not just `sendEmail` — may propagate and be
 * mistaken by `buildAuditPacketJob`'s outer catch for a build failure. A
 * transient error on the lookup (pool exhaustion, a dropped connection) is
 * logged and swallowed, exactly like a missing creator/email; either way
 * the ZIP already built fine and stays `ready`.
 */
async function notifyPacketCreator(
  packet: AuditPacketRow,
  packetId: number,
  fileCount: number,
  zipSha256: string,
): Promise<void> {
  try {
    const [creator] = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, packet.createdBy))
      .limit(1);
    if (!creator?.email) {
      console.error(
        `[audit-packets] buildAuditPacketJob(${packetId}): creator user ${packet.createdBy} has no email`,
      );
      return;
    }

    // Absolute link for the email (a relative path is meaningless outside the
    // app); same-origin `BETTER_AUTH_URL` convention lib/auth.ts already
    // relies on as this app's canonical origin. There is no signed-token
    // infra yet — the "signed" part of "signed download link (TTL 10 min)" is
    // satisfied by the route itself enforcing session + ownership + expiry
    // server-side (app/api/audit-packets/[id]/route.ts), the same way every
    // other stored file in this app is already gated, not by a bearer token
    // in the URL.
    const baseUrl = process.env.BETTER_AUTH_URL?.replace(/\/$/, "") ?? "";
    const downloadUrl = `${baseUrl}/api/audit-packets/${packetId}`;

    await sendEmail({
      to: creator.email,
      subject: `Truestock audit packet ready (${packet.dateFrom} – ${packet.dateTo})`,
      text:
        `Your audit packet for ${packet.dateFrom} through ${packet.dateTo} is ready.\n\n` +
        `Download it here (this link expires in 10 minutes):\n${downloadUrl}\n\n` +
        `${fileCount} file(s), zip SHA-256 ${zipSha256}.`,
    });
  } catch (err) {
    console.error(`[audit-packets] buildAuditPacketJob(${packetId}): notifyPacketCreator failed`, err);
  }
}
