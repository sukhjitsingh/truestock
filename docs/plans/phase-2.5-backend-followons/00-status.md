# Status: Phase 2.5 backend follow-ons

- Gate 1 — Product: APPROVED 2026-08-23 (revised + re-approved after
  backtrack, see note below)
- Gate 2 — Architecture: APPROVED 2026-08-23 (revised + re-approved after
  backtrack, see note below)
- Gate 3 — Program Design: APPROVED 2026-08-23
- Gate 4 — Slice plan: APPROVED 2026-08-23

**Backtrack note (2026-08-23):** starting Gate 3 research for Part A
surfaced that pdf-inspector cannot produce a page-scoped PDF/image for
Claude Vision — only page-scoped markdown. Gate 1's Announcement and Gate
2's Flow both originally claimed true per-page Vision billing ("only pay for
reading the one bad page"), which isn't achievable without a second library
(pdf-lib, not built this round — user's explicit decision). Both docs
corrected to describe the real, still-genuine win: skip Vision entirely on
invoices where zero pages need it; an invoice with any bad page still costs
the same as today. See `appendix-a-selective-ocr-audit.md`'s "Point 3 ...
corrected" section for the full research trail. Part B is unaffected by
this — its Gate 1/2 content stands as originally approved.

## Slices

Full detail in `04-slices.md`. Build order: A1 → A2 → A3 → B1 → B2.

- [x] Slice A1 — tracer bullet: `processPdfWithOcr` wrapper + DI field, skip-Vision path wired (DONE 2026-08-23)
- [x] Slice A2 — still-calls-Vision path wired + existing tests updated (DONE 2026-08-23, landed with A1 — see `04-slices.md`)
- [x] Slice A3 — parse-failure-falls-back-to-Vision edge case (DONE 2026-08-23, test-only — see `04-slices.md`)
- [x] Slice B1 — tracer bullet: `cost-history.ts` skeleton, real auth/ownership/empty-result checks (DONE 2026-08-23)
- [x] Slice B2 — real ordering + previousUnitCost chaining across two seeded approvals (DONE 2026-08-23, landed with B1 — see `04-slices.md`; caught and fixed a same-second ordering tie in `product_cost_history.effective_at`)

## Notes for a fresh session

Two backend-only follow-ons to the already-shipped Phase 2.5 extraction
pipeline (Phase 2.5 is IMPLEMENTATION COMPLETE per `ROADMAP.md`). Neither is
new Phase 2.5 scope; both are efficiency/completeness work on top of it.
**No UI in either part, this round.**

**Part A — pdf-inspector selective-OCR adoption.** Route scanned/mixed
invoices through pdf-inspector's `processPdfWithOcr` instead of sending the
whole document to Claude Vision, so only pages that actually need AI vision
pay for it. Technical grounding:
`appendix-a-selective-ocr-audit.md` — key fact: `processPdfWithOcr` has zero
call sites in this codebase today; the Vision call currently sends the
entire PDF buffer regardless of page count needing OCR.

**Part B — invoice cost-history / cost-posting backend.** Add domain-layer
read functions for `product_cost_history` (per-product history, per-invoice
cost postings) — the write path (`approveInvoice`) is already correct and
out of scope to change. Technical grounding:
`appendix-b-cost-history-audit.md` — key fact: the table and its index
already anticipate this exact read (the schema comment names "a future
cost-history screen"), but nothing outside a test helper queries it. Hard
constraint carried forward: invariant 8 (cost data role-gated, staff never
see it) — any new read function must follow `lib/domain/invoices.ts`'s
existing owner-only vs. manager/staff-safe projection split, not a single
ungated query.

**Directory renamed 2026-08-23** from `pdf-inspector-selective-ocr` to
`phase-2.5-backend-followons` when Part B was added — Gate 1 had not yet been
approved, so no gate history is lost by the rename.
