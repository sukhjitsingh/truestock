---
name: testing-parallel-worktree-docker-and-migration-race
description: How to run bun test against real MariaDB from a git worktree when another worktree/session already has docker-compose.yml's containers up, and why concurrent migrateTestDatabase() calls can corrupt a brand-new test database
metadata:
  type: feedback
---

Two compounding gotchas hit when testing Phase 2.5 Slice 2 from a **worktree**
(`.claude/worktrees/phase-2.5-slice-1`) while the main checkout already had its
own `docker-compose.yml` stack running (started by another session/agent).

**1. Don't reuse or fight the main checkout's compose stack from a worktree.**
`docker-compose.yml`'s `container_name`s are fixed, so `bun run docker:up` from
the worktree collides ("Container name /truestock-mariadb already in use").
Merging with `-f docker-compose.yml -f override.yml` doesn't help either —
Compose 2.23.0 (this machine) **concatenates** list-type keys like `ports`
across merged files instead of replacing them, so both the old and new ports
end up in the merged config and fail to bind (needs Compose 2.24+'s
`!override` tag to fix, unavailable here). The actual fix: write one
**complete, standalone** Compose file (not a merge) with renamed
`container_name`s, renamed volumes, a distinct `-p <project>` flag, and — since
only `docker compose exec` is needed for `bun test`, not host access — **no
published ports at all**. Fully isolated from whatever the other checkout is
running; nothing to collide.

**2. MySQL/MariaDB DDL auto-commits, so concurrent `migrateTestDatabase()`
calls against a brand-new database race.** `tests/helpers/test-db.ts`'s
`beforeAll()` in every test file calls `migrateTestDatabase()`, and `bun test`
runs files concurrently. Against an **already-migrated** database this is a
fast no-op and harmless. Against a **fresh, never-migrated** database, two
racing `drizzle-kit`-style `migrate()` calls can both observe "nothing applied
yet" and both start applying the same migration file. DDL isn't rolled back by
a failed "transaction" (MySQL/MariaDB auto-commits each DDL statement), so the
first `CREATE TABLE` that lands is never undone even though the overall apply
then fails later in the same file (the migration-tracking insert never lands).
Every retry after that then hits `ER_TABLE_EXISTS_ERROR`, and the same
concurrency separately produces `Duplicate entry` / FK errors from
`resetDatabase()` (TRUNCATE, resets AUTO_INCREMENT) racing a concurrent
`createFixtures()` INSERT in another file.

**Why:** both are the same root cause — test files run concurrently and
correctly assume an idempotent, already-migrated schema, but the *first* run
against a fresh database violates that assumption.

**How to apply:** when standing up a **fresh** test database (new Docker
volume, new CI runner, first run after a `docker compose down -v`), run the
migration **once, explicitly, before invoking `bun test` at all** —
`docker compose exec ... app bunx drizzle-kit migrate` as its own step — so
every file's own `migrateTestDatabase()` call becomes a no-op against an
already-fully-migrated schema. Don't rely on `bun test`'s own concurrency to
migrate safely on a cold database. If you see `ER_TABLE_EXISTS_ERROR` cascading
into unrelated `Duplicate entry`/FK failures on a first run only, this race is
the likely cause — rerunning after an explicit pre-migration is the fix, not
chasing the FK error itself.

See also [[pdf-inspector-no-darwin-x64-binary]] — the other reason full-suite
testing here has to happen inside Linux Docker rather than on the host Mac.
