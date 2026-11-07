# Status: Phase 2.5 — OCR invoice automation

- Gate 1 — Product: **APPROVED 2026-08-14**
- Gate 2 — Architecture: **CORRECTED 2026-08-14 · RE-APPROVED 2026-08-15**
- Gate 3 — Program Design: **CORRECTED 2026-08-14 · RE-APPROVED 2026-08-15**
- Gate 4 — Slice plan: **CORRECTED 2026-08-14 · RE-APPROVED 2026-08-15**
- Implementation: **COMPLETE 2026-08-21 · Slices A–E merged into `feat/phase-2.5-invoice-automation`**
- Deferred by design: **Phase F auto-approval, until about 100 real invoices provide correction data**

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

### Second pass, 2026-08-14 — twelve more gaps, same shape

Re-auditing each finding against the *rule* it implied (rather than the instance it named)
found four more AR-2 gaps and eight across AR-4 → AR-7. Full detail in the review doc; the
two that matter most:

- **The `invoice` status had no declared state machine** — six enum values, no transitions,
  in any gate doc. AR-6 forced that discipline onto `extraction_job` and stopped there.
  `approved` is now terminal, every write is a compare-and-set, and Slice 2's Return
  button no longer writes `status → uploaded`, an edge that does not exist.
- **`vendor_alias` had no tenant foreign key at all** — and it is the one table whose bad
  rows persist and re-apply to every future invoice from that vendor.

Both passes are documentation-only; no implementation code exists yet.

**Before re-approval:** regenerate the migration through drizzle-kit against the corrected
schema, and confirm the adversarial tests in Gate 3's test plan fail against the
uncorrected behaviour first. The Gate 3 adversarial table now holds **32** tests (19 from
the first pass, 3 from the AR-2 audit, 10 from the AR-4→AR-7 audit).

## Slices
(Full breakdown in `04-slices.md`; this list tracks build status only.)
- [x] Slice 1 — Upload + Archive (Phase A). PR #16, merged 2026-08-15.
- [x] Slice 2 — Extraction + Review (Phase B). Backend (PR #17, merged
      2026-08-15) plus the review screen
      (`app/(office)/office/invoices/[invoiceId]/page.tsx`,
      `components/office/invoice-review-form.tsx`), built and verified
      2026-08-15. All 32 backend tests pass (isolated run, clean); code-reviewer
      and security-reviewer both returned clean verdicts (zero critical/high).
      Two Low findings from review were fixed same-day: an empty-lines-row
      `colSpan` mismatch, and a matched-but-later-deactivated (or
      outside-the-100-cap) product rendering "not entered" instead of its name
      — fixed with a new `getProductsByIds` domain function + action that
      merges any matched product id missing from the capped/active search
      result (`lib/domain/catalog.ts`, `app/actions/catalog.ts`,
      `app/(office)/office/invoices/[invoiceId]/page.tsx`). A third finding
      (no correction path for a NULL header field blocking Approve) is
      genuinely out of Slice 2's spec scope — deferred as
      `docs/open-items.md` item #32, triggered on the first real invoice that
      hits it. Verified in a real browser (not just `tsc`/tests) against an
      isolated Docker stack: sign-in, review-queue render with exception
      badges (unmatched item), edit + Approve → `needs_review → reviewed`
      with lines locked read-only, and the Return-for-re-extraction form.
- [x] Slice 3 — Matching (Phase C). PR #20 merged into
      `feat/phase-2.5-invoice-automation` on 2026-08-16. `lib/domain/matching.ts`
      (`findAlias`, `upsertAlias`/`upsertAliasTx`, `matchLinesToProducts`) plus
      `vendor_alias` (composite tenant FK, `UNIQUE(organization_id, vendor_id,
      vendor_item_code)`) and `invoiceLine.matchedVendorAliasId`. Wired into both
      `extraction-pipeline.ts` (auto-match after parse, before the "unmatched item"
      badge is decided) and `invoice-lines.ts`'s `applyLineReviewTx` (a manual match
      on the review screen teaches the alias table). 48/48 backend tests pass
      against real MariaDB, including two real `Promise.all` concurrency races
      (3-way `upsertAlias`, 3-way `submitInvoiceReview`) that found and fixed a
      deadlock (1213) and a `SELECT ... FOR UPDATE` snapshot race (1020,
      `ER_CHECKREAD`) — both now retried whole-transaction via `withLockRetry`.
      `code-reviewer` and `security-reviewer` both clean (zero critical/high); the
      AR-2 tenant-crossing pattern this exact code was warned about is confirmed
      closed. One integration-test gap deferred as `docs/open-items.md` #33
      (`matchLinesToProducts` proven in isolation, not yet through the real
      `runClaimedJob`/`processExtractionQueue` cron path — blocked on an
      environment-wide native-binding issue, not a known-wrong behavior). Verified
      in a real, isolated-Docker browser run via `scripts/verify-browser.mjs`
      (twice, for idempotency): an unmatched line shows its badge and an empty
      product picker, manually matching through the real Approve button creates a
      real `vendor_alias` row, and a second invoice with the same vendor+item code
      arrives pre-matched with no badge.
