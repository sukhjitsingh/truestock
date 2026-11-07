---
name: vendor-alias-matching-design
description: Phase 2.5 Slice 3 vendor_alias matching design — confidence formula, why matchLinesToProducts takes vendorId explicitly, matchedVendorAliasId's single-setter rule, the Docker test-env concurrency hazard hit while building it, and the withLockRetry / 1020 ER_CHECKREAD deadlock-retry fix from the follow-up review
metadata:
  type: project
---

Built `lib/domain/matching.ts` (Phase 2.5 Slice 3, "Matching" per
`docs/plans/phase-2.5-invoice-automation/04-slices.md`) — the "fix once" layer:
a human maps a vendor SKU to a product exactly once via the review screen
(`applyLineReviewTx` in `lib/domain/invoice-lines.ts` calls `upsertAliasTx`),
and every later invoice from that vendor with the same `vendor_item_code`
arrives pre-matched (`matchLinesToProducts`, wired into
`lib/domain/extraction-pipeline.ts:runClaimedJob` between parse and persist).

**Confidence formula:** starts at the schema default 0.500 on first alias
creation; each reconfirmation of the SAME `(vendorId, vendorItemCode) ->
productId` mapping climbs via `next = current + (1 - current) * 0.5` (0.500 ->
0.750 -> 0.875 -> 0.938 -> ...), capped at 0.999 so `DECIMAL(4,3)` rounding
can never reach 1.000. A submitted `productId` that DIFFERS from the alias's
current one resets confidence to 0.500 — a just-changed mapping has exactly
as much proof as a brand-new one, not the accumulated trust of the old one.

**Why `matchLinesToProducts` takes `vendorId` as an explicit parameter** even
though `04-slices.md`'s own sketch signature omits it: `vendor_alias`'s only
unique key is `(organizationId, vendorId, vendorItemCode)` — two different
vendors are free to reuse the same SKU code for unrelated products (a supplier
code is only unique within that supplier's own catalog), so a lookup that
omitted `vendorId` couldn't even select a single row. This was a deliberate
correction of the plan doc, not scope creep — flag it if a future slice's own
plan doc sketch conflicts with an already-built unique constraint; the
constraint wins.

**`matchedVendorAliasId` has exactly one legitimate setter** —
`matchLinesToProducts` (automatic match). `applyLineReviewTx` (a human's
manual match) deliberately leaves that column untouched on the line being
corrected, per `db/schema.ts`'s own column comment; `matchMethod: "manual"` on
that same line already records how it got matched. Don't "fix" this by having
the review path also set `matchedVendorAliasId` — it would blur which of the
two paths actually produced a given line's match.

**Alias-table side effects that deliberately do NOT happen**, both non-errors:
a clear-to-null correction (`matchedProductId: null`) never touches the alias
table (undoing a mismatch on one invoice isn't evidence the vendor's mapping
itself is wrong); a line with no `vendorItemCode`, or an invoice with
`vendorId: null`, is left completely unmatched with nothing to key an alias
on.

**Root-cause bug and fix while building `upsertAliasCore`:** see
[[mysql-onduplicate-assignment-order]] — a single-statement
`INSERT ... ON DUPLICATE KEY UPDATE` could not correctly compare submitted vs.
stored `productId` because MySQL/MariaDB assignment order follows the table's
schema-declared column order, not the statement's. Fixed by following
`lib/domain/counts.ts`'s established insert-first / catch-duplicate-key /
`SELECT ... FOR UPDATE` / branch-in-JS idiom instead.

**Test-environment hazard hit while verifying the fix:** two `oven/bun:1`
Docker containers ended up running `bun test` concurrently against the same
shared `truestock_test` MariaDB database, because a background `docker run ...
&` launch was wrapped in a manual shell `&` INSIDE a Bash tool call that
already had `run_in_background: true` — that produced an orphaned, untracked
container in addition to the "properly" launched one. Every test file's
`beforeEach` calls `resetDatabase()` (full-table truncate), so two concurrent
runs race and corrupt each other's fixtures; caught via `docker ps` /
`docker inspect --format '{{.State.StartedAt}}'` showing two containers
running the same `bun test` command ~17s apart. Never nest a manual `&`
background job inside a script passed to a tool call that already has its own
`run_in_background: true` — pass the actual long-running foreground command
directly instead. `docker ps` before starting a new test run confirms nothing
stray is still active.

**Follow-up review fix (2026-08-15): `withLockRetry` had to move to the
OUTER transaction, and `isTransientLockError` had to learn a second error
code.** Code review found `upsertAliasCore`'s recovery `SELECT ... FOR
UPDATE` could deadlock (1213) under 3+ concurrent upserts of the same
`(org, vendor, vendorItemCode)` — a real scenario (two reviewers correcting
the same vendor SKU at once) — and `isDuplicateKeyError` doesn't catch 1213,
so it propagated raw. Fixed by wrapping the two call sites that actually
*open* the transaction in the existing `withLockRetry` (`lib/domain/db-
errors.ts`, already used by `lib/domain/counts.ts`): `matching.ts`'s
standalone `upsertAlias`, and — this is the one that matters —
`invoice-lines.ts`'s `submitInvoiceReview`, NOT `upsertAliasTx` itself.
`upsertAliasTx` runs mid-transaction inside `submitInvoiceReview`'s
`db.transaction`, sharing its `tx`; InnoDB rolls a deadlock back in full, so
wrapping only the inner alias call can't recover — only retrying the whole
outer transaction (corrections + status CAS together) does.

**A second, non-obvious failure mode only shows up through the real
production path, not through direct `upsertAlias` calls:** a real 3-way
concurrent `Promise.all` of `submitInvoiceReview` (three different invoices,
one line each, same `vendor_item_code`, same vendor, same target product)
reproduced MariaDB error **1020 `ER_CHECKREAD`** ("Record has changed since
last read... try restarting transaction") on that same recovery `SELECT ...
FOR UPDATE` — deterministically, in isolation, not test-file contention
(confirmed by running just those two tests alone). The equivalent race
driven through bare `upsertAlias` calls never produced it. Root cause:
`submitInvoiceReview`'s transaction does more work before reaching the alias
SELECT (invoice/invoice_line/product ownership checks, an `invoice_line`
UPDATE, the invoice status CAS), which is enough extra time under
REPEATABLE READ for a concurrent committer to change the row between this
transaction's snapshot and its locking read of it. **Lesson: a
lock-contention bug can be real and reproducible yet invisible to a test
that calls the narrow function directly — it can require the full-sized
surrounding transaction to manifest.** Fixed by widening
`isTransientLockError` in `db-errors.ts` to also recognise
1020/`ER_CHECKREAD` (MariaDB's own error text literally says "try
restarting transaction," the same remedy already given to 1213/1205) —
this flows through the existing `withLockRetry` mechanism with no other
code changes, and also covers `counts.ts`'s existing call sites, not just
this one.
