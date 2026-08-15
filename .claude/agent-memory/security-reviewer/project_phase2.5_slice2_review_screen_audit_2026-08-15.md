---
name: project-phase2.5-slice2-review-screen-audit-2026-08-15
description: Audit of the invoice extraction review screen (getInvoiceLinesAction, reviewInvoiceAction, rejectInvoiceAction, resendToExtractionAction) — clean, no exploitable findings
metadata:
  type: project
---

Ran 2026-08-15 against commit 7907cdc + working tree (worktree-phase-2.5-slice-1), the
Phase 2.5 Slice 2 review screen: `app/actions/invoices.ts` (4 new actions),
`lib/validation/invoices.ts` (new Zod schemas), `lib/domain/invoice-lines.ts` (new),
`lib/domain/invoices.ts:resendInvoiceToExtraction`, `lib/domain/extraction.ts`'s
`ORDER BY id DESC` change, the new `/office/invoices/[invoiceId]` route, and
`components/office/invoice-review-form.tsx` / `invoice-exception-badges.tsx`.

**Verdict: clean. No critical/high findings.** Extends the pattern in
[[project-phase2.5-slice2-extraction-pipeline-audit-2026-08-15]] and
[[project-multitenant-audit-2026-07]].

Specifically verified against actual query code, not assumed from comments:
- AR-2's batch `matchedProductId` ownership check
  (`lib/domain/invoice-lines.ts:applyLineReviewTx`) is genuinely one `inArray` SELECT
  over every submitted product id, run BEFORE any `UPDATE`, inside the same transaction
  as the writes — not per-line, not raceable by submission order. Mutation-checked tests
  exist for exactly this (`invoice-review-path.test.ts`).
- The `needs_review`/`reviewed`/`rejected` CAS (`updateInvoiceStatusTx`) uses
  `SELECT ... FOR UPDATE` so two concurrent terminal actions (review vs. reject, or a
  double-fired resend) serialize correctly: the loser sees the mutated status and raises
  `ConflictError`, rolling back its own line corrections atomically (they're one
  transaction, not two). `approved` has no writer anywhere in the codebase yet (the
  review screen's "Approve" button intentionally only reaches `reviewed`, matching
  04-slices.md's acceptance criteria) — so `approved` is currently unreachable full stop,
  trivially satisfying "unreachable from rejected."
- The prior audit's flagged follow-up — `extraction_job.error_message` reaching a
  client once the review UI existed — is CONFIRMED NOT TO HAVE HAPPENED:
  `getInvoiceLinesAction`/`InvoiceLineRow` never selects from `extraction_job` at all,
  and grep confirms no new action returns it. `extraction_status_hides_error_message`'s
  test still passes against `listInvoicesRedactedAction` (unchanged, Slice 1).
- Role gating is triple-layered and each layer independently correct: page-level
  `requireOfficeUser()` redirects staff before any query runs; `getInvoiceAction`/
  `getInvoiceLinesAction`/`reviewInvoiceAction`/`rejectInvoiceAction`/
  `resendToExtractionAction` all call `requireRole("owner")` as their own first line;
  and even if a manager reached the client component, every cost field it renders came
  from an owner-gated fetch already. Cross-tenant `invoiceId` gets `NotFoundError`
  (never a distinguishable 403-shaped answer) at both the invoice and the line-batch
  ownership checks.
- All three interactive forms in `invoice-review-form.tsx` carry `method="post"`,
  satisfying AGENTS.md's plaintext-in-query-string rule for pre-hydration submits.
- No raw `sql` template, no string-built query, anywhere in the new domain files.
- `bun audit`: unchanged from the existing baseline (postcss/sharp/playwright/esbuild/
  js-yaml/brace-expansion — vendored, dormant, or dev-tooling-only). No new Next.js CVE,
  no new direct-dependency advisory from this diff.
- No secrets in `.env.example`'s new `ANTHROPIC_API_KEY=""` line or anywhere in the new
  files (grep-confirmed).

One low-severity/theoretical latent note, not exploitable today: `applyLineReview`'s
early return on an empty `corrections` array skips its own invoice-ownership check
entirely (no query runs). Currently safe because its only production caller
(`submitInvoiceReview`) always performs the ownership-checked CAS immediately
afterward in the same transaction — but a hypothetical future direct caller of
`applyLineReview(actor, foreignInvoiceId, [])` would get a silent no-op success instead
of `NotFoundError`. Worth a one-line guard or comment if this function ever gets a
second caller.
