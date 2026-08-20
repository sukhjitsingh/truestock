/**
 * Test database harness.
 *
 * These tests run against a REAL MariaDB — the same engine and version
 * Hostinger runs (docker-compose.yml). That is deliberate and is the whole
 * point: every invariant these tests cover is enforced by the database, not by
 * TypeScript, so a mock would assert that our mock works.
 *
 * Run them with `bun run test:docker`, which points DATABASE_URL at
 * `truestock_test` — a separate database on the same container, created by
 * docker/mariadb/init/01-test-database.sql.
 */
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { db } from "@/db";
import {
  organization,
  user as userTable,
  location as locationTable,
  product as productTable,
  vendor as vendorTable,
  invoice as invoiceTable,
  extractionJob as extractionJobTable,
  invoiceLine as invoiceLineTable,
} from "@/db/schema";
import type { Actor } from "@/lib/authz";

/**
 * Refuses to run against anything but a database whose name ends in `_test`.
 *
 * This is not paranoia about a hypothetical. `resetDatabase()` below truncates
 * every table, and the development database holds the seeded catalog plus any
 * costs, pars and enrolled barcodes entered by hand through the back office —
 * exactly the data db/README.md's seeding section goes out of its way to
 * protect from a re-seed. A stray DATABASE_URL would destroy all of it with no
 * confirmation step. Failing loudly here is cheap; the alternative is not
 * recoverable.
 */
function assertTestDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Run these via `bun run test:docker`.");
  }
  // The path segment is the database name; strip any query string.
  const name = new URL(url).pathname.replace(/^\//, "").split("?")[0];
  if (!name.endsWith("_test")) {
    throw new Error(
      `Refusing to run tests against database "${name}" — the name must end in "_test". ` +
        `These tests TRUNCATE every table. Run via \`bun run test:docker\`.`,
    );
  }
  return name;
}

/**
 * Applies the migration chain to the test database.
 *
 * Uses the same `drizzle/` folder production will use, rather than pushing
 * `db/schema.ts` directly — so these tests exercise the migrations themselves,
 * not just the schema they are supposed to produce. A migration that does not
 * actually apply is a failure worth catching here.
 */
export async function migrateTestDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL!;
  assertTestDatabase();
  const connection = await mysql.createConnection({ uri: url, multipleStatements: true });
  try {
    await migrate(drizzle(connection), { migrationsFolder: "./drizzle" });
  } finally {
    await connection.end();
  }
}

/** Every table the tests touch, child-first so truncation order is FK-safe. */
const TABLES_CHILD_FIRST = [
  "count_line_write",
  "count_line",
  "count",
  // Phase 2.5, Slice 4. References product, invoice, AND invoice_line (all
  // three composite tenant FKs) — must precede all three, so it goes here,
  // before "product" below, which is early enough to also precede
  // "invoice_line" and "invoice" further down.
  "product_cost_history",
  "product_par",
  "product_barcode",
  "product",
  "location",
  // invoice_line references invoice (and, nullably, product — already
  // truncated above, and vendor_alias — truncated next); extraction_job
  // references invoice. All three must go before invoice itself.
  "invoice_line",
  // Phase 2.5, Slice 3. References organization/vendor/product; listed
  // before "vendor" below for the same reason invoice_line is listed before
  // "invoice" — FOREIGN_KEY_CHECKS=0 makes the order non-functional (see the
  // comment on resetDatabase), but it documents the real dependency anyway.
  "vendor_alias",
  "extraction_job",
  "invoice",
  "vendor",
  "session",
  "account",
  "verification",
  "user",
  "organization",
];

/**
 * Empties the test database between test files.
 *
 * `foreign_key_checks = 0` around the truncations rather than relying on the
 * order alone: TRUNCATE is refused outright on a table referenced by a foreign
 * key in both MySQL and MariaDB, regardless of whether any referencing rows
 * exist. It is restored immediately afterward — the constraints themselves are
 * what several of these tests are asserting, so leaving them off would make the
 * suite pass for the wrong reason.
 */
