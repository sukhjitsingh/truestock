/**
 * Shared MySQL error discrimination. Used everywhere this codebase needs to
 * tell "a unique constraint collided" apart from "something else went
 * wrong" — a real error must never be silently reinterpreted as a benign
 * race/replay. Keep this the single place that decision is made so every
 * caller (lib/domain/counts.ts, lib/domain/catalog.ts) applies the same
 * discipline: only mysql2 error code 1062 (`ER_DUP_ENTRY`) counts.
 */
/**
 * Walks an error and its `cause` chain looking for a driver error.
 *
 * REQUIRED, not defensive (found by a test, 2026-07-30): drizzle wraps query
 * failures in `DrizzleQueryError`, which carries `query`, `params` and
 * `cause` — and NO `code` of its own. A check that reads `err.code` directly
 * therefore returns false for every wrapped error, and both predicates below
 * silently stopped discriminating.
 *
 * What that cost: every `ConflictError` in lib/domain/catalog.ts was
 * unreachable, so "A product named X already exists" and "Barcode Y is
 * already assigned to Z" fell through to the generic handler and reached the
 * user as "Something went wrong" — mid-count, on the app's highest-risk
 * interaction, with the actionable half of the message discarded.
 *
 * The chain is walked rather than just `.cause` being unwrapped once, because
 * nothing guarantees the nesting depth stays at one.
 */
function driverErrorInChain(err: unknown): { code?: unknown; errno?: unknown } | null {
  let current = err;
  // Bounded so a self-referential cause cannot spin forever.
  for (let depth = 0; depth < 10; depth++) {
    if (typeof current !== "object" || current === null) return null;
    const e = current as { code?: unknown; errno?: unknown; cause?: unknown };
    if (e.code !== undefined || e.errno !== undefined) return e;
    if (!("cause" in e)) return null;
    current = e.cause;
  }
  return null;
}

export function isDuplicateKeyError(err: unknown): boolean {
  const driver = driverErrorInChain(err);
  // Both forms: mysql2 populates `code` and `errno` together, but only the
  // number is guaranteed stable across driver versions.
  return driver?.code === "ER_DUP_ENTRY" || driver?.errno === 1062;
}

/**
 * InnoDB gave up on a lock: 1213 `ER_LOCK_DEADLOCK` (it picked us as the
 * deadlock victim) or 1205 `ER_LOCK_WAIT_TIMEOUT` (we waited out
 * innodb_lock_wait_timeout). Both mean "your transaction did not happen";
 * neither means "your transaction was wrong."
 *
 * Checked by `errno` as well as `code` because mysql2 populates both and the
 * string form is the friendlier one to read, but only the number is
 * guaranteed stable across driver versions.
 */
export function isTransientLockError(err: unknown): boolean {
  const e = driverErrorInChain(err);
  if (!e) return false;
  return (
    e.code === "ER_LOCK_DEADLOCK" ||
    e.code === "ER_LOCK_WAIT_TIMEOUT" ||
    e.errno === 1213 ||
    e.errno === 1205
  );
}

/**
 * Runs a transaction, retrying it whole if InnoDB rolls it back for a lock
 * conflict.
 *
 * WHY THIS EXISTS (schema audit 2026-07-27, finding B2): the count-line write
 * path takes a `SELECT ... FOR UPDATE` on the invariant-1 unique key
 * `(count_id, product_id, location_id)` before deciding whether to insert or
 * increment. Under MySQL's default REPEATABLE READ, a `FOR UPDATE` that
 * matches no row takes a *gap lock* to stop a phantom insert. Two staff
 * scanning two different first-time bottles into the same open count at the
 * same moment therefore take overlapping gap locks on the same gap and can
 * deadlock — which is not an edge case, it is the normal two-person count
 * this app is built for (CLAUDE.md, "dim-bar UI"). Before this, a 1213
 * propagated raw out of `applyIncrement` as a failed save needing a manual
 * rescan.
 *
 * WHY RETRYING IS SAFE, and why it does not weaken idempotency: InnoDB rolls
 * the victim transaction back in full, so nothing the callback did persisted
 * — including the `count_line_write` ledger insert. A retry therefore starts
 * from the same state the first attempt saw and re-inserts the ledger row
 * with the SAME `client_line_id`, which is exactly right: the unique index on
 * `client_line_id` is still the thing enforcing "this write applies once,"
 * and it has nothing to collide with because the rolled-back attempt left no
 * row. A retry here is indistinguishable from the client having sent the
 * request a moment later.
 *
 * `ER_DUP_ENTRY` is deliberately NOT retried — it is a real answer (a replay,
 * or a genuine unique collision) that callers already handle. Only lock
 * failures come back here.
 *
 * The caller keeps its own `try/catch` for duplicate keys; this wrapper
 * rethrows anything that isn't a lock conflict immediately, so that logic is
 * unaffected.
 */
export async function withLockRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientLockError(err)) throw err;
      lastErr = err;
      if (attempt === attempts) break;
      // Jittered backoff. The jitter matters more than the delay: two
      // transactions that deadlocked are by definition running in lockstep,
      // and retrying both after an identical pause just reproduces the same
      // collision.
      const backoffMs = 10 * 2 ** (attempt - 1) * (1 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  // Exhausted. Surface the real MySQL error rather than a synthesized one —
  // the caller's error handler and any log line should say "deadlock", not
  // "retries exhausted", or the cause disappears from the record.
  throw lastErr;
}
