---
name: project-open-items-2-32-33-audit-2026-08-20
description: Security audit of open-items #2 (fill-correction ledger), #32 (invoice header-correction), #33 (matching pipeline integration test) on feat/phase-2.5-open-items-2-32-33 — clean, no exploitable findings
metadata:
  type: project
---

Audited uncommitted working-tree changes closing docs/open-items.md #2, #32, #33
(branch feat/phase-2.5-open-items-2-32-33, on top of c2cf661). All three closed
cleanly, no exploitable findings.

**#32 header correction, tenant isolation** — `resolveHeaderCorrectionData`
(lib/domain/invoices.ts) does a pure data transform, no DB query. It's passed as
`updateInvoiceStatusTx`'s existing `data` param inside `submitInvoiceReview`
(lib/domain/invoice-lines.ts) — the SAME `SELECT ... FOR UPDATE ... WHERE
eq(invoice.id) AND eq(invoice.organizationId, actor.organizationId)` / matching
`UPDATE ... WHERE` that line corrections already go through. No new lookup was
added. Confirmed by direct trace, not by trusting the PR description.

**#2 editCountLineFills idempotent replay** — new code is a byte-for-byte
structural copy of the already-shipped `setCountLineQuantities` pattern:
`findReplayedLine` fast-path pre-check (org-scoped, shared helper, unchanged)
→ transaction with ledger insert SECOND and uncaught → catch on
`isDuplicateKeyError` → re-run `findReplayedLine` and return that as success.
The risk this closes is real but narrow: before this change `editCountLineFills`
wrote NO ledger row at all (open item #2's own framing — audit-trail gap, not a
double-count risk, since a full-array SET on `count_line` is naturally
idempotent regardless of the ledger). Adding the ledger write is what
introduced a NEW risk (duplicate `count_line_write` rows polluting the audit
trail on a retried submit), and the fast-path-plus-catch shape closes it via
the pre-existing unique index on `count_line_write.client_line_id`
(deliberately global, not org-scoped — invariant 9's documented carve-out,
unchanged by this diff). Confirmed: it closes the risk, doesn't relocate it.
One pre-existing (not new) characteristic worth remembering: the replay
lookup keys on `client_line_id` alone, with no check that the replayed row's
`countLineId` matches the caller's requested `countLineId` — identical in
`setCountLineQuantities`/`applyIncrement` today, so not a regression, and
`client_line_id` is a fresh-per-attempt v4 UUID by convention so this should
never actually collide across lines.

**#33 extraction-pipeline integration test** — the new test in
tests/extraction-pipeline.test.ts mocks `classifyPdf`/`processPdf`/
`extractInvoice` entirely (the latter throws if called) and seeds a
`vendor_alias` row directly. No `ANTHROPIC_API_KEY` handling was touched by
this diff (that block, further down the same file, is pre-existing and
unmodified). No real credential in the diff.

**Verification note (environment limitation, not a code finding):** direct
`bun test` against the shared `truestock-mariadb` container (host port 3307)
produced FK-constraint failures inconsistent with the schema (organization row
verified to exist via direct query, insert into `user`/`location` referencing
it failed anyway) — almost certainly contention from another concurrent
process/worktree also truncating/reseeding the same shared `truestock_test`
database (this repo's own docker-compose.worktree-test.yml comments document
this exact class of race). Not reproducible as a code defect via manual
tracing. Migrations (`0008_lyrical_romulus.sql`) DID apply cleanly against
real MariaDB 11.8 when run in isolation. Backend agent's own memory
(.claude/agent-memory/backend/counts_increment_idempotency.md) documents a
mutation-check that passed. Conclusions in this review rest on direct code
tracing, corroborated but not independently re-executed end-to-end.

See [[project-multitenant-audit]] and [[project-phase2.5-slice2-review-screen-audit]]
for the prior audits this one extends (the org-scoping pattern reused here was
established and verified in those).
