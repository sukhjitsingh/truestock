---
name: phase2.5-slice5-audit-packet-audit-2026-08-20
description: Security audit of Slice 5 (audit packet export) — createAuditPacket, buildAuditPacketJob, download route; one real medium finding (unbounded concurrent ZIP builds), rest clean and test-verified
metadata:
  type: project
---

Reviewed on branch `feat/phase-2.5-slice-5-v2` (worktree `phase-2.5-ocr-fix`),
working tree as of 2026-08-20. Files: `lib/domain/audit-packets.ts`,
`app/actions/invoices.ts` (createAuditPacketAction/getAuditPacketAction),
`app/api/audit-packets/[id]/route.ts`, `lib/email.ts`,
`lib/validation/invoices.ts` (audit-packet schemas), `components/office/audit-packet.tsx`,
`app/(office)/office/invoices/audit-packet/page.tsx`.

**Verified by actually running the adversarial suite**, not just reading code:
spun up the isolated `docker-compose.worktree-test.yml -p truestock-slice5-test`
stack (never the main checkout's live `truestock-mariadb`), migrated, ran
`tests/audit-packet.test.ts` — 28/29 passed; the 1 failure ("backwards range
refused") was a `beforeEach`/`afterEach` hook timeout that passed cleanly when
re-run in isolation (`-t "backwards range"`). Consistent with the pre-existing
shared-DB test-execution race noted in [[project_open_items_2_32_33_audit_2026-08-20]]
— not a defect in this slice's code. Torn down after (`down -v`).

**What's correct (verified against actual code + passing tests, not just docs):**
- AR-3 backstop (assert exactly one distinct `organizationId` across candidate
  `audit_packet_file` rows before marking `ready`) is real: candidates carry
  the SOURCE row's own `organizationId` (`inv.organizationId`/`row.organizationId`),
  never the expected `orgId` hardcoded — so the assertion is load-bearing, not
  decorative. `buildAuditPacketJob` derives `orgId` only from the `audit_packet`
  row itself, never a caller.
- Job's top-level try/catch always marks `status = "failed"` on any exception
  (missing file, AR-3 violation, DB error), itself wrapped in its own
  try/catch so a failure to *record* failure can't become an unhandled rejection.
  Confirmed the packet never gets stuck `building` forever.
- Download-link expiry (10 min TTL) is enforced server-side at BOTH read paths
  (`getAuditPacketAction` and the download route), via a shared
  `loadFreshAuditPacket` that lazily CAS's a lapsed `ready` row to `expired`
  (`WHERE status = 'ready'`, so concurrent racers are harmless — loser's WHERE
  matches zero rows). Not just a client-side check.
- Path traversal on the stored ZIP path reuses `lib/storage/invoice-files.ts`'s
  `resolveStoredPath` (resolve-then-contain check against `root + sep`) — same
  AR-1 module Slice 1-4 use. Test directly proves a `../../etc/passwd` stored
  path 404s identically to an unknown id (byte-identical JSON body).
- Cross-tenant `packetId` on both the action and the route handler resolves to
  the exact same 404/NotFoundError shape as an unknown id — no distinguishing
  oracle. Ownership check (`organizationId` in the WHERE, not checked after
  the fact) is real (invariant 9).
- No raw SQL anywhere in the new files — all Drizzle query builder.
- No secrets, no client-bundle leakage (`lib/domain/audit-packets.ts` and
  `archiver` are server-only: server actions + a route handler, never imported
  by a client component). `lib/email.ts`'s SendGrid path only fires when
  `EMAIL_PROVIDER` is set (unset in this repo/tests) and never throws past its
  own boundary.
- Error responses (`lib/action-result.ts:runAction`, the route's
  `errorResponse`) collapse any non-domain error to a generic message,
  logging the real error server-side only — no stack/SQL/path leakage.

**Real finding (medium, not theoretical):** `createAuditPacketAction` /
`buildAuditPacketJob` have no per-organization lock, dedup, or concurrency cap.
Zod schema deliberately allows an unbounded date span ("everything we have" —
invoices/counts are never hard-deleted). Each job loads every matched
invoice's full file bytes into memory (`zipEntries`) before writing the ZIP,
and the app is a single Node process on a shared 5-10 connection pool
(AGENTS.md). A burst of repeated requests (multiple tabs, or just re-clicking
before the client-side `submitting` flag catches up — that's client-side only,
nothing stops a second concurrent server-action call) or one wide-range
request against two years of invoices is a real memory/connection-pool
exhaustion risk that would degrade the whole multi-tenant app, not just that
owner's org. Owner-role-gated so the *trigger* requires a trusted account, but
the *blast radius* crosses tenants (single shared process) — worth a lock (e.g.
refuse a new `createAuditPacket` while the org already has a `building` packet)
before this ships against real 2-year invoice volumes.

**Low/theoretical:** `archiver@8` pulls in `readdir-glob` → `minimatch` →
`brace-expansion`, which has known high-severity DoS advisories (`bun audit`:
GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895). Dormant in this codebase: the code
only calls `archive.append()` with in-memory buffers, never
`archive.glob()`/`archive.directory()`, so the vulnerable glob-matching path
is never reached at runtime. Same "known advisory, unreachable code path"
shape as the sharp/postcss findings in
[[project_baseline_audit_2026-07]] — worth tracking, not urgent, and a reason
not to add glob-based archiving later without revisiting.
