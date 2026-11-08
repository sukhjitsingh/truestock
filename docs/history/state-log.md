# Truestock — history log

Every dated entry that used to sit under "Recent history" in `STATE.md`, moved
here verbatim on 2026-11-08 so `STATE.md` stays the short answer to *what is
proven, what is merely built, and what is next* (see `docs/sdlc-playbook-map.md`,
Tier 1.1).

**Add new entries at the top**, one bullet each, newest first, in the same form:
`- **YYYY-MM-DD** — **what happened.** why it matters, with commit SHAs.`
When a feature ships, its one-line entry goes here (AGENTS.md, "Planning workflow").

---

- **2026-11-08** — **SDLC Tier 1 done, on one branch.** Evaluated the project against
  Anthropic's AI-native SDLC playbook (`docs/sdlc-playbook-map.md`) and landed its six
  "before Phase 2.9" items: known defect #1 fixed (a retired product can no longer be
  counted, `530d632`); `.claude/settings.json` with an allowlist and edit guards that
  block edits to applied migrations and a CSP in `next.config.ts` (`b42f77d`,
  `0ab2ab5`); a CI job that serves the production build and runs the Playwright smoke
  spec (`9804782`, mutation-checked locally, not yet run on GitHub); Bun pinned to
  1.4.0 everywhere (`ede08dd`); this log split out of `STATE.md` (`ab6ca01`); and
  `AGENTS.md` cut to the rules with the reasons in `docs/lessons.md` (`af00f6e`).
- **2026-11-07** — **Phase 2.9 evaluated against the evidence.** None of the
  eleven items is done, five are partial, and six have not started. ROADMAP.md
  Phase 2.9 was rewritten to match (`81d47ea`). There are six locations, not five.
  The queue gaps are replaced by the #46 phone checks. The Phase 2.5 field metric
  and the Vision key are added as go-live blockers. So are the pre-count findings
  from the 2026-10-25 recording.
- **2026-11-07** — **Pushed and opened for merge.** The QA fixes and the merged
  count-queue fix are on `origin/feat/phase-2.5-invoice-automation`. PR #37 into
  `main` is open and has no conflicts. The repo is public, so real supplier
  invoice values in two docs, the open-items list and two agent-memory notes
  were replaced with `[redacted]` (`93d5c28`). Earlier commits still hold them,
  because history was deliberately not rewritten. `.claude/agent-memory/` stays
  tracked: it was briefly untracked, then restored unchanged (`a954d17`).
- **2026-11-07** — **Invoice QA failures fixed (docs/plans/invoice-qa-fixes, all four
  gates approved by the owner).** F1, F4, F5, F6, F7, F8, F9, F10 and three minor
  items, plus reading the item code, case pack and size from the Item Name column.
  1384 tests pass, Playwright 65 of 65 with none skipped, reviews found nothing
  blocking. Vision is still unverified; the rest is in open-item #47.
