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
  "product_par",
  "product_barcode",
  "product",
  "location",
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
  /** A second tenant, for proving cross-tenant reads and writes are refused. */
  otherOwner: Actor;
  organizationId: number;
  otherOrganizationId: number;
  locationId: number;
  otherLocationId: number;
  /** A product WITH a cost — valuation should include it. */
  pricedProductId: number;
  /** A product with no cost — valuation must exclude it, never value it at 0. */
  unpricedProductId: number;
  /** A second priced product, for multi-line and concurrency cases. */
  secondProductId: number;
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

  return {
    owner: { userId: owner.id, role: "owner", organizationId: org.id },
    manager: { userId: manager.id, role: "manager", organizationId: org.id },
    otherOwner: { userId: otherOwner.id, role: "owner", organizationId: otherOrg.id },
    organizationId: org.id,
    otherOrganizationId: otherOrg.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    pricedProductId: priced.id,
    unpricedProductId: unpriced.id,
    secondProductId: second.id,
  };
}

/** A fresh idempotency key. One per WRITE ATTEMPT — never one per line. */
export function newClientLineId(): string {
  return crypto.randomUUID();
}
