# Status: Phase 2.5 — OCR invoice automation

- Gate 1 — Product: APPROVED 2026-08-14
- Gate 2 — Architecture: **CORRECTED 2026-08-14 — approval withdrawn, awaiting re-approval**
- Gate 3 — Program Design: **CORRECTED 2026-08-14 — approval withdrawn, awaiting re-approval**
- Gate 4 — Slice plan: **CORRECTED 2026-08-14 — approval withdrawn, awaiting re-approval**

## Adversarial review, 2026-08-14 — why Gates 2–4 were re-opened

A Codex adversarial review of the branch found **3 critical + 4 high** defects, all in the
Gate 2–4 contract. Full writeup: `docs/reviews/2026-08-14-phase-2.5-adversarial-review.md`.
**No implementation code existed yet**, so nothing shipped was broken and all seven were
free to fix. Static checks (`tsc`, `eslint`, tests) were green throughout — which is the
point: they cannot see a defect in a design that has no code yet.

| # | Finding | Closed by |
|---|---------|-----------|
| AR-1 | *critical* — invoice originals stored in `public/invoices/`, i.e. served unauthenticated by Next | Storage moved outside the web root (`INVOICE_STORAGE_DIR`); sole read path is an owner-only, ownership-checked, traversal-guarded route handler |
| AR-2 | *critical* — client-supplied `matched_product_id` could cross tenants and overwrite another org's cost | `organization_id` + composite `(organization_id, parent_id)` FKs on every child table; `Actor` threaded through every domain call; every nested id ownership-checked |
| AR-3 | *critical* — audit-packet ZIP selected invoices by date range with no org predicate | Org id read from the packet row and carried through every invoice/count/file query; single-distinct-org assertion on the manifest |
| AR-4 | *high* — approval could partially apply or replay cost writes | One transaction; compare-and-set on `reviewed → approved` as the concurrency gate; `UNIQUE(source_invoice_line_id)` on cost history |
| AR-5 | *high* — plan referenced `product.unit_cost`, `unit_cost_updated_at`, table `cost_history` (none exist) and listed `vendor` as new (it exists) | Reconciled against live `db/schema.ts`: `current_unit_cost`, new `product_cost_history` table designed properly, `vendor` reused |
| AR-6 | *high* — three incompatible job-state vocabularies; job claimable before its file was uploaded | One machine `awaiting_upload → queued → running → done\|failed`; queued only after size + SHA-256 verification; atomic claim |
| AR-7 | *high* — "manager = review, no cost" is unsatisfiable; the review screen is entirely cost data | Review and approval are owner-only (matching `canSeeCost()`); managers get upload + a separately-queried redacted list with no monetary column |

**Before re-approval:** regenerate the migration through drizzle-kit against the corrected
schema, and confirm the adversarial tests in Gate 3's test plan fail against the
uncorrected behaviour first.

## Slices
- [ ] Slice 1 — tracer bullet: the Hostinger native-binary spike (`@firecrawl/pdf-inspector` loads under `output: 'standalone'`)
- [ ] Slice 2 — (filled at Gate 4)

## Notes for a fresh session
Read `docs/invoice-automation-research.md` in full (Parts 1–5) before anything else —
it is the build spec this plan turns into slices. The decision note at the top is
binding: **xtraCHEF is out; build replaces it.** The §2.8 checks are acceptance
criteria for our build, not vendor evaluation.

**Research findings that changed the build shape (Part 5, 2026-08-13):**

1. **Scan-primary intake.** The big-three distributor portals (SGWS, Breakthru, RNDC)
   download *scans of signed paper*, not generated PDFs; the real-world artifact is the
   photographed paper receipt. Text-based PDFs exist (email-forwarded invoices, some
   regional portals like Bernick's) but are the minority, not the default. The PRD is
   written scan-primary: Claude vision is the assumed primary OCR path, pdf-inspector's
   free text path is a bonus fast-path, and **the review queue is the throughput
   governor** — the review UI is the biggest work chunk, deliberately.
2. **Hostinger spike is de-risked.** Runtime is LiteSpeed `lsnode` on CloudLinux 8
   (glibc 2.28), Node 18/20/22/24 selectable; native binaries proven there (Prisma
   engines). The real risk is `output: 'standalone'` file tracing dropping the `.node`
   file (known `nft` bugs). Mitigations: `serverExternalPackages` +
   `outputFileTracingIncludes`. Escape hatch: KVM VPS ~$4–8/mo. **Slice 1 is the spike.**
3. **§2.8 check 14 (text-vs-scanned split) is a first-week-of-build measurement, not a
   pre-gate blocker** — the owner logs into distributor portals during slice work, not
   before planning.

**Sequencing facts:** this phase lands before production (Phase 3). Invoices captured
during it live in local object storage against a local database — decide "migrate at
Phase 3" vs "throwaway pilot" on the way in, not on deploy day (ROADMAP Phase 2.5).
Build `retention_until` here, not in Phase 6. This phase reverses the "no AI / no file
storage" MVP exclusions — AGENTS.md's rule stops applying at this line.

**Phasing inside the phase** (from research §3.8): A = Archive (no AI, ships first
regardless), B = Extraction + review, C = Matching, D = Cost flow + alerts, E = Audit
packet, F = Auto-approve (never before ~100 invoices of correction data). The PRD
(Gate 1) covers A–E as the feature; F stays deferred.