- [x] Slice 4 — Cost Flow + Alerts (Phase D). Branch `feat/phase-2.5-slice-4`,
      stacked on `feat/phase-2.5-slice-3`'s tip as planned. Built via the
      `Workflow` tool (database → backend → frontend → code-reviewer +
      security-reviewer in parallel → verify), 2026-08-19. New
      `product_cost_history` table (`lib/domain/cost-derivation.ts`'s
      `deriveUnitCost`, composite tenant FKs to `product`/`invoice`/
      `invoice_line`, `UNIQUE(source_invoice_line_id)` — deliberately global,
      not tenant-scoped, mirroring `count_line_write.client_line_id` — a
      backstop, not the primary idempotency mechanism), migration
      `drizzle/0007_yielding_gideon.sql`. `approveInvoiceAction`
      (`lib/domain/invoice-approval.ts`, owner-only) runs the whole
      `reviewed → approved` transition inside one `db.transaction` wrapped in
      `withLockRetry`: CAS on `reviewed → approved` as the concurrency gate
      (zero rows affected on replay returns success, not an error — the
      primary idempotency mechanism), a per-line `SELECT ... FOR UPDATE` on
      the previous cost, a `product_cost_history` insert, and a tenant-scoped
      `product.current_unit_cost` update. `lib/invoice-line-alerts.ts`'s
      `computeLineAlerts` adds two live-computed, non-persisted alert badges
      ("discount > 50%", "negative net") — deliberately separate from the
      DB-persisted `KNOWN_EXCEPTION_FLAGS` system, not an extension of it.
      `components/office/invoice-review-form.tsx` gained a distinct
      "Approve & post costs" button (`canApproveCosts = status ===
      "reviewed"`), separate from Slice 2's own Approve button, since the two
      trigger different transitions on different preconditions. All nine
      named adversarial tests plus acceptance-criteria/happy-path/role-gate
      coverage landed in `tests/invoice-approval-path.test.ts`
      (`review_rejects_cross_tenant_product`,
      `invoice_line_fk_refuses_cross_tenant`,
      `approve_is_idempotent_on_replay`, `approve_concurrent_applies_once`,
      `approve_rolls_back_on_midway_failure`, `schema_matches_live_columns`,
      `approved_invoice_cannot_be_rejected`, `previous_unit_cost_chains`,
      `no_reference_to_unit_cost_column`) plus 11 cases in
      `tests/invoice-line-alerts.test.ts`. **391/391 backend tests pass
      against real MariaDB** (independently re-run, not just the subagents'
      self-report); `tsc --noEmit` and `eslint` both clean (the sole lint
      warning is pre-existing, in `catalog-table.tsx`, unrelated to this
      slice). `code-reviewer` and `security-reviewer` both returned zero
      critical/high findings. Verified in a real, isolated-Docker browser run
      (`scripts/verify-browser-slice4.mjs`, signed in as
      `verify-owner@truestock.local`) — 13/13 checks: "Approve & post costs"
      renders only on a `reviewed` invoice and not on `needs_review`; the
      "discount > 50%" badge renders live from in-progress form state before
      any submit, and from a persisted reviewed line; clicking Approve moves
      the invoice to `approved` (terminal, no action buttons remain);
      `product.current_unit_cost` and one `product_cost_history` row both
      land correctly, checked via direct `mysql2` ground-truth queries against
      the database, not the page's own claim; the catalog edit screen shows
      the updated cost. New reusable pattern this slice:
      `docker-compose.worktree-test.yml` — a complete, independent (not
      merged/overridden) Compose file for isolated per-worktree verification,
      preventing the collisions with other concurrently-running worktrees'
      Docker stacks that hit Slices 1 and 3.
