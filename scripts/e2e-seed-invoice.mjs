#!/usr/bin/env node
/**
 * Seeds ONE invoice, with a real stored file, into an e2e database.
 *
 * Why: `e2e/specs/roles.e2e.ts` checks the invoice-file route for every role
 * (owner 200, manager 403, signed-out 401). With no invoice in the database the
 * owner's check can only skip as "NOT VERIFIED", and the manager's 403 is
 * asserted against an id that doesn't exist. One row plus its file makes both
 * real. Used by CI's `e2e-smoke` job; safe to run by hand against the local rig.
 *
 *   DATABASE_URL=mysql://…/truestock_e2e INVOICE_STORAGE_DIR=/abs/dir \
 *     node scripts/e2e-seed-invoice.mjs
 *
 * Refuses any database whose name does not end in `_e2e` — the same rule as
 * e2e/support/guard.ts — and any relative storage directory. Idempotent: if
 * the organization already has an invoice it prints that id and exits.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

const ORG_SLUG = process.env.SEED_ORG_SLUG ?? "truestock";

function fail(message) {
  console.error(`e2e-seed-invoice: ${message}`);
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL;
const storageDir = process.env.INVOICE_STORAGE_DIR;
if (!dbUrl) fail("DATABASE_URL is not set.");
if (!storageDir || !path.isAbsolute(storageDir)) fail("INVOICE_STORAGE_DIR must be an absolute path.");

const dbName = new URL(dbUrl).pathname.replace(/^\//, "");
if (!dbName.endsWith("_e2e")) fail(`refusing database "${dbName}": the name must end in _e2e.`);

// A minimal, valid one-page PDF. Content is irrelevant to the route; it serves
// whatever bytes the stored path holds.
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n",
);

const conn = await mysql.createConnection(dbUrl);
try {
  const [orgs] = await conn.query("SELECT id FROM organization WHERE slug = ?", [ORG_SLUG]);
  if (orgs.length === 0) fail(`organization "${ORG_SLUG}" not found — run db:seed first.`);
  const orgId = Number(orgs[0].id);

  const [existing] = await conn.query("SELECT id FROM invoice WHERE organization_id = ? LIMIT 1", [orgId]);
  if (existing.length > 0) {
    console.log(`e2e-seed-invoice: organization ${orgId} already has invoice ${existing[0].id}; nothing to do.`);
  } else {
    const sha = createHash("sha256").update(PDF).digest("hex");
    const [result] = await conn.query(
      "INSERT INTO invoice (organization_id, status, source, file_sha256, file_size_bytes) VALUES (?, 'uploaded', 'pdf', ?, ?)",
      [orgId, sha, PDF.length],
    );
    const id = Number(result.insertId);
    // Same key shape the app writes (lib/storage/invoice-files.ts invoiceStorageKey).
    const key = path.posix.join(String(orgId), `${id}.pdf`);
    mkdirSync(path.join(storageDir, String(orgId)), { recursive: true });
    writeFileSync(path.join(storageDir, key), PDF);
    await conn.query("UPDATE invoice SET file_path = ? WHERE id = ?", [key, id]);
    console.log(`e2e-seed-invoice: invoice ${id} for organization ${orgId}, file ${key} (${PDF.length} bytes).`);
  }
} finally {
  await conn.end();
}
