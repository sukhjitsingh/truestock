/**
 * Session sweep — housekeeping for the `session` table.
 *
 * Deliberately NOT scoped to organization. `session` is one of exactly two
 * tables invariant 9 (AGENTS.md) names as a deliberate exception: it is
 * keyed by `user_id`, not `organization_id`, and there is no tenant to scope
 * an expiry sweep to in the first place. A future edit that "fixes" this by
 * adding an `organization_id` filter would not be a correctness improvement
 * — it would just be a slower, more complex version of the same
 * unconditional `expires_at < NOW()` sweep this table needs.
 *
 * Lives in `lib/domain/*` (not inline in the script) so it is directly
 * importable from a test, matching every other domain function's test
 * convention — even though it has no `Actor` (Gate 3, least-confident item
 * 5, accepted as written 2026-08-12).
 *
 * There is deliberately no server action or route handler wrapping this.
 * Phase 3 wires a Hostinger cron directly to `scripts/sweep-sessions.ts`
 * against production `DATABASE_URL` (00-status.md) — the cron itself is out
 * of scope here because Hostinger does not exist yet.
 */
import { lt } from "drizzle-orm";
import { db } from "@/db";
import { session } from "@/db/schema";

export interface SessionSweepBatch {
  deletedCount: number;
}

/**
 * Bounds a single `DELETE ... LIMIT ?` so one run against a large backlog
 * cannot hold a table lock indefinitely. The caller (scripts/sweep-sessions.ts)
 * loops until a batch returns fewer rows than this.
 */
const DEFAULT_BATCH_SIZE = 500;

/**
 * Deletes session rows whose `expires_at` is before `now`, one bounded batch
 * at a time.
 *
 * Reading `affectedRows` off this DELETE is a legitimate row count, not the
 * "affectedRows as a success signal" misuse AGENTS.md warns about — that
 * warning is about mysql2's CLIENT_FOUND_ROWS gap on UPDATE, where
 * `affectedRows` counts rows CHANGED rather than rows MATCHED because
 * CLIENT_FOUND_ROWS is not set. A DELETE has no such ambiguity: `affectedRows`
 * is exactly the number of rows removed, which is precisely what the caller's
 * batch-limit loop needs to know when to stop.
 */
export async function sweepExpiredSessions(
  now: Date = new Date(),
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<SessionSweepBatch> {
  const result = await db.delete(session).where(lt(session.expiresAt, now)).limit(batchSize);
  return { deletedCount: result[0].affectedRows };
}
