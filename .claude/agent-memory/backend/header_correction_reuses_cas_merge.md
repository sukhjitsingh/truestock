---
name: header-correction-reuses-cas-merge
description: open item #32 (header-field correction on invoice review) rides updateInvoiceStatusTx's existing data-merge instead of a new null-check path; the retentionUntil auto-derivation deviation and the invoice/invoice_line money-precision split
metadata:
  type: project
---

Open item #32 ("a failed header-field extraction has no correction path on
the review screen") — backend half closed 2026-08-20, in
`feat/phase-2.5-invoice-template-open-items`. Task explicitly scoped this as
the "backend half"; the review screen (`components/office/invoice-review-form.tsx`)
was NOT updated to expose header-correction inputs, so item #32 in
`docs/open-items.md` was deliberately left open rather than marked closed —
close it only once a frontend pass adds the UI.

**Design: no new null-check path was needed.** `updateInvoiceStatusTx`
(`lib/domain/invoices.ts`) already accepts a `data` param merged with the
current row (`merged = {...row, ...data}`) and validates `REQUIRED_FOR_REVIEW`
against the merged result *before* the UPDATE. `submitInvoiceReview`
(`lib/domain/invoice-lines.ts`) already calls it inside the same transaction as
line corrections. So header corrections only needed a function that turns a
`HeaderCorrection` input into that same `data` shape —
`resolveHeaderCorrectionData` — passed as `submitInvoiceReview`'s new 4th
param (default `{}`, so every existing caller is unaffected).

**Deliberate deviation, flagged to the orchestrator:** `resolveHeaderCorrectionData`
auto-derives `retentionUntil` from a corrected `invoiceDate` via
`computeRetentionUntil` when `retentionUntil` isn't *also* explicitly
supplied in the same correction. Not explicitly requested. Reasoning: the
extraction pipeline always couples the two fields (never leaves
`retentionUntil` null while `invoiceDate` is populated), so a null
`invoiceDate` in practice means a null `retentionUntil` too — without this, a
reviewer correcting just the date would still be blocked. Justified further
by `computeRetentionUntil`'s own doc comment calling a wrong value
"unrecoverable" (legal-record-deletion risk). An explicitly-supplied
`retentionUntil` is always honored as given and never overridden.

**Money precision split, easy to miss:** `invoice.totalGross`/`totalNet` are
`DECIMAL(10,4)`; `invoice_line.rawGross`/`rawDiscount`/`rawNet` are
`DECIMAL(12,2)`. The existing `moneyStringSchema` (line-level) is the wrong
regex for header totals — needed a separate
`invoiceTotalMoneyStringSchema` (`/^-?\d{1,6}(\.\d{1,4})?$/`) in
`lib/validation/invoices.ts`. Currency normalization
(`/^[A-Za-z]{3}$/` + `.toUpperCase()` transform) mirrors the convention
already used in `lib/domain/extraction-pipeline.ts` rather than inventing a
new one — verify that convention is still there before reusing it, since
it lives in a file this memory doesn't own.

**Test fixture pattern:** added a standalone helper,
`createInvoiceMissingHeaderField(organizationId, field)`, in
`tests/helpers/test-db.ts` rather than parameterizing the shared
`createFixtures()` invoice — many other tests depend on that fixture being
fully populated on all six `REQUIRED_FOR_REVIEW` columns.

See also [[counts-increment-idempotency]] for the sibling ledger-based
correction pattern on the count side, and [[cas-replay-before-writeloop-idempotency]]
for the other place in this codebase a CAS status transition gates a
write loop.
