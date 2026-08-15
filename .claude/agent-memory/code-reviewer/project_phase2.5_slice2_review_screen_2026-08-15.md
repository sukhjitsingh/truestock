---
name: project-phase2.5-slice2-review-screen-2026-08-15
description: Review of the invoice review/reject/resend screen (commit 7907cdc + frontend working tree) — invariants clean, one real workflow dead-end found
metadata:
  type: project
---

Reviewed the Slice 2 review-screen layer: `app/actions/invoices.ts`
(getInvoiceLinesAction/reviewInvoiceAction/rejectInvoiceAction/resendToExtractionAction),
`lib/domain/invoice-lines.ts` (applyLineReviewTx/submitInvoiceReview), `lib/domain/invoices.ts`'s
CAS machinery, `lib/domain/extraction.ts`'s `ORDER BY id DESC` fix, and the new frontend
(`invoice-review-form.tsx`, `invoice-exception-badges.tsx`, `[invoiceId]/page.tsx`, the invoices
list's new Review column). All nine AGENTS.md invariants plus AR-2/AR-4/AR-6/AR-7 hold: CAS uses
`SELECT ... FOR UPDATE` (not a bare conditional UPDATE) so concurrent transitions correctly
serialize; `applyLineReviewTx` batch-ownership-checks both line ids AND matchedProductId in one
query each, BEFORE any write; `approved` is genuinely terminal (`INVOICE_TRANSITIONS.approved =
[]`, enforced independent of caller); every new query is tenant-scoped; owner-only gating is
real (`requireRole("owner")` inside every action, not just the route); money fields stay
decimal-strings end to end with a Zod regex bounded to the DECIMAL(12,2) column width (the thing
[[project-phase2.5-slice2-extraction-pipeline-review-2026-08-15]] flagged as commonly missed —
done correctly here). Forms are `method="post"`, no `<tr onClick>`. 31 tests, thorough and
mutation-checked, matching every adversarial case 04-slices.md names.

One real correctness gap, not previously flagged: **`REQUIRED_FOR_REVIEW` (invoiceDate,
invoiceNumber, totalGross, totalNet, currency, retentionUntil — built in Slice 1) has no
correction path anywhere in Slice 2.** `LineCorrection`/`reviewInvoiceSchema` only carry
line-level fields; the review form never renders these header fields as editable. If extraction
can't determine one of them (bad scan, ambiguous currency), the invoice is stuck at
`needs_review` forever — Approve fails with a correctly-worded but unfixable
`InvoiceNotWritableError`, and the only other action (Return → Retry extraction) just re-runs
the same pipeline against the same document, most likely reproducing the same gap. No test
exercises this because the test fixture always populates all six fields. Not a security/invariant
issue — a scope gap between two slices that only becomes reachable now that Slice 2 actually
drives the CAS into `reviewed`. Check whether Slice 3/4 plans ever add header-field correction;
if not, worth raising before Slice 2 ships.

Two minor, low-severity UI bugs, both in `components/office/invoice-review-form.tsx`: (1) line 272
`columnCount = editable ? 7 : 6` but the table always renders 7 `<TableHead>`s regardless of
`editable` — wrong colSpan on the empty-state row for reviewed/rejected/approved invoices with
zero lines. (2) the matched-product read-only label and the edit `<Select>` are both built from
`searchProductsAction({ activeOnly: true, limit: 100 })` (page.tsx:58) with no search/pagination —
a matched product outside the first 100 (catalog is already 97 products at seed) renders as "not
entered" in the read-only view even though a match exists. Worth rechecking whenever this pattern
(populate a picker from an unbounded `searchProductsAction` call) recurs in Slice 3's matching UI.