- **2026-11-06** — **Merge QA, count queue fixed, invoice failures handed off.**
  A real-phone and real-invoice QA of the Phase 2.5 + `main` merge found ten
  failures that every automated suite passed. Two were in the count queue (a
  correction overtaken by a queued write; no retry on mobile data) and are fixed
  on `fix/count-queue-order-and-retry`, proven by mutation-checked e2e tests but
  not yet on the phone (open-item #46). Eight are invoice failures, including
  approval posting no costs, handed to the invoice branch (open-item #47,
  `docs/qa/2026-11-06-invoice-failures-handoff.md`).
- **2026-11-06** — **Glued words fixed (open-item #44).** Next's SWC drops
  the leading space of a multi-line JSX text run that contains an HTML entity;
  `/office/reorder` read "closedcount, and there isn't one". Fixed, browser
  verified, and guarded by `tests/jsx-entity-spacing.test.ts` (270 tests).
- **2026-11-05** — **Barcode integrity: one barcode, one bottle size**
  (docs/plans/barcode-integrity, all four gates approved by the owner, eight
  slices). The owner reported *"I can assign multiple bottle sizes to the same
  barcode."* Root cause, reproduced: the ZXing reader reports a printed UPC-A as
  its 13-digit EAN-13 form, and the unique index only refused an identical
  string — so a second reading of an enrolled bottle reopened "Which bottle is
  this?" and could be linked to another size; and linking itself was one tap
  with no size shown. What shipped:
  - **Fix 1** — `lib/barcode.ts`: every barcode stored and looked up as the
    14-digit GTIN, the camera's format recorded; 8-digit codes converted only
    when the camera said which kind they are, never guessed.
  - **Fix 2** — picking a product opens a confirmation with the size as the
    largest text; "It's a different size" opens a prefilled form with no size
    chosen.
  - **Fix 4** — a taken barcode is refused as "already belongs to Smirnoff
    750 ml", with a button to count that product instead.
  - **One size spelling everywhere**, back office included: `750 ml`, `1.75 L`,
    `Sixtel keg` (`formatProductSize`).
  - **Found and fixed on the way:** the fallback barcode reader could not load
    under the production CSP (its engine came from a CDN the CSP refuses); the
    scanner now uses the built-in reader only if it can read retail barcodes,
    else the app's own reader, served same-origin. Also: two DB test files that
    passed only by test order (CI's Deploy workflow had been red on every merge
    since PR #11 because of it) now migrate for themselves; and a test that would
    have passed for the wrong reason now asserts the specific error.
  - **Browser-testable scanning:** the harness gives Chromium a fake camera
    playing a generated barcode, so the enroll screens run end to end through
    the real decoder.
  - **Deferred / opened:** Fix 3 (size edits rewrite history, #42); reset local
    Docker data after merging (#43); words glued by dropped JSX spaces, live on
    the reorder page (#44); the built-in-reader branch unverified on a phone
    (#45). (Numbered #31–#34 on `main`; renumbered when merged into the
    Phase 2.5 branch, whose own items already use #31–#41.)
- **2026-10-25** — **PRs #28 (Phase 2.5 backend follow-ons) and #29 (UI/UX
  redesign v2) merged into `feat/phase-2.5-invoice-automation`; a post-merge QA
  pass on the merged tree found and fixed seven defects, none of which a status
  code or a green test run had caught.** The fixes ride in
  `fix/phase-2.5-post-merge-qa` and are listed in `docs/open-items.md` #40: the
  barcode-scanner polyfill never decoded because zxing-wasm's default CDN URL is
  blocked by the CSP's `connect-src 'self'` (the camera opened and nothing was
  ever detected — the wasm is now self-hosted at `/vendor/zxing_reader.wasm`);
  `Button` labels lost their font size to `tailwind-merge` filing `text-label`
  under text colour (`cnSized`); the dark-theme destructive button was white on
  `#f87171`, 2.77:1, now 7.2:1; three controls sat under the 44 px floor; the
  oversize-photo message contradicted itself at 7,500,001 bytes; the SET-mode
  save button broke its label from its figure at 360 px; and a *photographed*
  invoice could be uploaded but not extracted — it went through pdf-inspector
  and to Claude as a PDF `document` block, and HEIC was still advertised though
  Claude cannot read it. Photos now go to Vision as `image` blocks; HEIC and
  photos over 7.5 MB are refused at upload with a message that says why.
  **Proven:** typecheck
  clean, lint 0 errors / 31 warnings, 808/808 unit tests, both guarded browser
  harnesses (66/66 and 72/72) and a targeted re-check of the fixes on the rebuilt
  production bundle at 390×844 and 360×740, with no CSP violations or console
  errors — all in a desktop Chrome with phone viewport, touch emulation and a
  *fake camera feed*. **Not proven:** anything on a real phone — the real camera
  and whether it uses the native `BarcodeDetector` or the polyfill, iOS Safari,
  safe-area insets, landscape, the on-screen keyboard over the fixed action bar —
  and photo extraction against a *live* Vision response (only a stub has run).
  `docs/phone-count-test.md` is the checklist for the part only a phone can
  answer. One concurrency test (`invoice_file_write_once_survives_a_concurrent_put`)
  failed once in a single full-suite run and passed on every rerun; recorded as
  open item #40.17, not understood.

- **2026-08-20** — **Open items #2, #32, #33 closed as Slice 5 prerequisites, then
  Slice 5 (Audit Packet, Phase E) built and verified end to end — Phase 2.5's
  A–E feature set is now fully implemented.** Two PRs, stacked: #25
  (`feat/phase-2.5-open-items-2-32-33` → `feat/phase-2.5-invoice-automation`,
  commit `ed9bf86`) closes the fill-correction audit ledger (#2), adds a
  correction path for a NULL invoice header field blocking Approve (#32, the
  gap Slice 2 deferred), and adds the extraction-to-matching integration test
  through the real `runClaimedJob`/`processExtractionQueue` cron path (#33).
  #26 (`feat/phase-2.5-slice-5-v2` → `feat/phase-2.5-open-items-2-32-33`,
  commit `d2b9d72`, schema pre-landed as `7ccb58b`) is Slice 5 itself: an
  owner-only, on-demand audit packet export — a date range in,
  `invoices/*.pdf` + `counts/*.json` + `manifest.json` (per-file and
  whole-archive SHA-256) out as a ZIP, built by a background job with an
  email notification and a 10-minute download link. A medium security-review
  finding (`buildAuditPacketJob` buffers every matched invoice's bytes in
  memory with no per-organization concurrency guard, against this app's
  shared 5-10 connection pool) was fixed same-day: `createAuditPacket` now
  refuses a second `building`-status packet per org with a new
  `ConflictError`. Two low findings from the same review recorded as
  `docs/open-items.md` #39 rather than fixed. Full detail on both PRs in
  `docs/plans/phase-2.5-invoice-automation/00-status.md`. Verified in a real,
  isolated-Docker browser run (`docker-compose.worktree-test.yml -p
  truestock-slice5-test`): login → audit packet page → date-range submit →
  live PROCESSING → READY poll → download link, with the produced ZIP
  independently confirmed against the DB row — correct file list, correct
  manifest, and the DB-recorded `file_sha256` matching `sha256sum` of the
  actual file on disk byte-for-byte. PR #26 merged into the prerequisite
  branch, then PR #25 merged the complete stack into
  `feat/phase-2.5-invoice-automation` on 2026-08-21; both CI checks are green.
  Phase 2.5's remaining scope is F (auto-approve), deferred by design until
  about 100 invoices of correction data exist (`04-slices.md`).

- **2026-08-19** — **Open-items #34–#38 closed: Southern Glazer's Wine & Spirits
  invoices now parse correctly, and a vendor template documents the mapping for future
  vendors.** Built on `origin/feat/phase-2.5-invoice-automation` (Slice 4 merged) via a
  6-agent Workflow run (implement → review → fix findings → verify), on branch
  `feat/phase-2.5-invoice-template-open-items`. Southern Glazer's real invoice structure
  — a portal "Order History" export — differs from every previously-supported vendor:
  its line-item table is headed `Item Name`/`Quantity`/`Gross Amount`/`Discount Amount`/
  `Net Amount` (no Unit Price, SKU, Brand, or UOM columns at all), its `Quantity` cell is
  a compound string (`"1 Cases"`, `"2 Units"`), and its totals row has a footnote
  concatenated onto the first cell while the Gross/Discount/Net cells stay clean.
  `lib/domain/extraction-pipeline.ts` changed to handle all of it: shared header-pattern
  constants (fixing a drift risk between `parseLinesFromMarkdown` and
  `countMarkdownTableDataRows`) now recognize `Item Name`/`Item` and `Document Date`; a
  new `parseCompoundQuantityCell` splits quantity+UOM only when the plain numeric parse
  fails and never overwrites a real UOM column; totals lookup tries a table-aware path
  before falling back to the existing free-text search; and `parseDateValue` now bounds
  month 1–12/day 1–31 on both date formats, returning `null` instead of silently rolling
  over via `Date.UTC` (#35). The load-bearing change, matching this session's explicit
  "if the data isn't ready properly, we don't have data at all" directive: a new
  `looksLikeUnrecognizedLineItemTable` guard makes a **partially**-recognized line-item
  table throw and refuse to write anything, rather than silently dropping just that
  table's lines the way #37 originally did.

  **Two real review findings surfaced and were fixed before merge, not just noted.** The
  new guard, as first written, false-positived on an ordinary 2-column Subtotal/Tax/Total
  summary table — a layout element common on real invoices — throwing away a document's
  correctly-parsed line items along with it; narrowed to require 3+ columns, with a
  regression test proving a bare Subtotal/Tax/Total table no longer trips it.
  `writeInvoiceFile`'s new EEXIST handling (#38) only covered the case where the stray
  file *is* the target directory; Node throws `ENOTDIR`, not `EEXIST`, when the stray
  file is an ancestor path segment instead (e.g. the storage root itself) — arguably the
  more likely deployment mistake — so that case fell through to a raw error unchanged.
  Both codes now share one clear message. A security-review pass also caught real
  Southern Glazer's invoice numbers (invoice #, account ID, dollar totals, a product SKU)
  reproduced in prose in the new vendor template doc, about to be committed despite the
  same change's own `.gitignore` rule existing specifically to keep that data out of git
  history (#36) — redacted to the same synthetic values already used in the test fixture.

  **Verified against a real MariaDB, not just hand-traced.** The project's Docker
  technique (throwaway `node:22-bookworm-slim` container pointed at the shared
  `truestock-mariadb` container, sidestepping `scripts/docker-up-guard.sh`, which
  correctly refused `docker:up` mid-session because a live LAN dev session was already
  using the stack) ran the full suite: **407 pass, 0 fail, 1131 `expect()` calls across
  30 files** — `tests/extraction-pipeline.test.ts` 29/29 including the new item #34
  DB-backed `mixed`-classification test, `tests/invoice-storage.test.ts` 18/18. Lint and
  `tsc --noEmit` both clean.

  New deliverable: `docs/vendor-templates/southern-glazers.md` — verbatim headers for all
  three tables, the field-mapping table, an explicit "never provides" list, and the
  totals-row data-quality quirk, so the next Southern Glazer's invoice maps automatically
  and the next differently-shaped vendor has a template to follow. Memory:
  `.claude/agent-memory/backend/southern_glazers_template_and_open_items_34_38.md`.

- **2026-08-16** — **A Phase 2.5 extraction-pipeline regression fixed: text PDFs had
  stopped using the free `pdf-inspector` path and were unconditionally requiring
  `ANTHROPIC_API_KEY`/Claude Vision instead.** Repro: upload a text-based PDF invoice,
  job moves `uploaded → processing`, then fails with `ANTHROPIC_API_KEY is not set` —
  wrong on its face, since AGENTS.md §3.2 specifies pdf-inspector's markdown path for
  `text`-classified PDFs specifically so most invoices cost nothing in AI calls.
  `runClaimedJob` (`lib/domain/extraction-pipeline.ts`) had lost its classification
  branch: every `pdfType` fell through to `extractFn`/Claude Vision. Fix (Codex,
  verified and merged this session): restores the split — `text` calls
  `parseLinesFromMarkdown(markdown)` with **no Claude call at all**; `mixed`/`scanned`/
  `image` still route through Vision, with `mixed` additionally fetching markdown as
  cross-check ground truth alongside the Vision call.

  **This session's verification is stronger than what produced the fix.** Codex's own
  debug journal states its DB-backed test and real pdf-inspector run were "unverified
  because this Intel Mac has no pdf-inspector native binding and Docker startup is
  sandbox-blocked." This session has full Docker access, so both gaps closed for real:
  `@firecrawl/pdf-inspector` ships no `darwin-x64` binary (confirmed against its
  `optionalDependencies`), so tests importing `extraction-pipeline.ts` were run inside a
  throwaway `node:22-bookworm-slim` container (source bind-mounted, `node_modules` as an
  anonymous volume, `DATABASE_URL` pointed at the shared `truestock-mariadb` container's
  published port) rather than on the host — the documented workaround in
  `.claude/agent-memory/backend/pdf_inspector_no_darwin_x64_binary.md`. Result: **22/22
  pass in `tests/extraction-pipeline.test.ts`** (51 `expect()` calls), including three
  new DB-backed regression tests proving the fix end to end against a real MariaDB — a
  text job reaches `needs_review`/`done` without ever invoking the Claude dependency, a
  text-parser failure fails the job cleanly into the review queue, and a scanned job
  with no Anthropic key fails specifically in the Vision branch. **Full suite: 358/358
  pass, 985 `expect()` calls, 28 files.** Typecheck and lint both clean (lint: 0 errors,
  1 pre-existing unrelated warning). Code review, security review and a live-browser E2E
  upload also ran clean in an earlier pass this session (no critical/high findings).

  **Five findings deferred rather than fixed now**, added to `docs/open-items.md` as
  items #34–#38: `mixed` classification has no DB-backed regression test of its own
  (#34); `parseDateValue`'s US-date regex has no month/day bounds check, so a garbled
  date can silently roll over into a wrong statutory retention date (#35); the real
  Southern Glazer's invoice PDF used to reproduce this bug is untracked and not
  `.gitignore`d (#36); that same invoice exposed a real parser gap — `parseLinesFromMarkdown`'s
  description-column allowlist doesn't recognize "Item Name," so a real vendor's line-item
  table is silently skipped when another table on the invoice does match (#37), the
  quieter and worse sibling of the "zero recognizable lines" case the pipeline already
  fails safe on; and an environment-only `EEXIST` from `writeInvoiceFile`'s `mkdir` when a
  stray non-directory file occupies `var/invoices/{orgId}`, not reachable from any
  application code path (#38). Item #33 (matching never proven through the real pipeline)
  got a progress note rather than a close: the container technique above now makes it
  writable, but the three new tests prove routing, not `matchedProductId` end to end — the
  gap the item actually names is still open.

- **2026-08-15** — **Phase 2.5 Slice 2's review screen shipped, closing the
  gap the prior entry flagged.** `app/(office)/office/invoices/[invoiceId]/page.tsx`
  and `components/office/invoice-review-form.tsx`: the owner-only [AR-7]
  extracted-line table with exception badges (unmatched item, price jump,
  duplicate, doesn't-add-up), editable gross/discount/net, Approve
  (`needs_review → reviewed`) and Return-for-re-extraction with a required
  reason. code-reviewer and security-reviewer both ran clean (zero
  critical/high). Two Low findings fixed same-day: an empty-lines-row
  `colSpan` count that didn't match the table's real 7 columns, and a
  matched-but-deactivated (or outside-the-100-row-cap) product rendering
  "not entered" instead of its name — the exact "plausible but wrong"
  failure class this project treats as a real defect, not a nitpick. Fixed
  with a new `getProductsByIds(actor, ids)` domain function (`lib/domain/
  catalog.ts`, reusing `selectProducts` with no `active` filter — invariant
  6, matched history still references a deactivated product) and a page-level
  merge of any matched id the capped/active search didn't already return. A
  third finding — no correction path when a NULL header field blocks Approve
  — is genuinely out of Slice 2's spec scope; deferred as `docs/open-items.md`
  item #32. All 32 backend tests re-verified passing in an isolated run (the
  full-suite run showed unrelated timeouts from DB-connection-pool
  contention across two simultaneous Docker stacks, not a regression).
  Verified in a real browser against a throwaway isolated Docker stack
  (`docker-compose.verify.yml`, deleted after use) with a seeded invoice
  carrying one unmatched line, one active-matched line, and one
  matched-then-deactivated line: sign-in, review-screen render, editing a
  match, Approve transitioning the invoice to `reviewed` with lines locked
  read-only and the matched-product names all correct (including the
  deactivated one), and the Return form rendering. `00-status.md`'s Slice 2
  checkbox is now checked.

- **2026-08-15** — **Phase 2.5 Slice 1 shipped in full, Slice 2's backend half
  shipped, both on `feat/phase-2.5-invoice-automation` (not `main` yet).**
  Slice 1 (PR #16): invoice upload handshake (size + SHA-256 verify before
  queueing), the archive list screen, `extraction_job` lifecycle machinery.
  Slice 2 backend (PR #17): the extraction pipeline (Claude Vision +
  pdf-inspector cross-check, arithmetic check, bounded Zod schemas at the
  AI/domain boundary), the stuck-job reap sweep, and `writeExtractedLines`
  (cross-tenant ownership-checked per invariant 9). **Slice 2's review queue
  UI — the slice's own success criterion — is not built.**
  Two defects caught after the fact, both by an autonomous-loop CI check
  rather than by the gates: (1) code-reviewer's pass on `08f685e` found five
  real gaps (unbounded AI-output fields, `max_tokens` vs. no-output
  conflated, a zero-lines-with-failed-check case that would have silently
  stranded a mismatch as a falsely-clean `needs_review` invoice, a
  NULL-`claimed_at` gap in the reaper, and untested pure pipeline functions)
  — all fixed and tested before merge. (2) **PR #16 merged with its own
  `verify` CI check RED**, undetected until a later autonomous-loop tick
  checked PR status after the fact: `tests/user-write-path.test.ts` and
  `tests/rapid-scan.test.ts` never called `migrateTestDatabase()` themselves,
  silently depending on another test file's `beforeAll` having already
  applied migrations earlier in the same `bun test` process — undocumented,
  and it broke; `main` itself had been red on this since 2026-08-14T18:26,
  a full day, before anyone noticed. Fixed in PR #17 alongside the Slice 2
  findings. **Takeaway: a merged PR's CI status is not automatically
  re-checked — worth a `gh pr view --json statusCheckRollup` after any
  merge.**
  Also surfaced, not yet resolved: `docs/plans/phase-2.5-invoice-automation/`
  still reads "Gate 2–4 approval... withdrawn... awaiting re-approval" from
  the 2026-08-14 adversarial review, with no re-approval note added since —
  yet Slices 1 and 2's backend were built and merged after that review. See
  `00-status.md`'s new note; needs the project owner's explicit call.
  `@firecrawl/pdf-inspector` has no `darwin-x64` (Intel Mac) native binary,
  discovered this session — the host-side test workaround can't run
  anything importing `extraction-pipeline.ts`; verified instead in a
  throwaway isolated `node:22-bookworm-slim` container matching
  `docker/app/Dockerfile`. Detail in
  `.claude/agent-memory/backend/pdf_inspector_no_darwin_x64_binary.md`.

- **2026-08-14** — **Phase 2 shipped: the UI redesign, merged as PR #13
  (`9cbf64b`).** Nine implementation commits over two days behind one Gate 1
  approval (`43f2927`), planned as a Gate-1-only variant of
  the 4-gate workflow because the phase touches no schema, no endpoint and no
  business logic — `docs/plans/phase-2-ui-redesign/` carries the reasoning and
  `00-status.md` the criteria-by-criteria close-out. What landed: design tokens
  (safe-area insets, `--spacing-row-office`, `.num`), sixteen new component
  specs in `docs/design-system.md`, the `components/ui` primitives they name
  (null-value, meter, sparkline, stat-tile, stock-cell, empty-state,
  filter-pill, the table set), the mobile counting surface rebuilt to
  `ui-spec-mobile.md`, the back office moved onto a 64 px left icon rail with a
  shared `PageHeader` and the tables migrated to the shared primitives, the
  catalog table migrated to **TanStack Table v8 with per-role `columns` built at
  call time**, two-level category filters, debounced type-ahead search, and
  `prototypes/*.html` regenerated from `app/globals.css` by
  `prototypes/generate-tokens.mjs`.

  **Four defects found by looking at the running app rather than by any gate**,
  which is the pattern this file keeps recording. (1) The rail's collapse toggle
  was pinned to the **bottom-left corner of the viewport**, where Next's
  dev-tools portal intercepts pointer events and Chrome paints its link-hover
  bubble — the button hydrated, `aria-expanded` was right, the cookie write was
  right, and a real click never reached it, so the rail read as permanently
  icon-only. The diagnostic that separates "dead control" from "broken cookie"
  is running the same click three ways: real click, `force: true` (also fails —
  force skips actionability checks, not browser hit-testing), and
  `dispatchEvent` (works). (2) `RAIL_COOKIE` was exported from a `"use client"`
  module, so `cookies().get(RAIL_COOKIE)` in the server layout was looking up a
  client-reference proxy and returning `undefined` on every request — a failure
  indistinguishable from the cookie not being set, since the write succeeds and
  `getAll()` lists it by name. Moved to `lib/ui-cookies.ts`. (3) The catalog
  search field was `method="get"` with **no `name`**, so a pre-hydration Enter
  navigated to a bare `?` and lost the query — the mirror image of the
  `method="post"` rule's failure, silent wrong result instead of a leak. (4) The
  catalog search input carried `focus:outline-none` with no substitute, and
  **the harness had been hiding it**: `assertFocusVisible` resumed tabbing from
  wherever the previous assertion's click left focus, deep in the table, and
  reported "25 tab stops, none bare" having never visited the bare control above
  its starting point. It now re-navigates to reset the tab origin and takes a
  `mustReach` pattern so losing coverage fails loudly. Both focus fixes are
  mutation-checked.

  **The harness also could not test the artifact we deploy, and now can.**
  `waitForHydration` used `page.waitForFunction`, which evaluates a string in the
  page — the production CSP has no `'unsafe-eval'`, so it died with `EvalError`
  in the second and later browser contexts (the first rides on Playwright's
  pre-installed script, which bypasses CSP). The login check at the top passed
  while the role loop three hundred lines down threw, against the same server and
  the same policy. Polling `page.evaluate` from Node is CSP-safe everywhere. The
  harness gained a real `skip()` at the same time, because the skip was first
  written as `record(..., true)` — a green PASS line for a check that never ran,
  which is precisely the failure mode the rest of that file is written against.

  Gate at close: typecheck clean, lint 0 errors (2 known warnings), `next build`
  exit 0, **210 tests / 612 assertions / 0 fail**, browser 44/45 against dev
  (1 dev-only console-error failure, 2 skips) and 44/44 against a production
  build. **No part of the redesigned counting surface has been on a phone.**

- **2026-08-13** — **The catalog page's "hang" was Drizzle in the browser
  bundle, and the back office got the left rail it was specified with.**
  `lib/validation/*` is imported by client components and took its enum
  tuples as *values* from `db/schema.ts`, so every office form pulled
  `drizzle-orm/mysql-core` and all the table definitions into the client
  bundle; Turbopack then spent 125–152 s compiling that on demand while the
  server-rendered HTML sat on screen returning 200 and ignoring every click.
  Extracting the tuples to a dependency-free `db/enums.ts` cut the worst
  chunk to 1238 ms (25 chunks → 17, zero Drizzle). Same failure shape as the
  static-CSP break: renders fine, status 200, completely inert.
  A second theory — that a reference-unstable `data` array drove TanStack's
  `autoResetPageIndex` into a render loop — was **wrong**, and is recorded as
  wrong in `components/office/catalog-table.tsx`: instrumentation showed at
  most three renders, and the un-memoized original completed every
  category-pill click in 151–710 ms. The memoization stayed, measured and
  labelled as the ~20% optimization it actually is (308/638/315/114/350 ms).
  Separately, `app/(office)/layout.tsx` now renders
  `prototypes/office-catalog.html`'s shell — a 64 px icon rail on the left
  (`components/office/office-rail.tsx`, replacing the top `OfficeNav`) plus a
  60 px top bar carrying breadcrumb and account only. Global search,
  notifications and messages are omitted on every screen rather than present
  on one, per `ui-spec-web.md` §2; the rail's expand chevron is wired to a
  real 13 rem labelled state rather than shipped inert, per `ui-audit.md`
  P0.7. **197 integration tests pass**; verified by opening all seven office
  routes plus two detail routes in a browser, not by status code.

- **2026-08-12** — **Phases 1 and 1.5 built through the 4-gate workflow: the
  app now sets itself up.** Seven slices, planned in
  `docs/plans/phase-1-to-1.5/` before any code existed, then built by subagents
  one slice at a time. Locations are manageable from the app (create, rename,
  change count mode, retire — migration `0003` added `location.active`, which
  the ROADMAP had not anticipated); cost and case size are editable in place in
  the catalog table; the dashboard counts in the database instead of off a
  100-row-capped array; a per-vendor order copies to the clipboard or prints;
  and three long-standing script/dev-env gaps are closed. **163 integration
  tests pass and 28 browser checks pass**, the latter automated as
  `bun run verify:browser` against a real Chrome.

  **Two findings are worth more than the features.** The security review caught
  that retiring a location never blocked *writes* into it — Gate 2's Decision 5
  protected the read side, so a retired location vanishes from the picker on a
  fresh fetch, but the scan screen fetches locations once and holds them per leg
  by design, so a counter who had already loaded a location kept a live,
  writable handle on it. `deactivateLocation`'s open-count guard structurally
  cannot see that client: no `count_line` rows exist yet, so retirement
  succeeds and every later scan lands in a retired location with no error
  anywhere. Fixed in `ed5580b`, four tests, one mutation-checked. **Excluding a
  row from a list is not the same as refusing a write to it** — any future
  "deactivate" affordance needs both halves.

  Then browser verification nearly renamed a real location. Editing a location
  was a click on the `<tr>` itself — no Edit button, `tabIndex: -1`, no role,
  and a form headed only "EDIT LOCATION" that never named its subject. Rows
  reflow as the inline form opens, so a click aimed at one row landed on **Speed
  Rail** and prefilled its name; one more click would have renamed the bar's
  speed rail and flipped its count mode, with nothing on screen looking wrong
  afterwards. Caught only by reading the prefilled value before typing.

  **Browser verification became a committed harness**, not a one-off:
  `bun run verify:browser` (`scripts/verify-browser.mjs`) drives the *installed*
  Chrome through Playwright's `channel: "chrome"`, restores every value it
  overwrites, deletes every row it creates, and reports unmet preconditions as
  SKIPPED rather than passing. Two of its checks exist because only a browser can
  make them: a manager's served HTML must contain no `Unit cost for` at all —
  the action tests prove the *payload* omits cost, but only the DOM separates
  "never sent" from "sent and hidden in CSS" — and the positive control (a manager
  *can* still edit case size) returns exactly **16**, which independently confirms
  the beer-only-cases catalog rule.

  **Two more open items were closed the same day**, both found while verifying
  rather than while building: `docker:down` never stopped the TLS proxy (item 25 —
  Compose ignores containers in profiles it was not told about, so item 24's brand
  new guard kept refusing right after the user ran the teardown it recommended),
  and the preflight banner reported "no JavaScript runs" on plain `localhost`
  while the page was demonstrably hydrated (item 26). Item 26's own proposed fix
  was dropped as wrong: having the banner confirm a real `/_next/*` fetch cannot
  work, because in the failure case there is no JavaScript left to do the
  observing. Merged view: PR #11.

  **What is still not measured:** the owner's data entry. 90 unit costs, 16 case
  sizes, par levels, vendors and 5 wine producers are all still absent, and
  Phase 1 cannot close until they exist — the slices made that survivable, they
  did not do it. The reorder screen literally cannot produce a row today because
  no product has a par level; proving copy/print required fixturing one in.

- **2026-08-12** — **The camera, the offline queue and the production CSP all
  ran for real. Counts 3 and 4.** Three of this file's four longest-standing
  unknowns closed in one session, and none of them by reading code.

  **Count 3 — the camera (1m 22s, 1 line).** Barcode `X004YKHTYX` (Code 128)
  decoded on the handset and enrolled as product 100 at 02:59:33; one each
  recorded in Storeroom. The handset has no native `BarcodeDetector`, so **the
  WASM polyfill did that decode** — the "last inch" open since 2026-07-28. The
  size came back as 740 ml, which looked wrong and is not: it is a real preset
  on the beer list (`BEER_SIZES`), and NA resolves to that list.

  **Count 4 — the offline queue (19m 33s, 1 line).** Airplane mode on, a
  quantity submitted: chip read **`1 pending`**. Airplane mode off: chip
  returned to **`Synced`** with no interaction, so the `online` listener fires
  and `flush()` drains. The offline scan showed the new message rather than
  doing nothing. Database after: **one line, one ledger row, and 8 distinct
  `client_line_id`s across all four counts** — the queued write applied exactly
  once, which is the failure this whole design exists to prevent. A second
  barcode, `855553008153` (UPC-A), was decoded under the **production** CSP.

  **The test was unrunnable until the runtime changed, and this is the part to
  remember.** The first attempt died on the browser's offline error page a few
  seconds after airplane mode. Not a Truestock bug: Next 16's HMR client
  reconnects a dead websocket 12 times and then calls
  `window.location.reload()` (`next/dist/client/dev/hot-reloader/app/
  web-socket.js`; its own comment says "it indicates the dev server is no longer
  running"). With no service worker that reload has nothing to load, and the
  app — and the queue's only UI — is gone. **`next dev` cannot test offline
  behaviour at all.** Hence `scripts/prod-lan.sh` + `docker-compose.prod.yml`
  (`bun run docker:up:prod`).

  **Production mode had its own trap, found before it cost anything.**
  `lib/auth.ts` drops its entire `trustedOrigins` block when `NODE_ENV` is
  production — deliberately, so `DEV_LAN_ORIGIN` can never widen a deployed
  server. Switching naively would have made phone sign-in 403 behind the login
  form's generic "check your email and password". Fixed by pointing
  `BETTER_AUTH_URL` at the https LAN origin, which is what a real deploy does
  anyway. One asymmetry to know: **in production mode only the https origin can
  sign in** — verified, http 403 / https 401.

  **The production CSP ran for the first time and is fine.**
  `script-src 'self' 'nonce-…' 'wasm-unsafe-eval'`, `connect-src 'self'`;
  16/16 scripts nonced, React hydrated, console clean. It was the single
  highest-risk item on `docs/go-live.md`.

  **Two things that check turned up are worth more than the pass.** First,
  **go-live.md's own instructions for it were wrong and would have caused a
  false rollback**: they said to confirm `typeof self.__next_r !== 'undefined'`,
  but `self.__next_r` is set only by `next dev` — production had it undefined
  with React fully hydrated. Corrected to check the sign-in button's hydration
  gate, which needs no devtools. Second, **production hydrates later than dev**:
  the first probe read "not hydrated" and three seconds later read hydrated. An
  automated check without a wait would report exactly the failure it is hunting.

  **Seven unguarded server-action calls fixed** (`count-leg.tsx` ×3,
  `enroll-form.tsx` ×3, `catalog-search.tsx` ×1). Each was awaited with no
  try/catch while `runWrite` beside them had always been guarded, so offline the
  fetch threw out of an async handler: no error set, no phase change,
  `busy`/`pending` never cleared. You scanned, the scanner closed, and nothing
  happened. **Two of the seven were writes** in the enroll form that do not go
  through the queue, leaving the form disabled and silent with typed details
  unrecoverable. All now wrapped, flags cleared in `finally`, and the messages
  say "not saved, try again in range" rather than implying a queue that does not
  cover them. Confirmed on the phone in count 4. Typecheck, lint, `next build`
  and 121 tests all green.

  **Not proven by any of this:** rapid mode against a camera; resolving a
  barcode to a product the catalog already has (both scans were enrolments of
  unknown codes — a different branch); the mount-time queue flush; a queue
  holding more than one write; and the standalone server entrypoint, since this
  ran under `next start`.

- **2026-08-12** — **Tenths and valuation both ran for real. Count 2 closed at
  $170.90.** Driven on the phone by the owner; verified in the database rather
  than reported. Opened 02:38:12, closed 02:44:51 — **6m 39s, 4 lines**.

  | Line | Product | Location | Fill | Cost snapshot | Extended |
  |---|---|---|---|---|---|
  | 3 | Tower Station Sixtel | Tap 1 | `[0.6]` | 84.0000 | $50.40 |
  | 4 | Coors Light Half Barrel | Tap 1 | `[0.5]` | 144.0000 | $72.00 |
  | 5 | Modelo Quarter Barrel | Tap 1 | `[0.5]` | 97.0000 | $48.50 |
  | 6 | Jose Cuervo Silver | Speed Rail | `[0.5]` | **NULL** | **excluded** |

  **The stored `total_value` was recomputed independently in SQL and matched to
  the cent (170.90 = 170.90).** So the figure is not merely non-zero, it is
  arithmetically right — which is the claim worth making, since a wrong total
  would look exactly as convincing.

  **Four things ran for the first time in this project's life:** `partial_fills`
  reached the database at all (every prior line was `[]`); valuation left 0.00;
  invariant 2's cost *snapshot* was written onto the line rather than read from
  the product; and **invariant 2's exclusion rule held under a real mixed count**
  — the unpriced tequila has units (0.5) and no value, and $170.90 excludes it
  rather than summing it as $0. That last one is the one most likely to have
  been quietly wrong, because zeroing an unpriced line produces a total that
  still looks plausible. The leg lock also crossed a boundary for the first time
  (three kegs in Tap 1 → *Finish section* → Speed Rail), and the ledger holds
  **6 rows with 6 distinct `client_line_id`s** — no duplicate write.

  **Prep that had to happen first, and would otherwise have blocked this at the
  bar:** there was **no tap-line location**. The entry screen is chosen
  *entirely* by the location's `count_mode` — product `unit_type` does not enter
  into it — so a keg counted anywhere but a `tenths` location gets a quantity
  stepper and no fill pad. AGENTS.md has always said tap lines are modelled as
  Locations, but the seed shipped five locations and none was a tap, and there is
  **no locations screen in the office**, so it could not be fixed from the phone.
  `Tap 1` (sort 6, `tenths`) was added to `docs/catalog/locations.csv` and to the
  live database.

  **What this does NOT prove, and two of these are worth being blunt about.**
  *The camera was not exercised at all* — barcodes stayed at 2 and products at
  99, so all four lines came from the search picker, including the tequila that
  could have been scanned. *The offline queue shows no evidence of having run* —
  all four writes applied immediately. And the per-write gaps were 29s, 102s,
  101s, where the 29s and the first 102s were both keg-to-keg **within Tap 1** —
  same screen, no leg switch, 3.5× spread. That is either ordinary human variance
  (reading a keg level is genuinely hard) or friction worth finding; one data
  point each way settles nothing.

  **A modelling note, not a defect:** three kegs sit on one `Tap 1`, which
  `UNIQUE (count_id, product_id, location_id)` permits but which cannot express
  which keg is on which line. Harmless until the same beer runs on two taps.

- **2026-08-11** — **This file reconciled against the live database, and the
  LAN stack brought up and verified.** Two kinds of drift were found, and the
  second is the one worth remembering.

  *Ordinary drift:* the counts in "Picking this up cold" were a volume behind —
  1 user not 4, 99 products not 98, 2 barcodes not 1, and no open count.

  *The one that matters:* **this file's headline evidence described a session
  whose data no longer exists.** The 2026-07-31 paragraph named product 99 as
  `Smirnoff` created at 19:01:30 with a 4-row ledger. The live database has
  `Smirnoff` as product **98** created **2026-08-08 05:06:25**, a 2-row ledger,
  and a *second* enrolment (`Grey Goose`, product 99) that had never been
  written down at all. The volume was reset between the two, so the original
  evidence is unrecoverable — and a later, better pass went unrecorded while
  this file kept citing the earlier one. **Evidence quoted from a database
  outlives the database.** Re-query before trusting a number in here; that is
  the whole reason this section prints values rather than adjectives.

  Also corrected: the beer-only-cases rule is dated 2026-07-30, not 2026-07-31.
  Unpriced products restated as 90 of 99. Test count re-run rather than
  inherited — 121 pass, 427 assertions.

  **LAN stack verified with negative controls**, because "Running" is not
  "Recreated" and open item #24 is exactly that trap: `DEV_LAN_ORIGIN` is
  correctly set in the app container; a client chunk returns **200** for the LAN
  origin and **403** for a foreign one; `POST /api/auth/sign-in/email` returns
  **401** for bad credentials from the LAN origin and **403** from a foreign
  one; `/count/preflight` redirects to `/login` unauthenticated. And because a
  200 has never been evidence in this project, the login page was opened in a
  real browser: React fiber attached, `__next_f` present, submit button enabled
  (so the hydration gate flipped), `method="post"` on the form, console clean of
  app errors. The TLS certificate interstitial could not be clicked through
  programmatically — Chrome's SSL warning is a privileged page no extension can
  script — which is a per-device manual step and is step one of the phone
  protocol anyway.

- **2026-08-03** — **User management screen built, closing open-item #3.**
  `lib/domain/users.ts` provides `listUsers`, `setUserActive`, `setUserRole` with
  three lockout guards: self-deactivation blocked, self-demotion blocked,
  last-active-owner cannot be deactivated or demoted. `setUserActive` deletes the
  target user's `session` rows in the same transaction, so a deactivated account
  is refused on its very next server request with no live session remaining.
  `app/actions/users.ts` wraps all three as owner-only server actions.
  `/office/users` renders the list; the Users nav link is exposed for the owner role.

  The page had four bugs introduced by commit 97d019c and fixed in the same
  session before the image shipped:
  1. `users-list.tsx` imported `@/components/ui/table`, `@/components/ui/select`,
     `@/components/ui/switch` (none of which exist in this project) and `sonner`
     (not installed) — replaced with native `<table>`, `<select>`,
     `<input type="checkbox">` + Tailwind.
  2. `loadUsers()` referenced `result` without declaring it — missing
     `const result = await actionListUsers()`.
  3. Both new test files imported from `"vitest"` instead of `"bun:test"`,
     making `npx tsc --noEmit` fail and bun's test runner complain.

  TypeScript now reports zero errors. Docker rebuilt cleanly with the fixed
  image; migrations applied; app serving and routing correctly.

  **Status of the `/office/users` page: built, typechecked, domain layer DB-tested.
  The page itself has not been driven in a browser** — add to the phone-count
  session checklist alongside the other back-office screens.

- **2026-08-01** — **Full mobile UI pass applied.** A design audit of every
  screen identified and fixed the following gaps, all of which are now built
  but unproven on a real phone:
  - **Fill entry** (`components/count/fill-entry.tsx`): Empty/Half/Full
    shortcuts enlarged to `h-20` (80 px) with a % sub-label. Tenths buttons
    raised to `min-h-[56px]` (tap-primary floor). Correction-mode delta is
    now colour-coded green/red so the sign is readable at a glance.
  - **Quantity entry stepper** (`components/count/quantity-entry.tsx`):
    `−`/`+` buttons enlarged from `size-11 → size-14` (44→56 px), font
    raised to `text-numeral-md`, `active:bg-muted` feedback added.
  - **Scan button** (`components/count/count-leg.tsx`): enlarged from
    `size-11 → size-tap-primary` (44→56 px).
  - **Fixed action bar** (`count-leg.tsx`): now applies
    `max(16px, env(safe-area-inset-bottom))` so it clears the iOS home
    indicator without hardcoding a pixel offset.
  - **Barcode scanner** (`components/count/barcode-scanner.tsx`): close and
    torch buttons enlarged to `size-tap-primary`; header respects
    `safe-area-inset-top` for the notch/Dynamic Island.
  - **Count-line-card** (`components/count/count-line-card.tsx`): added
    `min-h-tap-min` so every product row meets the 44 px touch floor.
  - **Search result rows** (count-leg and enroll-form): raised to
    `min-h-tap-primary` with `active:bg-muted` feedback.
  - **Count layout root** (`app/(count)/layout.tsx`): `touch-manipulation`
    added — eliminates the 300 ms tap delay without disabling pinch-zoom.
  - **Office nav** (`components/office/office-nav.tsx`): `overflow-x-auto +
    shrink-0 + whitespace-nowrap` — all 5 nav links reachable by horizontal
    scroll on a 375 px phone.
  - **Office layout** (`app/(office)/layout.tsx`): `px-4 sm:px-6` (was
    `px-6`), main `py-6 sm:py-8` — comfortable on narrow phones.
  None of these changes touch logic, tests, or the data model. Typecheck and
  `next build` are green. **None has been exercised on a real phone yet** —
  that is the next step.

- **2026-07-31** — **The owner could not sign in on his phone over the LAN
  https URL — the login page just refreshed on submit.** `DEV_LAN_ORIGIN` was
  empty in the app container, so `next.config.ts`'s `devOrigins` resolved to
  `["127.0.0.1"]` only; Next 16 blocks `/_next/*` for any host outside that
  allowlist, so every client chunk 403'd for the phone's origin while the
  document itself returned a clean 200. No chunks, no hydration, no
  `onSubmit` attached — the browser fell back to a native form POST, which
  presents as "the page refreshes." Caused by bringing the app up with plain
  `bun run docker:up` instead of `bun run docker:up:lan`: the former is the
  documented way back to loopback-only, but an *incidental* `docker:up` —
  from `docker:reset`, a script, an agent told to "try `docker:up` once if
  the database is down" — silently reverts a live LAN session, and the
  container comes back up looking perfectly healthy. Fixed by re-running
  `bun run docker:up:lan`. Verified with negative controls, not just a retry:
  the same client chunk returns 200 for `Origin: https://192.168.12.33:3443`
  and 403 for a foreign origin, and `POST /api/auth/sign-in/email` returns
  200 with a session token from the LAN origin and 403 from a foreign one.
  **This is the fifth failure in this project that hid behind a 200** — after
  the static CSP (#13), the dev cross-origin 403 on `127.0.0.1` (#17), the
  wrapped driver error (#18), and the seed that had been dead on every run
  (closing #19, 2026-07-31). `curl https://192.168.12.33:3443/login` returned
  200 the entire time it was broken. Detected, not prevented: a new preflight
  row (`components/count/preflight-origin-check.tsx`) reads the `Host`
  header and fails loudly, naming the fix, ahead of every other check; a
  hydration beacon was added alongside it
  (`components/count/preflight.tsx`). Neither stops the revert from
  happening — see open item #24 for what would. No schema change, no
  migration, no git commit.
- **2026-07-31** — **Vendors have a write path, closing open item #19 /
  mvp-gaps finding H (the vendor half).** `createVendor`, `updateVendor` and
  `assignVendorToProducts` (three owner/manager server actions), zod schemas,
  an idempotent `seedVendors` keyed on `(organization_id, name)`, and an
  `/office/vendors` screen — list, create, edit, no delete — plus bulk
  set/clear vendor in the catalog table. `listVendorsAction` had always
  returned `[]`; every product's `vendor_id` stayed NULL; `/office/reorder`
  grouped every row under "No vendor set" — invisible while the reorder list
  itself was empty, and visible the moment finding A gave it rows. The
  domain layer is genuinely verified (12 DB-backed tests, mutation-checked:
  disabling the ownership guard fails exactly one test). The screens were
  driven in real Chrome with database verification — four defects found and
  fixed the same week: a stale selection surviving a search (a blocker — it
  wrote to off-screen products), vendors creatable but not editable, the bulk
  bar rendering off-screen below 98 rows, and a clear-vendor label that read
  "Set vendor". The final `router.refresh()` fix in
  `components/office/vendors-list.tsx` was left unverified when that session
  ended, and **was confirmed in a browser later the same day** — create and
  edit both reflect without a reload, and the post-reload state agrees with
  the database.
  **Two defects found by running things rather than reading them**, and both
  matter beyond this feature. `vendors.csv`'s own documentation comment broke
  the *entire* seed: `parseCsv` had no comment support and threw, and
  `main()` awaits `seedVendors` before `seedProducts` — so only locations
  seeded, every run, while 85 tests stayed green throughout. And `db/seed.ts`
  ran `main()` at module scope, so importing it to unit-test the pure parser
  executed the real seed against the live `DATABASE_URL`, racing the test
  suite's truncation and setting `process.exitCode = 1` — `bun test` printed
  all-pass while `test:docker` still exited 1. Fixed both ways: the parser
  moved to `db/csv.ts`, and `main()` is now guarded on
  `import.meta.url === pathToFileURL(process.argv[1]).href`. Noted, not
  fixed: `scripts/create-user.ts` has the identical unguarded-`main()` shape
  (open item #23) — its side effect is worse, an interactive password prompt.
  **This is the fourth failure in this project whose defining feature is that
  every gate stayed green** — after the static CSP (#13), the dev
  cross-origin 403 (#17), and the wrapped driver error (#18). See "The
  current risk, stated plainly" below.
  typecheck, lint, `bun run build` clean; 94 tests / 381 assertions across 7
  files, exit 0.
- **2026-07-30** — **A size can no longer be mistyped, and only bottled beer is
  offered a case.** Both were free-typed number boxes that accepted a plausible
  wrong answer and reported nothing. `75` entered for `750` is a legal integer:
  it saves clean and then values that product's whole count at a tenth of its
  worth. A case count entered against a spirit's NULL `case_size` is the one
  input `computeLineUnits` cannot resolve, so the line silently drops out of the
  valuation rather than being wrong out loud — and the old form actively invited
  it, hinting *"No case size on file"* under a Cases box on products the catalog
  leaves blank on purpose. Sizes now come from category-aware preset lists
  (`lib/bottle-sizes.ts`, the single definition the way `lib/pack-level.ts` is
  for cases); the back office keeps an "Other…" escape and the count leg
  deliberately has none, because a mistake on a phone in a dim bar is silent and
  a mistake at a desk is correctable. Case entry for spirits is **deferred to
  Phase 2.0 by owner decision** (open-item #21) — a scope call, not a gap.
  Typecheck, lint, `next build` and `test:docker` are all green, 73/73, 316
  assertions. **None of them ran a React component, and no browser was
  opened** — see "built but unproven". An opus correctness review then found
  three non-blocking, post-implementation defects, and all three are now
  fixed (open-item #22): `changeCategory` no longer re-defaults a stored
  `size_ml` on an unrelated category change, diverting to "Other…" instead;
  the keg default moved from a half barrel to a sixtel, backed by a new
  catalog-derived test rather than a pinned literal; and `describeAfter` now
  guards eaches falling to zero the same way it already guarded cases. Two of
  the three touch a component no test executes, so "fixed" there means traced
  by hand against real values, not observed running.
- **2026-07-30** — **The Phase 1 code gaps are closed** (`docs/mvp-gaps.md`,
  branch `fix/mvp-gaps-blockers`, nine commits). A, B, C, D1, D2, E, F, G and I
  fixed; H (vendors) and J (`scanCountLine` dead code) deliberately left. The
  three that mattered were all silent: the reorder list could never produce a
  row and said "Nothing is below its reorder point"; scan-to-enroll dead-ended
  on every product already in the catalog, or duplicated it if you typed a
  differing name; and a refused write stayed on screen as counted while later
  scans compounded onto the phantom. Freezing writes on `submitted` needed
  `reopenCount` added alongside it, or a mis-tapped Submit would strand a
  half-counted count behind an immutable close.
  **Also found, and not in the audit:** `isDuplicateKeyError` was blind to
  errors drizzle had wrapped in `DrizzleQueryError`, which made every
  `ConflictError` in the catalog unreachable — they were arriving as "Something
  went wrong" mid-count. That is the third failure here whose defining feature
  is that every gate stayed green, after the CSP and the dev cross-origin 403.
- **2026-07-29** — **The phone can now reach a secure origin.** The camera is
  gated on a secure context, and the `chrome://flags` override that fakes one
  is Chromium-only — it had silently done nothing twice, because the handset's
  preflight showed no native `BarcodeDetector`, which means the browser is not
  Chromium. Replaced with actual HTTPS: `scripts/dev-lan.sh` now mints a
  self-signed certificate naming the LAN IP and runs an nginx TLS proxy
  (compose profile `tls`) on :3443, so scanning works on any browser with no
  per-device flag. Added `/count/preflight`, a device capability screen, and
  `docs/phone-count-test.md`, the run protocol. **Nothing has been counted
  yet — this is setup, and the camera itself is still unproven.**
- **2026-07-28** — **First attempt at a real count on a phone.** It got as far
  as the first save and threw: `crypto.randomUUID` is a secure-context-only
  API, and the only way to reach the counting screens is a phone on a plain-http
  LAN origin. So the entire write path was unreachable on the one device that
  matters, and nothing server-side could see it — the 17 write-path tests, the
  typecheck and the server render all passed. Fixed with an RFC 4122 v4
  fallback built on `crypto.getRandomValues` (not secure-context gated, and a
  CSPRNG — `Math.random()` would silently drop scans, since the ledger treats a
  colliding `client_line_id` as a replay). Covered by 5 new tests, mutation-checked.
  Also found and fixed: Next's dev cross-origin guard was returning 403 for every
  client chunk on `127.0.0.1`, so that origin rendered and never hydrated
  (open-items #17). Added `/count/preflight` and `docs/phone-count-test.md`.
- **2026-07-28** — Dashboard added at `/office`; counts table moved to
  `/office/counts`. **Found and fixed a CSP that blocked every inline script**, so
  nothing in the app hydrated while every server-side check passed; it also caused
  the login form to leak a plaintext password into the URL. Both fixed and
  verified in a browser.
- **2026-07-28** — Engine correction: the database is **MariaDB 11.8**, not MySQL.
  hPanel's label had been taken at face value everywhere. Driver, dialect and URL
  scheme are all still correct.
- **2026-07-28** — Auth and write paths closed against a real database.
- **2026-07-27** — Multi-tenancy landed before the first migration ran. Schema
  audit fixed an unchecked `vendor_id` and a reproducible count-line deadlock.
- **2026-07-27** — Renamed Handlebar → Truestock.
