---
name: phase1-1.5-slices-audit
description: Security audit of feat/phase-1-to-1.5 (locations CRUD, inline cost editing, dashboard aggregate reads, session sweep, docker-up guard) — clean, no exploitable findings
metadata:
  type: project
---

Audited 2026-08-12: branch `feat/phase-1-to-1.5` (9f81967) against `main`
(bbf002b), covering all 7 slices in `docs/plans/phase-1-to-1.5/04-slices.md`
(locations CRUD + migration 0003, locations deactivate + guards, inline
cost/case-size editing, dashboard aggregate reads `#14`, reorder copy/print,
and the three script/dev-env guards `#23`/`#24`/`#1b`).

**Verdict: ship. No exploitable findings — genuinely clean work, not a case
of under-auditing.** Every new server action re-checks role via
`requireRole` (never trusts middleware alone — invariant 7). Every new
domain function scopes to `actor.organizationId`, never client input
(invariant 9), and ownership-checks client-supplied `locationId` via
`assertLocationOwned` before any read or write, returning `NotFoundError`
for a cross-tenant id — verified against both the code and dedicated
cross-tenant tests (`tests/location-write-path.test.ts`,
`tests/reports-write-path.test.ts`'s "a second tenant's closed count never
appears"). Cost/margin gating (invariant 8) verified in the actual
serialized payload, not just the UI: `getCatalogHealth`'s `unpricedCount`
query never runs for a non-owner caller;
`updateProduct`/`selectProducts` (pre-existing, unchanged) strip
`currentUnitCost` from the response object entirely for non-owner roles,
confirmed by a test asserting `expect(updated).not.toHaveProperty
("currentUnitCost")` against the real return value, not the DOM. The new
`EditableProductCell` (inline cost/case-size editing) makes zero new
server actions — reuses `updateProductAction` verbatim, matching Gate 2
Decision 7.

No raw SQL anywhere in the diff — 100% Drizzle query builder. No secrets in
the diff (checked `.env*` untouched, grepped for password/token/API-key
patterns — all hits were schema field names or unrelated doc prose). No
dependency version bumps in this branch (package.json only changed script
entries), so no new advisory surface.

The two new CLI scripts (`sweep-sessions.ts`, and the added guard on
`create-user.ts`) both use the `import.meta.url ===
pathToFileURL(process.argv[1]).href` entry-point guard, matching
`db/seed.ts`'s existing convention — confirmed neither runs privileged work
on import. `sweepExpiredSessions` is deliberately unscoped by
organization, which is correct: `session` is one of the two tables
invariant 9 names as a documented exception (keyed by `user_id`, no tenant
concept for an expiry sweep).

`scripts/docker-up-guard.sh` (`#24`) interpolates `docker inspect` output
(`dev_lan_origin`, `node_env`, `app_bind_host_ip`) into an unquoted heredoc
via `${...}` — checked this is display-only (printed to stderr), never
passed to `eval`/`bash -c`/`docker exec`. Not an injection vector.

One non-security, cosmetic deviation worth a future glance if anyone
revisits slice 3: `04-slices.md`'s own proof description for
`deactivateLocation`'s in-use refusal says the message should be "naming
the open count," but the actual `DomainError` text
(`lib/domain/catalog.ts`) is generic ("This location has counted lines on
an open count...") and does not include a specific count id/number. Purely
a UX/spec-wording gap, not a security issue — did not rise to a finding in
the audit output.

See also [[project_multitenant_audit_2026-07]] and
[[project_backend_auth_audit_2026-07]] for the underlying `requireSession`
/ `requireRole` / `canSeeCost` infrastructure this slice bundle builds on,
all confirmed unchanged and still correct in this pass.
