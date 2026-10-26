/**
 * Ground truth for the e2e suite: a guarded, read-mostly view of the database
 * the app under test writes to.
 *
 * Why tests look here at all. A count-line card on screen is the OPTIMISTIC
 * row — the UI paints the bottle before the server has said anything, and the
 * app's whole offline story is built on that gap. So "the screen says 20 ea"
 * proves nothing about invariant 3 (one row per product+location) or invariant
 * 5 (one ledger row per write attempt). The database is the only place those
 * can be seen, and every count-path assertion in this suite ends there.
 *
 * ## Guards
 *
 * `getPool()` runs `assertE2eTarget` before it opens a single connection:
 * loopback host, loopback app, database name ending `_e2e`. There is no way to
 * get a handle on any other database through this module.
 *
 * ## Tenancy (invariant 9)
 *
 * Every statement carries `organization_id = ?`, including the deletes. The
 * org is the one the e2e owner belongs to (`getOrgId`), so even a `_e2e`
 * database that somehow held a second tenant would only be touched in one.
 *
 * Raw SQL, deliberately not drizzle: this file must stay independent of the
 * app's own code (`lib/`, `db/`) so a regression in that code cannot also
 * regress the thing that checks it.
 */
import mysql, { type Pool, type RowDataPacket, type ResultSetHeader } from "mysql2/promise";
import { baseUrl, credentialsFor, databaseUrl } from "./env";
import { assertE2eTarget } from "./guard";

let pool: Pool | null = null;
let orgId: number | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const url = databaseUrl();
  assertE2eTarget(url, baseUrl());
  // 2 connections: the suite is serial (workers: 1) and this is only ever a
  // side channel for assertions. The app's own pool is a separate matter.
  pool = mysql.createPool({ uri: url!, connectionLimit: 2 });
  return pool;
}

/** Releases the pool. A worker that skips this keeps the process alive after the run. */
export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  orgId = null;
  if (p) await p.end();
}

async function rows<T extends RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [result] = await getPool().query<T[]>(sql, params);
  return result;
}

/**
 * The organization the suite acts in: the e2e owner's own. Falls back to "the
 * only organization" so a database seeded for a different owner address still
 * works, and refuses to guess when there is more than one.
 */
export async function getOrgId(): Promise<number> {
  if (orgId !== null) return orgId;
  const owner = credentialsFor("owner");
  if (owner) {
    const [row] = await rows<RowDataPacket>("SELECT organization_id AS id FROM `user` WHERE email = ?", [owner.email]);
    if (row) return (orgId = Number(row.id));
  }
  const all = await rows<RowDataPacket>("SELECT id FROM organization");
  if (all.length === 1) return (orgId = Number(all[0].id));
  throw new Error(
    "e2e db: cannot tell which organization to act in (owner credentials absent or unknown, and the database has " +
      `${all.length} organizations). Set E2E_OWNER_EMAIL.`,
  );
}

/**
 * How many session rows this user has. Global setup reads it before and after a
 * sign-in: `assertE2eTarget` proves the app URL and the database URL are each
 * safe, but not that they belong to each other. A loopback dev server on the real
 * `truestock` database passes both checks, then every UI spec mutates THAT
 * database while this module resets the `_e2e` one. A sign-in that writes no
 * session row here means the app is talking to some other database.
 */
export async function sessionCountFor(email: string): Promise<number> {
  const [row] = await rows<RowDataPacket>(
    "SELECT COUNT(*) AS n FROM `session` s JOIN `user` u ON u.id = s.user_id WHERE u.email = ?",
    [email],
  );
  return Number(row?.n ?? 0);
}

// ---- counts ----------------------------------------------------------------

export interface CountLineRow {
  id: number;
  countId: number;
  productId: number;
  locationId: number;
  sealedCaseQty: number;
  sealedEachQty: number;
  partialFills: number[];
}

