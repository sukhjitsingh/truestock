---
name: phase2.5-slice4-cost-flow-review
description: Phase 2.5 Slice 4 (invoice approval / cost-derivation / alert badges) review — clean, no findings; closes out the two recurring gaps flagged in Slices 2-3
metadata:
  type: project
---

Reviewed 2026-08-19: `lib/domain/cost-derivation.ts`, `lib/domain/invoice-approval.ts`
(new `approveInvoice`), `app/actions/invoices.ts:approveInvoiceAction`,
`lib/invoice-line-alerts.ts`, `db/schema.ts`'s new `product_cost_history` table +
migration `0007_yielding_gideon.sql`, and the review-form UI diff
(`components/office/invoice-review-form.tsx`), on the (uncommitted) tip of
`feat/phase-2.5-slice-4`, diffed against `feat/phase-2.5-slice-3`. No findings — every
AGENTS.md invariant plus AR-2/AR-4/AR-5/AR-7 verified sound, all 40 new tests
(`tests/invoice-approval-path.test.ts`, `tests/invoice-line-alerts.test.ts`) plus the
full 391-test suite pass against real MariaDB, `tsc --noEmit` and lint both clean.

This slice is notable for closing out BOTH recurring gaps this reviewer flagged in
Slices 2 and 3:
1. [[project-phase2.5-slice2-extraction-pipeline-review-2026-08-15]]'s "new pure/
   testable domain logic shipped with zero direct unit tests" — `cost-derivation.ts`
   got 11 direct unit tests covering every null/zero/negative branch.
2. [[project-phase2.5-slice3-matching-review]]'s "insert-then-catch-duplicate upserts
   need `withLockRetry`" — `approveInvoice`'s whole transaction is correctly wrapped in
   `withLockRetry`, and unlike Slice 3's `product_cost_history` insert doesn't even rely
   on catching 1062 as its idempotency path: the spec deliberately makes the
   `invoice.status` CAS the sole concurrency gate (return the existing success on
   zero-rows-affected, BEFORE the cost-writing loop runs at all), with the
   `UNIQUE(source_invoice_line_id)` constraint kept only as a backstop against a bug in
   that CAS — and the file's own header explains this distinction from
   `updateInvoiceStatusTx`'s any-mismatch-is-a-ConflictError shape explicitly. Both the
   sequential-replay and genuine-concurrent-race adversarial tests pass.

Other things done right worth noting as precedent for Slice 5: `previous_unit_cost` is
read via `SELECT ... FOR UPDATE` on the product row INSIDE the same transaction that
writes it forward (not read before the transaction opened) — this is exactly the AR-5
concern about two invoices approved close together for the same product recording the
same stale baseline, and `previous_unit_cost_chains` tests it directly (A->B, then B->C).
A cross-tenant `matchedProductId` that somehow bypassed the review-time ownership check
is re-checked via ownership-scoped `SELECT ... FOR UPDATE` INSIDE this transaction too,
independent of whatever `applyLineReviewTx` already verified — defense in depth done
correctly rather than trusting an earlier layer's check. `deriveUnitCost` never coerces
a missing qty/pack-size/net into a guessed number (matches AGENTS.md's
"plausible-but-wrong default" principle) and is unreachable-by-design for deposit/
deposit_return lines (filtered at the query level before the loop even calls it), yet
still carries its own defensive check + a direct unit test for it. Alert badges
(`discount > 50%`, `negative net`) guard divide-by-zero/null/blank/unparseable gross
correctly (tested) and are computed live from on-screen state while editable, from the
persisted line otherwise — never a mix.

No new patterns worth flagging for Slice 5 this time — this is the cleanest slice
reviewed so far in this feature.
