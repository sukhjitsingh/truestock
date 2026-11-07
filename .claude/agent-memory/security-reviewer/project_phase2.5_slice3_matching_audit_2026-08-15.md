---
name: phase2.5-slice3-matching-audit
description: Security audit of Phase 2.5 Slice 3 (vendor SKU matching / alias learning) — the exact AR-2 gap the design review warned about, verified closed
metadata:
  type: project
---

Audited `feat/phase-2.5-slice-3` (commits `b887178` schema, `7843806` backend)
against `feat/phase-2.5-invoice-automation` — `lib/domain/matching.ts` (new),
`lib/domain/invoice-lines.ts` (alias-teaching hook in `applyLineReviewTx`),
`lib/domain/extraction-pipeline.ts` (auto-match wiring), `db/schema.ts`
(`vendor_alias` table + `invoice_line.matched_vendor_alias_id`).

**Verdict: clean.** This is precisely the code the 2026-08-14 adversarial
review's AR-2 finding (`docs/reviews/2026-08-14-phase-2.5-adversarial-review.md`)
warned would be dangerous — a client-supplied `matched_product_id` persisting
into a table (`vendor_alias`) that *re-applies itself* to every future
invoice — and the implementation gets the ordering right:
`applyLineReviewTx` runs invoice-ownership check -> line-ownership check ->
BATCHED product-ownership check (all corrections' `matchedProductId`s
verified against `actor.organizationId` in one query) -> only then, inside
the per-correction loop, calls `upsertAliasTx` with an already-verified
`productId`. Confirmed by reading the code (not just trusting comments) and
by running the tests against a real MariaDB
(`DATABASE_URL=mysql://truestock:truestock@127.0.0.1:3307/truestock_test bun
test tests/matching.test.ts tests/invoice-review-path.test.ts` — 48/48 pass,
including explicit MUTATION-CHECKED tenant-isolation tests and an AR-2
regression test that a cross-tenant `matchedProductId` is refused and
**leaves no `vendor_alias` row behind**).

`vendor_alias` itself carries the composite tenant FK on
`(organization_id, vendor_id)` -> `vendor(organization_id, id)` — the schema
fix AR-2's second pass specifically named for this table — verified present
in both `db/schema.ts` and the generated migration SQL
(`drizzle/0006_colorful_pretty_boy.sql`). `product_id` and
`invoice_line.matched_vendor_alias_id` are deliberately bare (non-composite)
FKs, but both are justified and correct: every code path that writes them
has already ownership-checked the id upstream (batched product check before
`upsertAliasTx`; `matchLinesToProducts`'s own org+vendor-scoped query before
setting `matchedVendorAliasId`) — grepped the whole tree and confirmed
`matchLinesToProducts`/`upsertAlias(Tx)`/`findAlias` have exactly the two
call sites the file's own header comment claims, no others.

No raw SQL in the diff (one pre-existing `sql\`\`` hit, unrelated). No new
route/action surface — the diff is domain-layer only; the action layer
(`app/actions/invoices.ts`, `lib/validation/invoices.ts`) was untouched and
its Zod schema already types `matchedProductId` as
`z.number().int().positive().nullable().optional()`.

See [[project_phase2.5_slice2_review_screen_audit_2026-08-15]] for the prior
slice's equivalent clean AR-2 verification (same file, different endpoint) —
this is the second time this exact check has come back clean, which is worth
noting as a pattern of good practice on this project, not just a one-off.