export interface LedgerRow {
  id: number;
  countLineId: number;
  countId: number;
  writeType: string;
  sealedCaseDelta: number;
  sealedEachDelta: number;
  partialFillsDelta: number[];
  clientLineId: string;
}

/**
 * `partial_fills` is `longtext` on MariaDB (it has no native JSON type), so the
 * driver hands back a string here — the guarantee that the app's reads parse it
 * is a driver one, covered elsewhere. Tests want numbers, so accept both.
 */
function parseFills(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string" && value !== "") return (JSON.parse(value) as unknown[]).map(Number);
  return [];
}

/** Counts that still accept writes (`draft` / `in_progress`), newest first. */
export async function openCountIds(): Promise<number[]> {
  const org = await getOrgId();
  const found = await rows<RowDataPacket>(
    "SELECT id FROM `count` WHERE organization_id = ? AND status IN ('draft','in_progress') ORDER BY id DESC",
    [org],
  );
  return found.map((r) => Number(r.id));
}

export async function countLines(countId: number): Promise<CountLineRow[]> {
  const org = await getOrgId();
  const found = await rows<RowDataPacket>(
    "SELECT id, count_id, product_id, location_id, sealed_case_qty, sealed_each_qty, partial_fills " +
      "FROM count_line WHERE organization_id = ? AND count_id = ? ORDER BY id",
    [org, countId],
  );
  return found.map((r) => ({
    id: Number(r.id),
    countId: Number(r.count_id),
    productId: Number(r.product_id),
    locationId: Number(r.location_id),
    sealedCaseQty: Number(r.sealed_case_qty),
    sealedEachQty: Number(r.sealed_each_qty),
    partialFills: parseFills(r.partial_fills),
  }));
}

/** The append-only write ledger, oldest first. Filter by line or by whole count. */
export async function ledgerRows(filter: { countLineId: number } | { countId: number }): Promise<LedgerRow[]> {
  const org = await getOrgId();
  const [column, value] = "countLineId" in filter ? ["count_line_id", filter.countLineId] : ["count_id", filter.countId];
  const found = await rows<RowDataPacket>(
    "SELECT id, count_line_id, count_id, write_type, sealed_case_delta, sealed_each_delta, partial_fills_delta, client_line_id " +
      `FROM count_line_write WHERE organization_id = ? AND ${column} = ? ORDER BY id`,
    [org, value],
  );
  return found.map((r) => ({
    id: Number(r.id),
    countLineId: Number(r.count_line_id),
    countId: Number(r.count_id),
    writeType: String(r.write_type),
    sealedCaseDelta: Number(r.sealed_case_delta),
    sealedEachDelta: Number(r.sealed_each_delta),
    partialFillsDelta: parseFills(r.partial_fills_delta),
    clientLineId: String(r.client_line_id),
  }));
}

/**
 * Deletes every count, line and ledger row for the e2e organization, children
 * first (the FKs make any other order fail). This is what makes count specs
 * deterministic: they start from "no open count", so "Start a count" is
 * exercised rather than a leftover being resumed.
 *
 * Safe only because the target guard has already proven this is a `_e2e`
 * database. Do not add a flag that skips that.
 */
export async function resetCounts(): Promise<void> {
  const org = await getOrgId();
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM count_line_write WHERE organization_id = ?", [org]);
    await conn.query("DELETE FROM count_line WHERE organization_id = ?", [org]);
    await conn.query("DELETE FROM `count` WHERE organization_id = ?", [org]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---- catalog ---------------------------------------------------------------

export interface ProductRow {
  id: number;
  name: string;
  category: string;
  unitType: string;
  sizeMl: number;
  /** DECIMAL(10,4) as the driver returns it: a string such as "82.0000", or null. */
  currentUnitCost: string | null;
}

function toProduct(r: RowDataPacket): ProductRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    category: String(r.category),
    unitType: String(r.unit_type),
    sizeMl: Number(r.size_ml),
    currentUnitCost: r.current_unit_cost == null ? null : String(r.current_unit_cost),
  };
}