export async function resetDatabase(): Promise<void> {
  assertTestDatabase();
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  try {
    for (const table of TABLES_CHILD_FIRST) {
      await db.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
    }
  } finally {
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  }
}

export interface Fixtures {
  owner: Actor;
  manager: Actor;
  /** Count-only — used to prove an action's role gate refuses a role it doesn't cover. */
  staff: Actor;
  /** A second tenant, for proving cross-tenant reads and writes are refused. */
  otherOwner: Actor;
  organizationId: number;
  otherOrganizationId: number;
  locationId: number;
  otherLocationId: number;
  vendorId: number;
  /** A vendor belonging to the OTHER tenant — invariant 9's negative case. */
  otherVendorId: number;
  /** A product WITH a cost — valuation should include it. */
  pricedProductId: number;
  /** A product with no cost — valuation must exclude it, never value it at 0. */
  unpricedProductId: number;
  /** A second priced product, for multi-line and concurrency cases. */
  secondProductId: number;
  /** A product belonging to the OTHER tenant — invariant 9's negative case. */
  otherProductId: number;
  /**
   * Phase 2.5, Slice 2. An invoice already sitting in `needs_review`, with
   * every `REQUIRED_FOR_REVIEW` field populated (lib/domain/invoices.ts) and
   * its `extraction_job` at `done` — the state the review screen's own tests
   * (04-slices.md's `review_conflicts_when_status_moved`,
   * `manager_cannot_open_review_screen`,
   * `extraction_status_hides_error_message`,
   * `manager_invoice_payload_has_no_money`) start from, so they don't each
   * have to re-derive the upload -> confirm -> claim -> complete pipeline
   * dance just to get an invoice into a reviewable state.
   *
   * Inserted directly (bypassing `createInvoiceForUpload` /
   * `markUploadConfirmed` / the extraction pipeline entirely) — this is
   * fixture data describing a state, not a test of how that state is
   * reached; the pipeline itself is covered by its own tests.
   *
   * DELIBERATELY left out of the job queue: `extraction_job.status` here is
   * `done`, not `queued` or `running`, so `claimNextJob` never sees it and
   * no test's own queue-claiming assertions are contaminated by a stray job
   * they didn't create. `invoice.file_path` is a plausible-looking string
   * with no real file behind it — tests that need to read actual bytes
   * build their own invoice via `createInvoiceForUpload` +
   * `writeInvoiceFile`, the same pattern `tests/invoice-write-path.test.ts`
   * already uses.
   */
  invoiceId: number;
  extractionJobId: number;
  /**
   * `invoiceLineId` is `unmatched` and carries an `["unmatched item"]`
   * exception flag; `matchedInvoiceLineId` is already `manual`-matched to
   * `pricedProductId` with no exceptions.
   */
  invoiceLineId: number;
  matchedInvoiceLineId: number;
  /** The OTHER tenant's equivalent — invariant 9's negative case. */
  otherInvoiceId: number;
  otherExtractionJobId: number;
  otherInvoiceLineId: number;
}

/**
 * Minimal fixtures: two tenants, so that "scoped to one organization" is
 * testable rather than assumed. Every test that reads or writes gets a
 * neighbouring tenant whose data it must not be able to see or touch.
 */
