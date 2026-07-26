/**
 * Single long-lived MySQL pool + Drizzle client.
 *
 * Pool size is fixed at 5–10 (spec §11): Hostinger Cloud Startup allows 100
 * MySQL user connections, shared with the restaurant's other website on the
 * same plan. mysql2's default pool size (10) happens to sit at our ceiling,
 * so it is set explicitly here rather than left implicit — the point is that
 * this file is the one place that decides it, not the driver default.
 *
 * Cached on `globalThis` so Next.js dev's hot-module-reload doesn't leak a
 * fresh pool (and fresh connections) on every edit — a well-known Node +
 * Next.js dev-mode footgun for any module-scoped connection.
 */

import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "./schema";

// Spec §11 calls for a pool of 5–10. mysql2's Pool has no separate "min"
// knob — connections are opened lazily up to this ceiling — so the ceiling
// is the number that matters and is set explicitly here.
const POOL_CONNECTION_LIMIT = 10;

declare global {
  var __handlebarPool: mysql.Pool | undefined;
}

// Everything below is resolved on FIRST USE, never at import time.
//
// `next build` imports every module it traces — including this one, via the
// auth route handler — while collecting page data. If this file threw on a
// missing DATABASE_URL at import, the build would require live database
// credentials just to compile. That breaks building in CI (spec §11 suggests
// GitHub Actions if Hostinger's builder struggles on memory), where database
// credentials have no business existing. Connecting is a runtime concern; the
// error still fires on the first real query, which is where it belongs.
function createPool(): mysql.Pool {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
    );
  }

  return mysql.createPool({
    uri: DATABASE_URL,
    connectionLimit: POOL_CONNECTION_LIMIT,
    waitForConnections: true,
    queueLimit: 0,
    // Scoped to DATE columns only (currently just count_line.opened_at).
    // mysql2 returns those as a plain "YYYY-MM-DD" string instead of
    // constructing a JS Date — paired with that column's `mode: "string"`
    // in db/schema.ts, this keeps calendar-only dates as calendar-only
    // strings all the way through, with no timezone-dependent Date object
    // ever created for them. TIMESTAMP/DATETIME columns (createdAt,
    // countedAt, etc.) are left as real JS Date objects — they represent a
    // moment in time, not a bare calendar day, so the off-by-one failure
    // mode below doesn't apply to them and losing them to strings here
    // would just make every other timestamp in the app clumsier to work
    // with for no reason.
    dateStrings: ["DATE"],
  });
}

function createDb() {
  return drizzle(getPool(), { schema, mode: "default" });
}

let poolInstance: mysql.Pool | undefined;
let dbInstance: ReturnType<typeof createDb> | undefined;

function getPool(): mysql.Pool {
  poolInstance ??= globalThis.__handlebarPool ?? createPool();
  if (process.env.NODE_ENV !== "production") {
    globalThis.__handlebarPool = poolInstance;
  }
  return poolInstance;
}

function getDb(): ReturnType<typeof createDb> {
  return (dbInstance ??= createDb());
}

// Lazy façades. Callers keep using `db` and `pool` as plain objects; the
// underlying pool is only constructed when a property is actually touched.
// Methods are bound to the real instance so `this` stays correct.
function lazyProxy<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const instance = resolve();
      const value = Reflect.get(instance, property);
      return typeof value === "function" ? value.bind(instance) : value;
    },
    has: (_target, property) => Reflect.has(resolve(), property),
  });
}

export const db = lazyProxy(getDb);

// Exported for graceful shutdown hooks / scripts (e.g. seed.ts) that need to
// end the process explicitly instead of hanging on an open pool.
export const pool = lazyProxy(getPool);

/**
 * Close the pool if one was ever opened. Safe to call from a `finally` block:
 * a script that failed before its first query has no pool to close, and
 * touching `pool.end()` there would construct one purely to close it —
 * throwing a second, misleading error over the real failure.
 */
export async function closePool(): Promise<void> {
  if (!poolInstance) return;
  await poolInstance.end();
  poolInstance = undefined;
  dbInstance = undefined;
  globalThis.__handlebarPool = undefined;
}