- [x] Slice 5 — Audit Packet (Phase E). PR #26 merged into the prerequisite
      branch on 2026-08-21; PR #25 then merged the complete stack into
      `feat/phase-2.5-invoice-automation`. Schema landed
      first as `7ccb58b` (`audit_packet` table, migration renumbered 0009).
      `lib/domain/audit-packets.ts`: `createAuditPacket` (insert, status
      `building`), `buildAuditPacketJob` (background build — collects
      matched invoices + closed counts for the date range, streams them plus
      a `manifest.json` with per-file and whole-archive SHA-256 into a ZIP
      via `archiver`, marks `ready`), `getAuditPacket`/`loadFreshAuditPacket`
      (lazily CAS's a lapsed `ready` row to `expired` — `WHERE status =
      'ready'`, so concurrent racers are harmless — enforced at *every* read
      path, not just a client-side countdown). AR-3 (org-scoping the audit
      packet's candidate rows) verified real: candidates carry the source
      row's own `organizationId`, never a hardcoded expected value, so the
      single-distinct-org assertion before marking `ready` is load-bearing.
      A medium security-review finding — no per-organization concurrency
      guard, so a second browser tab or a stale button click could run two
      concurrent builds against this app's shared 5-10 connection pool
      (AGENTS.md) — was fixed same-day: `createAuditPacket` now does a
      SELECT-then-INSERT check and refuses a second `building`-status packet
      per org with a new `ConflictError`, documented in its own header
      comment as narrowing rather than eliminating the race. Two remaining
      low findings from the same review (unbounded per-request memory
      buffering; no stale-job reclaim if the process dies mid-build) recorded
      as `docs/open-items.md` #39 rather than fixed, with triggers for when
      each becomes due. `app/api/audit-packets/[id]/route.ts` (authenticated
      download, reuses `lib/storage/invoice-files.ts`'s `resolveStoredPath`
      — the same AR-1 traversal guard prior slices use — and collapses
      cross-tenant vs. unknown-id to an identical 404, no oracle) plus
      `app/actions/invoices.ts`'s `createAuditPacketAction`/
      `getAuditPacketAction`, `lib/email.ts` (packet-ready notification,
      no-ops when `EMAIL_PROVIDER` is unset), `components/office/audit-packet.tsx`
      + `app/(office)/office/invoices/audit-packet/page.tsx` (date-range
      form, live building/ready/expired poll, download link; owner-only link
      added to the invoices list page). `tests/audit-packet.test.ts`: 32
      tests, including 3 proving the concurrency guard (blocks a second
      concurrent same-org build, allows a new build once the prior one
      leaves `building`, never leaks across organizations). `tsc --noEmit`
      and `eslint` both clean (sole warning pre-existing, unrelated); full
      suite 419/420 (the 1 failure is the pre-existing environment-only
      darwin-x64 `pdf-inspector` gap in an unrelated file); build succeeds
      with both new routes present. `code-reviewer` and `security-reviewer`
      both ran; the security-reviewer's medium finding is the concurrency
      guard fixed above, the two lows are #39. Verified in a real,
      isolated-Docker browser run (`docker-compose.worktree-test.yml -p
      truestock-slice5-test`, never the shared dev containers): login →
      invoices page → audit packet page → date-range submit → live
      PROCESSING → READY poll transition → download link rendered.
      Independently confirmed the produced ZIP against the DB row outside
      the browser entirely: correct 3-member file list (`invoices/1.pdf`,
      `counts/1.json`, `manifest.json`), correct `manifest.json` content,
      and the DB-recorded `file_sha256` matches `sha256sum` of the actual
      file on disk byte-for-byte.
- Slice 6 — not built by design (auto-approve deferred, see `04-slices.md`)

**Integration result, 2026-08-21.** Both final stacked PRs are merged and the
integration branch is clean. Its Linux CI ran **449 tests across 31 files: 449
pass, 0 fail, 1,278 `expect()` calls**, followed by a successful production
build. Slice 5 also ran through a real browser against an isolated MariaDB
stack, and the downloaded ZIP's members, manifest and SHA-256 were checked
independently against the database and file on disk. Phase 2.5 is therefore
implementation-complete. The Gate 1 operating metric — 20–25 real invoices
reviewed in under 30 minutes — remains a Phase 2.9 field measurement, not an
implementation claim.

**Gate 2–4 were reconciled and re-approved 2026-08-15, by the project
owner's explicit call, before Slice 3 started.** The 2026-08-14 withdrawal and
its reasons remain below as history; the current status header and slice-plan
banner state the resolved result so a fresh reader does not mistake history for
an active process block. The re-approval basis: Slices 1 and 2 were built and
merged **against the corrected contract**
(every AR-1 through AR-7 fix plus the twelve second-pass findings — storage
outside the web root, ownership-checked cross-tenant ids, the CAS-guarded
state machines, owner-only cost visibility, atomic job claiming), and shipped
clean — `code-reviewer` and `security-reviewer` both returned zero
critical/high findings on Slice 2, and the 32 backend adversarial tests all
pass against real MariaDB. That is direct evidence the corrected contract
holds under implementation and review, not just on paper, and is a stronger
basis for re-approval than a signature would have been. Slices 3–5 then
completed on that contract.

## Notes for a fresh session

For current work, start with `STATE.md`, `ROADMAP.md`, and the integration result
above; implementation is complete and this section preserves its design context.
Before changing the extraction pipeline, read `docs/invoice-automation-research.md`
in full (Parts 1–5). The binding decision remains: **xtraCHEF is out; build
replaces it.** The §2.8 checks are acceptance criteria for the product and the
unmeasured operating checks move to Phase 2.9; they are not vendor evaluation.

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
