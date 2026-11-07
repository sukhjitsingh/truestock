---
name: phase2.5-slice3-matching-review
description: Phase 2.5 Slice 3 (vendor-alias matching) backend review — invariant 9 sound; two recurring patterns to recheck in Slices 4-5
metadata:
  type: project
---

Reviewed 2026-08-15: `lib/domain/matching.ts` (new), `lib/domain/invoice-lines.ts` and
`lib/domain/extraction-pipeline.ts` diffs, `db/schema.ts`'s `vendor_alias` table, on
`feat/phase-2.5-slice-3` vs `feat/phase-2.5-invoice-automation`. Invariant 9 (org-scoped,
ownership- not existence-checked) verified sound end-to-end: `vendor_alias.vendorId` has
the composite tenant FK, `applyLineReviewTx`'s pre-existing three-ownership-check sequence
runs before the new alias-upsert, `matchLinesToProducts`'s `vendorId` traces back through
`getInvoice` to `assertVendorOwned` at invoice-creation time. Confidence math
(`next = current + (1-current)*0.5`, capped 0.999, reset to 0.500 on a differing productId)
matches its tests exactly. Migration/schema work (composite tenant FK, correct reversal
including the MariaDB "DROP COLUMN doesn't drop a composite index" gotcha) is clean.

Two non-invariant gaps found, worth rechecking on Slices 4 (cost-derivation locking, AR-5)
and 5:

1. **Insert-then-catch-duplicate-then-`SELECT...FOR UPDATE` upsert patterns need
   `withLockRetry`, not just `isDuplicateKeyError`.** `lib/domain/matching.ts`'s
   `upsertAliasCore` copies `lib/domain/counts.ts`'s `upsertCountLineRow` shape (and says so
   at length in its own comment) but drops the `withLockRetry` wrapper that shape's
   precedent uses at every call site. The gap is real, not hypothetical: when ≥3
   concurrent callers race to upsert the SAME unique key, every loser after the first ends
   up holding a shared lock on the conflicting row and racing to upgrade it to exclusive via
   `.for("update")` — a textbook InnoDB lock-upgrade deadlock (1213), which
   `isDuplicateKeyError` (only checks 1062) does not catch. Since `upsertAliasTx` runs
   inside the caller's own transaction (`applyLineReviewTx` inside `submitInvoiceReview`),
   the fix isn't wrapping the inner call — a MySQL deadlock rolls back the WHOLE
   transaction — it's wrapping the outer transaction (`submitInvoiceReview`) in
   `withLockRetry`, the same way `counts.ts` wraps `applyIncrement`'s entire
   `db.transaction(...)` call, not just the risky inner section.
   **How to apply:** any new insert-then-catch-duplicate upsert (Slice 4's
   `product_cost_history` append-only insert, `UNIQUE(source_invoice_line_id)`, is the next
   candidate) needs to be checked for this same gap — ask "does the transaction that can hit
   this recovery branch get retried on a genuine 1213/1205, not just handled for 1062."

2. **A test that duplicates pipeline logic instead of calling the real function is not
   coverage of that function.** `tests/matching.test.ts` has strong coverage of
   `matchLinesToProducts`/`upsertAlias` in isolation, but the actual Slice 3 integration
   point — `matchLinesToProducts` wired into `lib/domain/extraction-pipeline.ts:runClaimedJob`
   plus its post-match "unmatched item" flagging loop — has no test calling
   `runClaimedJob`/`processExtractionQueue` at all (confirmed: this was ALSO true before
   Slice 3, in the Slice 2 baseline — not a regression, but Slice 3 added new logic to that
   same unexercised path). The nearest test hand-copies the flagging loop into the test file
   with a comment saying it "mirrors runClaimedJob's own loop verbatim" — which means the
   test and the implementation can silently diverge with the test still green.
   **How to apply:** when reviewing Slice 4/5, check whether `runClaimedJob`/
   `processExtractionQueue`/`approveInvoiceAction` (the other big untested-at-integration-
   level function per this pattern) got a real test this slice, or just another isolated
   unit test of a piece of it. If a slice keeps adding logic to `runClaimedJob` without ever
   testing `runClaimedJob` itself, that's worth naming explicitly rather than re-approving
   quietly slice after slice.

See also [[truestock-countline-gap-lock-deadlock]] (native auto-memory) for the original
`count_line` deadlock this precedent is modeled on.
