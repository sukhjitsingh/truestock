/**
 * Error discrimination, tested directly rather than only through the paths
 * that depend on it.
 *
 * These predicates decide whether a failed query means "a unique constraint
 * collided" (a real answer the caller handles) or "something else went wrong"
 * (rethrow). Getting that wrong is silent in the worst direction: a
 * ConflictError that never fires reaches the user as "Something went wrong",
 * and a lock conflict that goes unrecognised stops being retried.
 *
 * The regression these exist for: drizzle wraps query failures in
 * `DrizzleQueryError`, which carries `cause` and no `code` of its own, so a
 * check reading `err.code` directly returned false for every wrapped error.
 * That went unnoticed because the paths with test coverage happened to
 * receive unwrapped errors. No `bun:test` mock would have caught it — the
 * shape came from the library, so these assert against the real class.
 */
import { describe, test, expect } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { isDuplicateKeyError, isTransientLockError } from "@/lib/domain/db-errors";

/** What mysql2 actually throws: an Error carrying `code` and `errno`. */
function driverError(code: string, errno: number): Error {
  return Object.assign(new Error(code), { code, errno, sqlState: "23000" });
}

const wrap = (err: Error) => new DrizzleQueryError("insert into ...", [], err);

describe("isDuplicateKeyError", () => {
  test("recognises a bare mysql2 duplicate-key error", () => {
    expect(isDuplicateKeyError(driverError("ER_DUP_ENTRY", 1062))).toBe(true);
  });

  test("recognises one wrapped in DrizzleQueryError — the regression", () => {
    expect(isDuplicateKeyError(wrap(driverError("ER_DUP_ENTRY", 1062)))).toBe(true);
  });

  test("recognises it by errno alone, if the code string ever changes", () => {
    expect(isDuplicateKeyError(wrap(Object.assign(new Error("x"), { errno: 1062 })))).toBe(true);
  });

  test("does NOT fire on other database errors", () => {
    // 1452 is the composite tenant foreign key rejecting a cross-tenant id.
    // Treating that as a benign duplicate would turn a tenancy violation into
    // a silently swallowed "already exists".
    expect(isDuplicateKeyError(wrap(driverError("ER_NO_REFERENCED_ROW_2", 1452)))).toBe(false);
    expect(isDuplicateKeyError(driverError("ER_LOCK_DEADLOCK", 1213))).toBe(false);
  });

  test("does not fire on ordinary errors or non-objects", () => {
    expect(isDuplicateKeyError(new Error("nope"))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError("ER_DUP_ENTRY")).toBe(false);
  });

  test("survives a self-referential cause chain instead of hanging", () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(isDuplicateKeyError(loop)).toBe(false);
  });
});

describe("isTransientLockError", () => {
  test("recognises a deadlock and a lock-wait timeout, wrapped or not", () => {
    expect(isTransientLockError(driverError("ER_LOCK_DEADLOCK", 1213))).toBe(true);
    expect(isTransientLockError(wrap(driverError("ER_LOCK_DEADLOCK", 1213)))).toBe(true);
    expect(isTransientLockError(wrap(driverError("ER_LOCK_WAIT_TIMEOUT", 1205)))).toBe(true);
  });

  test("recognises ER_CHECKREAD (1020) — a SELECT ... FOR UPDATE hitting a row changed since this transaction's snapshot", () => {
    // Reproduced by a real 3-way concurrent submitInvoiceReview test hitting
    // the SAME vendor_alias row through upsertAliasCore's recovery SELECT ...
    // FOR UPDATE (Slice 3 review fix, 2026-08-15). MariaDB's own message says
    // "try restarting transaction" — the same remedy as 1213/1205.
    expect(isTransientLockError(driverError("ER_CHECKREAD", 1020))).toBe(true);
    expect(isTransientLockError(wrap(driverError("ER_CHECKREAD", 1020)))).toBe(true);
  });

  test("does NOT retry a duplicate key — that is a real answer, not a lock", () => {
    // Retrying a replay would defeat the ledger's whole idempotency mechanism.
    expect(isTransientLockError(wrap(driverError("ER_DUP_ENTRY", 1062)))).toBe(false);
  });
});
