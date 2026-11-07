---
name: project-phase2.5-slice4-cost-flow-audit-2026-08-19
description: Phase 2.5 Slice 4 (cost flow + alerts) audit — approveInvoiceAction, product_cost_history, deriveUnitCost, alert badges — clean, no exploitable findings
metadata:
  type: project
---

Audited on branch `feat/phase-2.5-slice-4` (working tree on top of
`feat/phase-2.5-slice-3` tip — nothing committed yet at review time).
Reviewed: `lib/domain/invoice-approval.ts` (new), `lib/domain/cost-derivation.ts`
(new), `lib/invoice-line-alerts.ts` (new), `app/actions/invoices.ts`
(`approveInvoiceAction`), `db/schema.ts` (`productCostHistory` table +
`invoice_line_organization_id_id_unique`), `drizzle/0007_yielding_gideon.sql`,
`components/office/invoice-review-form.tsx` (Approve & post costs button,
alert badge rendering).

**Result: clean, no exploitable findings.** This is the strongest slice
reviewed so far in this feature — every AR called out in the task prompt
(AR-2 tenant ownership, AR-4 transaction/replay/concurrency, AR-5 real
column names + previous_unit_cost baseline) is independently verified by an
adversarial test with the EXACT name the spec gave it, and all 40 tests in
`tests/invoice-approval-path.test.ts` + `tests/invoice-line-alerts.test.ts`
pass against a real MariaDB 11.8 container (confirmed by running them
myself, not just reading them).

Specific things verified, not just read:
- `approveInvoice` is genuinely one `db.transaction`, CAS-first: `status ===
  "approved"` short-circuits to success (`costLinesApplied: 0`) BEFORE the
  per-line write loop runs at all — this, not `product_cost_history`'s
  `UNIQUE(source_invoice_line_id)`, is the idempotency mechanism. Confirmed
  by `approve_is_idempotent_on_replay` and `approve_concurrent_applies_once`
  (real `Promise.all` concurrency against MariaDB, not sequential calls
  pretending to be concurrent).
- `previous_unit_cost` is read via `SELECT current_unit_cost ... FOR UPDATE`
  on the product row, INSIDE the same transaction that later updates it —
  closes the "two invoices approved close together read the same stale
  baseline" race. Confirmed by `previous_unit_cost_chains`.
- Cross-tenant `matched_product_id`: the FOR UPDATE read is scoped to
  `(id, organizationId = actor.organizationId)`; a miss throws `NotFoundError`
  and rolls back the WHOLE transaction, including earlier lines' already-
  inserted `product_cost_history` rows in the same loop. Confirmed by
  `review_rejects_cross_tenant_product` AND `approve_rolls_back_on_midway_failure`
  (failure injected on line 3 of 5, zero cost rows left, product costs for
  lines 1-2 unchanged).
- `invoice_line.matched_product_id` stays a bare (non-composite) FK by
  design — reviewed at write time by `applyLineReviewTx`'s batch check
  (Slice 3), and `approveInvoice` does NOT trust that check to still hold;
  it re-verifies ownership itself. `product_cost_history`'s own composite
  tenant FK is a second, DB-level backstop — confirmed refusing 1452 by
  `invoice_line_fk_refuses_cross_tenant`.
- No reference to `product.unit_cost` or `unit_cost_updated_at` (the two
  nonexistent columns an earlier draft of this spec referenced) anywhere in
  the three new files — enforced by a grep-style test, not just eyeballed.
- Cost derivation (`deriveUnitCost`) never guesses: deposit/deposit_return
  lines always null, any missing/non-finite/<=0 quantity or pack_size or
  raw_net returns null (never coerced to 1 or 0), formatted with `toFixed(4)`
  to match the DECIMAL(10,4) columns rather than round-tripping through a
  JS float comparison.
- Alert badges (`computeLineAlerts`): discount>50% guards `gross === 0`/null
  to "no alert" rather than dividing by zero; negative-net is a simple `< 0`
  check. Purely client-side/derived display, never persisted — confirmed
  distinct from the persisted `KNOWN_EXCEPTION_FLAGS` enum on
  `invoice-exception-badges.tsx`, which this slice correctly left alone.
- Role gating: `approveInvoiceAction` is `requireRole("owner")` only, tested
  for manager/staff/anonymous refusal AND cross-org NotFound. The review page
  (`app/(office)/office/invoices/[invoiceId]/page.tsx`) already gates the
  whole screen to owner via `getInvoiceAction`'s own `requireRole("owner")`
  before `InvoiceReviewForm` (and its new Approve button) ever renders, so
  there's no separate client-side role check needed in the component itself.
- Staff/manager cost exposure re-checked end-to-end now that
  `current_unit_cost` actually gets populated by this slice (previously
  always null, so redaction was never really exercised): `lib/domain/
  catalog.ts:selectProducts` doesn't even SELECT the column for a caller
  where `canSeeCost(actor.role)` is false — gated at the query, not just the
  response shape. Still correct.

**Only non-finding worth a note:** `bun audit` shows the same pre-existing
transitive/dev advisories as the [[project_baseline_audit_2026-07]] baseline
(postcss vendored in next, sharp, esbuild in drizzle-kit/tsx, playwright,
brace-expansion, js-yaml, nanoid) — confirmed `package.json`/`bun.lock` are
untouched by this slice's diff, so these are carried state, not a Slice 4
regression. Not reported as a slice finding.
