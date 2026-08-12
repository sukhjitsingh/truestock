/**
 * CLI entry point for the session sweep (#1b, docs/open-items.md).
 *
 * Run with `bun run sweep-sessions` (loads `.env.local`'s DATABASE_URL the
 * same way `bun run db:seed` / `bun run create-user` do — see db/README.md).
 *
 * There is no cron wired to this yet. Phase 3 wires a Hostinger cron
 * directly to this script against production `DATABASE_URL`, once Hostinger
 * exists (00-status.md) — that is deliberately not part of this change.
 */
import { pathToFileURL } from "url";
import { closePool } from "@/db";
import { sweepExpiredSessions } from "@/lib/domain/sessions";

// Mirrors sweepExpiredSessions's own default (lib/domain/sessions.ts) so the
// loop's stopping condition — "the last batch came back smaller than what
// was asked for" — is checked against the same number that was requested.
const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const now = new Date();
  let total = 0;

  for (;;) {
    const batch = await sweepExpiredSessions(now, BATCH_SIZE);
    total += batch.deletedCount;
    if (batch.deletedCount < BATCH_SIZE) break;
  }

  console.log(`Swept ${total} expired session row(s).`);
}

// Guard: only run main() if this module IS the entry point, not when
// imported from another file (e.g. a test importing sweepExpiredSessions
// from lib/domain/sessions.ts directly). Same guard as db/seed.ts:363 and
// scripts/create-user.ts — see db/seed.ts's comment for why this matters:
// importing this module unconditionally triggering main() would issue a
// live DELETE against whatever DATABASE_URL happens to be active.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      console.error("Session sweep failed:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