/** An ACTIVE product by exact name; throws if it is not unique, so a fixture never silently picks one. */
export async function productByName(name: string): Promise<ProductRow> {
  const org = await getOrgId();
  const found = await rows<RowDataPacket>(
    "SELECT id, name, category, unit_type, size_ml, current_unit_cost FROM product " +
      "WHERE organization_id = ? AND name = ? AND active = 1",
    [org, name],
  );
  if (found.length !== 1) {
    throw new Error(`e2e db: expected exactly one active product named "${name}", found ${found.length}`);
  }
  return toProduct(found[0]);
}

/** Every active product that has a unit cost on file — the values a cost leak would contain. */
export async function pricedProducts(): Promise<ProductRow[]> {
  const org = await getOrgId();
  const found = await rows<RowDataPacket>(
    "SELECT id, name, category, unit_type, size_ml, current_unit_cost FROM product " +
      "WHERE organization_id = ? AND active = 1 AND current_unit_cost IS NOT NULL",
    [org],
  );
  return found.map(toProduct);
}

export async function productById(id: number): Promise<ProductRow> {
  const org = await getOrgId();
  const [row] = await rows<RowDataPacket>(
    "SELECT id, name, category, unit_type, size_ml, current_unit_cost FROM product WHERE organization_id = ? AND id = ?",
    [org, id],
  );
  if (!row) throw new Error(`e2e db: no product ${id}`);
  return toProduct(row);
}

/** Restores a cost exactly as it was (null included). Used to undo the catalog edit spec. */
export async function setProductCost(productId: number, cost: string | null): Promise<void> {
  const org = await getOrgId();
  await getPool().query<ResultSetHeader>(
    "UPDATE product SET current_unit_cost = ? WHERE organization_id = ? AND id = ?",
    [cost, org, productId],
  );
}

export interface LocationRow {
  id: number;
  name: string;
  countMode: "tenths" | "quantity";
}

export async function locationByName(name: string): Promise<LocationRow> {
  const org = await getOrgId();
  const found = await rows<RowDataPacket>(
    "SELECT id, name, count_mode FROM location WHERE organization_id = ? AND name = ? AND active = 1",
    [org, name],
  );
  if (found.length !== 1) {
    throw new Error(`e2e db: expected exactly one active location named "${name}", found ${found.length}`);
  }
  return { id: Number(found[0].id), name: String(found[0].name), countMode: found[0].count_mode as LocationRow["countMode"] };
}

/** How many ACTIVE products the organization has — what the catalog table's "of N" should say. */
export async function activeProductCount(): Promise<number> {
  const org = await getOrgId();
  const [row] = await rows<RowDataPacket>("SELECT COUNT(*) AS n FROM product WHERE organization_id = ? AND active = 1", [org]);
  return Number(row.n);
}

/** True when a barcode is already attached to anything — the enroll spec needs one that is not. */
export async function barcodeExists(barcode: string): Promise<boolean> {
  const org = await getOrgId();
  const found = await rows<RowDataPacket>(
    "SELECT id FROM product_barcode WHERE organization_id = ? AND barcode = ? LIMIT 1",
    [org, barcode],
  );
  return found.length > 0;
}

// ---- invoices --------------------------------------------------------------

/** Invoice ids in the organization, newest first. Empty when none were ever uploaded. */
export async function invoiceIds(): Promise<number[]> {
  const org = await getOrgId();
  const found = await rows<RowDataPacket>("SELECT id FROM invoice WHERE organization_id = ? ORDER BY id DESC", [org]);
  return found.map((r) => Number(r.id));
}

/** The `db` fixture's shape — one object so a spec reads `db.countLines(id)`. */
export const dbApi = {
  getOrgId,
  openCountIds,
  countLines,
  ledgerRows,
  resetCounts,
  productByName,
  productById,
  pricedProducts,
  activeProductCount,
  setProductCost,
  locationByName,
  barcodeExists,
  invoiceIds,
  closeDb,
};
export type Db = typeof dbApi;