export async function createFixtures(): Promise<Fixtures> {
  const [org] = await db
    .insert(organization)
    .values({ name: "Test Bar", slug: "test-bar" })
    .$returningId();
  const [otherOrg] = await db
    .insert(organization)
    .values({ name: "Other Bar", slug: "other-bar" })
    .$returningId();

  const [owner] = await db
    .insert(userTable)
    .values({
      name: "Test Owner",
      email: "owner@test.local",
      emailVerified: true,
      role: "owner",
      active: true,
      organizationId: org.id,
    })
    .$returningId();

  const [manager] = await db
    .insert(userTable)
    .values({
      name: "Test Manager",
      email: "manager@test.local",
      emailVerified: true,
      role: "manager",
      active: true,
      organizationId: org.id,
    })
    .$returningId();

  const [staff] = await db
    .insert(userTable)
    .values({
      name: "Test Staff",
      email: "staff@test.local",
      emailVerified: true,
      role: "staff",
      active: true,
      organizationId: org.id,
    })
    .$returningId();

  const [otherOwner] = await db
    .insert(userTable)
    .values({
      name: "Other Owner",
      email: "owner@other.local",
      emailVerified: true,
      role: "owner",
      active: true,
      organizationId: otherOrg.id,
    })
    .$returningId();

  const [location] = await db
    .insert(locationTable)
    .values({ organizationId: org.id, name: "Back Bar", countMode: "tenths" })
    .$returningId();

  const [otherLocation] = await db
    .insert(locationTable)
    .values({ organizationId: otherOrg.id, name: "Their Bar", countMode: "tenths" })
    .$returningId();

  const [vendor] = await db
    .insert(vendorTable)
    .values({ organizationId: org.id, name: "Test Distributor" })
    .$returningId();

  const [otherVendor] = await db
    .insert(vendorTable)
    .values({ organizationId: otherOrg.id, name: "Their Distributor" })
    .$returningId();

  // 24.5000 rather than a round number on purpose: DECIMAL(10,4) round-tripping
  // through drizzle's string mode is one of the things under test, and a value
  // that survives being turned into a float by accident proves nothing.
  const [priced] = await db
    .insert(productTable)
    .values({
      organizationId: org.id,
      name: "Tito's Handmade Vodka",
      category: "Spirits",
      unitType: "bottle",
      sizeMl: 750,
      currentUnitCost: "24.5000",
    })
    .$returningId();

  const [second] = await db
    .insert(productTable)
    .values({
      organizationId: org.id,
      name: "Bulleit Bourbon",
      category: "Spirits",
      unitType: "bottle",
      sizeMl: 750,
      currentUnitCost: "31.2500",
    })
    .$returningId();

  const [unpriced] = await db
    .insert(productTable)
    .values({
      organizationId: org.id,
      name: "House Infusion",
      category: "Spirits",
      unitType: "bottle",
      sizeMl: 750,
      // currentUnitCost deliberately omitted — NULL means "no cost recorded",
      // which must never be coerced to 0 (db/README.md, invariant 2).
    })
    .$returningId();

  // Deliberately shares a name and size with `priced` above. Two tenants
  // stocking the same bottle is the normal case, not an edge one, and
  // `product_name_size_ml_unique` must be per-tenant for that to work.
  const [otherProduct] = await db
    .insert(productTable)
    .values({
      organizationId: otherOrg.id,
      name: "Tito's Handmade Vodka",
      category: "Spirits",
      unitType: "bottle",
      sizeMl: 750,
    })
    .$returningId();

  // ---------------------------------------------------------------------
  // Phase 2.5, Slice 2 — a `needs_review` invoice per tenant, with its
  // extraction_job `done` and two invoice_line rows. See the `Fixtures`
  // interface above for why this is inserted directly rather than driven
  // through the real upload/confirm/extraction pipeline.
  // ---------------------------------------------------------------------
  const [inv] = await db
    .insert(invoiceTable)
    .values({
      organizationId: org.id,
      vendorId: vendor.id,
      status: "needs_review",
      source: "pdf",
      filePath: `${org.id}/fixture-invoice.pdf`,
      fileSha256: "f".repeat(64),
      fileSizeBytes: 12345,
      pageCount: 1,
      invoiceDate: "2026-06-01",
      invoiceNumber: "FIXTURE-INV-001",
      totalGross: "310.5000",
      totalDiscount: "0.0000",
      totalNet: "310.5000",
      currency: "USD",
      // invoice_date + 3 years, matching computeRetentionUntil's own rule
      // (lib/domain/invoices.ts) — duplicated as a literal here rather than
      // imported, so this fixture file stays free of domain-layer imports.
      retentionUntil: "2029-06-01",
    })
    .$returningId();

  const [job] = await db
    .insert(extractionJobTable)
    .values({
      organizationId: org.id,
      invoiceId: inv.id,
      status: "done",
      phase: "parse",
      pdfType: "text",
      completedAt: new Date(),
    })
    .$returningId();

  const [line] = await db
    .insert(invoiceLineTable)
    .values({
      organizationId: org.id,
      invoiceId: inv.id,
      lineNumber: 1,
      description: "Tito's Handmade Vodka 750ml",
      lineType: "product",
      quantity: "12.000",
      uom: "each",
      unitCost: "24.5000",
      extendedCost: "294.00",
      rawGross: "294.00",
      rawDiscount: "0.00",
      rawNet: "294.00",
      matchMethod: "unmatched",
      exceptionFlags: ["unmatched item"],
    })
    .$returningId();

  const [matchedLine] = await db
    .insert(invoiceLineTable)
    .values({
      organizationId: org.id,
      invoiceId: inv.id,
      lineNumber: 2,
      description: "Bulleit Bourbon 750ml",
      lineType: "product",
      quantity: "6.000",
      uom: "each",
      unitCost: "16.5000",
      extendedCost: "16.50",
      rawGross: "16.50",
      rawDiscount: "0.00",
      rawNet: "16.50",
      matchedProductId: priced.id,
      matchMethod: "manual",
    })
    .$returningId();

  const [otherInv] = await db
    .insert(invoiceTable)
    .values({
      organizationId: otherOrg.id,
      vendorId: otherVendor.id,
      status: "needs_review",
      source: "pdf",
      filePath: `${otherOrg.id}/fixture-invoice.pdf`,
      fileSha256: "e".repeat(64),
      fileSizeBytes: 6789,
      pageCount: 1,
      invoiceDate: "2026-06-01",
      invoiceNumber: "FIXTURE-INV-OTHER-001",
      totalGross: "88.0000",
      totalDiscount: "0.0000",
      totalNet: "88.0000",
      currency: "USD",
      retentionUntil: "2029-06-01",
    })
    .$returningId();

  const [otherJob] = await db
    .insert(extractionJobTable)
    .values({
      organizationId: otherOrg.id,
      invoiceId: otherInv.id,
      status: "done",
      phase: "parse",
      pdfType: "text",
      completedAt: new Date(),
    })
    .$returningId();

  const [otherLine] = await db
    .insert(invoiceLineTable)
    .values({
      organizationId: otherOrg.id,
      invoiceId: otherInv.id,
      lineNumber: 1,
      description: "Their Distributor line item",
      lineType: "product",
      quantity: "4.000",
      uom: "each",
      unitCost: "22.0000",
      extendedCost: "88.00",
      rawGross: "88.00",
      rawDiscount: "0.00",
      rawNet: "88.00",
      matchMethod: "unmatched",
    })
    .$returningId();

  return {
    owner: { userId: owner.id, role: "owner", organizationId: org.id },
    manager: { userId: manager.id, role: "manager", organizationId: org.id },
    staff: { userId: staff.id, role: "staff", organizationId: org.id },
    otherOwner: { userId: otherOwner.id, role: "owner", organizationId: otherOrg.id },
    organizationId: org.id,
    otherOrganizationId: otherOrg.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    vendorId: vendor.id,
    otherVendorId: otherVendor.id,
    pricedProductId: priced.id,
    unpricedProductId: unpriced.id,
    secondProductId: second.id,
    otherProductId: otherProduct.id,
    invoiceId: inv.id,
    extractionJobId: job.id,
    invoiceLineId: line.id,
    matchedInvoiceLineId: matchedLine.id,
    otherInvoiceId: otherInv.id,
    otherExtractionJobId: otherJob.id,
    otherInvoiceLineId: otherLine.id,
  };
}

/** A fresh idempotency key. One per WRITE ATTEMPT — never one per line. */
export function newClientLineId(): string {
  return crypto.randomUUID();
}
