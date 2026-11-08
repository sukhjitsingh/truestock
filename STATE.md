# Truestock — current state

Where the project actually is. Updated 2026-11-08.

This file answers one question: **what is proven, what is merely built, and what
is next.** The distinction matters more here than the feature list, because this
project has twice shipped something that looked finished and was not.

- `ROADMAP.md` — what comes after this
- `docs/open-items.md` — every deliberate gap, with the trigger that makes it due
- `docs/go-live.md` — the gate before the first deploy, and what to verify after
- `CLAUDE.md` — invariants and conventions
- `docs/spec.md` — scope, data model, rationale

---

## One-line status

**The eight invoice failures from the 2026-11-06 QA run are fixed on
`feat/phase-2.5-invoice-automation`, pushed, and up for merge to `main` as PR #37
(2026-11-07).** Each was proven with a real text invoice through the UI and
confirmed in the database. Vision and scanned invoices remain unverified because
there is no API key (open-item #47).

**Phase 2.5 is implementation-complete on `feat/phase-2.5-invoice-automation`.**
All five planned A–E slices are merged into that integration branch: secure
invoice archive, extraction and review, vendor matching, atomic cost posting,
and the limited audit-packet export. PR #26 merged Slice 5 into its prerequisite
branch, then PR #25 merged the complete stack into the Phase 2.5 branch on
2026-08-21. Linux CI at that merge: **449 tests across 31 files, 449 pass, 0 fail,
1,278 assertions**, followed by a successful production build (1384 tests pass
locally as of 2026-11-07). The final merge to `main` is the remaining
repository-integration step, open as PR #37; auto-approval is deferred
by design until about 100 real invoices provide correction data.

**MVP is built and not deployed, and as of 2026-08-12 every part of the
counting loop has now run on a real phone** — scan, enrol, tenths, sealed
quantities, valuation, and the offline queue, the last three under the
production CSP. The sentence that stood here since this file was written —
*"the counting app, the actual product, has never been used by a human"* — is
not just false now, it is comprehensively so.

**What has NOT happened is a count.** Four sessions, 8 lines between them. Every
mechanism is proven and nothing has been measured: no timed pass, no full
six-location walk, 90 of 101 products unpriced. The project moved from "does it
work at all" to "does it work at scale" in one day, and this file should not be
read as saying more than that.

**Phase 2.9 (field validation and the owner's data) status as of 2026-11-07:
nothing is done.** Of its eleven items, five have partial evidence and six have
none. The shared dev DB still has 9 of 99 products costed, 0 case sizes, 0 pars,
0 vendors and no wine producers. Invoice approval posts costs, but so far only
into test databases. There has been no timed count. The 2026-11-06 queue fix
(#46) is proven only by e2e tests, not on the phone. Vision has never run
(#47). The per-item breakdown is in ROADMAP.md, Phase 2.9, and is tracked in
`docs/open-items.md` #48.

**Phase 2 — the UI redesign — shipped 2026-08-14** (PR #13, merge `9cbf64b`).
Nine implementation commits behind the Gate 1 approval: design tokens and
sixteen new component specs, the mobile counting
surface rebuilt to `ui-spec-mobile.md`, the back office moved onto a 64 px left
icon rail with a shared `PageHeader` and Table primitives, the catalog table
migrated to TanStack Table v8 with per-role column sets, two-level category
filters, type-ahead search, and `prototypes/*.html` regenerated from
`app/globals.css` instead of eleven hand-drifted copies. **Every screen it
touched in the back office was opened in a real browser; not one of the
redesigned mobile counting screens has been on a phone.** That asymmetry is the
main thing this file now has to say — see "What is built but unproven".
*(Update 2026-11-07: the redesign has since been on a phone twice, on 2026-10-25
and 2026-11-06. It has been used, but not evaluated: none of the four §6 UI bets
has a verdict.)*

**Also as of 2026-08-12, the app sets itself up.** Phases 1 and 1.5 shipped:
locations are manageable from the app rather than by SQL, cost and case size are
editable in place, the dashboard counts in the database instead of off a capped
array, and a per-vendor order copies or prints. That work merged as PR #11.
**This changes what is buildable, not what is measured** — the binding constraint
on closing Phase 1 is now the owner entering 90 costs and some par levels, which
no amount of code can do. Confirmed in MariaDB 2026-08-12: 9 of 99 active products
costed, **0** with a `case_size`, **0** par rows, **0** vendors. The reorder screen
cannot produce a row until that changes.

**Corrected 2026-08-11.** The paragraph that stood here described a 2026-07-31
session against a volume that no longer exists — the database has been reset
since, and that evidence is unrecoverable. What the current volume actually
holds is a *second, larger* session on **2026-08-08**, which had never been
recorded in this file. Queried rather than remembered:

| | |
|---|---|
| Count 1 | type `full`, opened by user 1 at **05:05:13**, `closed` **05:08:15** — 3m 02s |
| Product 98 | `Smirnoff`, 200 ml, Spirits, created 05:06:25 — barcode `08200802`, `each`, primary |
| Product 99 | `Grey Goose`, 200 ml, Spirits, created 05:07:24 — barcode `080480280048`, `each`, primary |
| Count lines | 2, both in location 5 — **18 eaches** and **9 eaches**, 0 cases, no partial fills |
| Ledger | 2 rows, **2 distinct `client_line_id`s** — no duplicate write, idempotency intact |
| `total_value` | **0.00** — both counted products are unpriced |

So scan-to-enroll ran **twice**, end to end, on real hardware: two unknown
barcodes became two catalog products and two count lines, and the count closed
clean. That is more than the single enrolment this file used to claim. It is
still not a count.

**Three things proved themselves on real hardware in that pass**, none of
which any test in this repo can exercise: the camera and decoder opened and read
a real barcode (the "last inch" that had never happened on any device); 200 ml
came from the size preset list rather than a typed number; and a spirit was
recorded with no Cases stepper, which is the 2026-07-30 beer-only-cases rule
behaving correctly outside a browser harness.

**What this does NOT prove, and the distinction is the whole point of this
file.** Two products are not a count. Untested still: the sub-20-minute target
(3m 02s for two enrolments measures the enroll budget, not the count one), the
offline queue (WiFi never dropped, never went into the walk-in), open-bottle
tenths (only sealed quantities were entered — `partial_fills` is `[]` on both
lines), the locked location leg across all five sections (both lines landed in
location 5), and valuation — both counted products are unpriced, so the count
closed at a `total_value` of 0.00. This is a successful transaction, not a
first real count.

**Valuation produced a correct non-zero number for the first time on
2026-08-12** — count 2 closed at **$170.90**, and that figure was recomputed
independently in SQL and matched to the cent. See the 2026-08-12 entry in Recent
history for what that does and does not prove. The sentence that stood here —
that valuation had never left 0.00 — is now false, and the tenths path it
depended on has run against a database.

Phase 1's *code* gaps closed 2026-07-30 (`docs/mvp-gaps.md`) and the vendor
write path closed 2026-07-31; what remains in Phase 1 is entering real costs and
vendors, and a full timed count.

---

## What is verified

Verified means *observed running*, not reviewed or typechecked.

**Invoice path on a real text invoice (2026-11-07).** Upload, extraction, review,
partial cost posting, alias learning, duplicate refusal and the audit packet were
driven through the UI against a production build and read back from the database.
Per-finding results are in open-item #47.

| Area | Evidence |
|---|---|
| **Schema + migrations** | Full chain `0000 → … → 0009` applies clean from empty to MariaDB 11.8 in Docker. Phase 2.5 verified all ten migrations together in an isolated database; composite tenant FKs reject cross-tenant ids (1452), generated uniqueness constraints hold, MariaDB JSON aliases round-trip through mysql2, and decimal costs remain exact |
| **Auth path** | Better Auth under `generateId: "serial"` returns integer ids; sign-in returns a session; the inactive-user re-read gate refuses a *still-valid* session — **with a negative control** |
| **Count write path** | `tests/count-write-path.test.ts` against real MariaDB, wired into CI as a service container |
| **Invariants 1, 2, 3, 8, 9** | Covered by that suite: closed counts refuse writes, cost snapshots survive a price change, three scans make one row, a manager never receives cost fields, cross-tenant ids are refused |
| **Idempotency** | Same `clientLineId` twice increments once; a differing replay leaves the line untouched |
| **Par writes + reorder list** | `tests/catalog-write-path.test.ts` — an overall par is written, updated in place, cleared by null, scoped to the tenant, and produces a reorder row with the right suggested quantity |
| **Barcode linking** | Same file: a linked code resolves to the right product, no duplicate product is created, first-barcode-is-primary is derived, a cross-tenant product id is refused as NotFound, and two tenants can enrol the same UPC |
| **Count freeze + reopen** | A submitted or reviewed count refuses writes with a distinct error; reopen returns it to `in_progress` and writes land again; a **closed** count can never be reopened |
| **Error discrimination** | `tests/db-errors.test.ts` — asserts against the real `DrizzleQueryError` class, not a stand-in, because the shape that broke it came from the library |
| **Back office UI** | Signed in through the real form in Chrome, dashboard and all office routes render, console clean, unauthenticated requests redirect |
| **Role gating is structural** | A manager's HTML contains no unpriced tile at all, and zero dollar-shaped strings anywhere in the response |
| **Size preset lists** | `tests/bottle-sizes.test.ts` — which list each category resolves to, the keg short-circuit ahead of category, the NA-on-the-beer-list decision, **every size in the seed catalog asserted against the list its own product resolves to**, and (added by the review fix below) the keg default computed as the catalog's modal keg size rather than a pinned literal. Pure module only: no component is executed by it |
| **Vendor write path** | `tests/vendor-write-path.test.ts` — 12 DB-backed tests: `createVendor`/`updateVendor`, cross-tenant refusal, bulk-assign atomicity confirmed by a re-read that finds no partial apply, and reorder-list vendor grouping end to end. Mutation-checked: disabling the ownership guard fails exactly one test |
| **Seed CSV parser** | `tests/seed-csv-parser.test.ts` — the pure parser, moved to `db/csv.ts` so this test never has to import the seed's own entry-point module (see `docs/history/state-log.md`, 2026-07-31) |
| **User management** | `tests/user-write-path.test.ts` — self-deactivation, self-demotion, last-active-owner lockout and cross-tenant refusal, plus the session rows being deleted in the same transaction as the deactivation. **Browser-verified 2026-08-04**: `scripts/verify-browser.mjs` drives it in a real Chromium and confirms a refused self-demotion both reports the refusal and snaps the select back to the role the user actually holds |
| **Rapid-scan frame guard** | `tests/rescan-guard.test.ts` — 11 cases covering both directions, since both are silent: a bottle held in frame for 60 frames counts once, and three identical bottles presented in sequence count three times. Two modelled shelf sweeps at different cadences. Pure module, no camera or DOM |
| **Rapid-scan write path** | `tests/rapid-scan.test.ts` — pack-level routing from the barcode (server-resolved, never client-supplied), mixed case/each scans landing on ONE line as 2 cases + 3 eaches (invariants 3 and 4), and another tenant's barcode refused rather than resolved (invariant 9) |
| **Tenths → valuation, end to end on a device** | Count 2, 2026-08-12. Four fill readings written from a phone; `total_value` **$170.90**, recomputed independently in SQL and matched to the cent. Cost snapshots landed on the lines (invariant 2); the one unpriced line was **excluded rather than zeroed**. The only leg of the valuation path never before run outside a test |
| **The camera, on a real device** | Counts 3 and 4, 2026-08-12. Two real barcodes decoded and enrolled — `X004YKHTYX` (Code 128) and `855553008153` (UPC-A) — by the **WASM polyfill**, since the handset has no native `BarcodeDetector`. The "last inch" open since 2026-07-28 |
| **The offline write queue** | Count 4, 2026-08-12. Airplane mode → submit → chip **`1 pending`**; airplane mode off → chip **`Synced`** unaided, so the `online` listener fires and `flush()` drains. Database after: one line, one ledger row, **8 distinct `client_line_id`s across all four counts** — the queued write applied exactly once |
| **The production CSP** | 2026-08-12, in a browser. `script-src 'self' 'nonce-…' 'wasm-unsafe-eval'` (no `'unsafe-eval'`), `connect-src 'self'` (no `ws:`); 16/16 scripts nonced, React hydrated, console clean, and a UPC decoded under it. The single highest-risk item on `docs/go-live.md` |
| **The redesigned back office, in a browser** | Phase 2, 2026-08-13/14. All seven office routes plus two detail routes opened in Chrome. The left icon rail expands 64 → 208 px on an *ordinary hit-tested click*, writes its cookie, and is still expanded after a full reload; two-level category filters resolve Spirits → six type pills → 11 tequila rows matching the 11 in the database; type-ahead search reaches `?q=…` with zero history growth; costs render `82.00`/`144.00` |
| **Role gating survives the TanStack migration** | `bun run verify:browser` asserts a manager's rendered DOM contains **no** `Unit cost for` string and zero cost inputs, with an owner positive control that must find it — so the check cannot pass by failing to render. Columns are built per role at call time, never `columnVisibility` |
| **The catalog table's own behaviour** | Same harness: clicking a sortable header changes `aria-sort` **and** reorders the rows; pagination advances `Showing 1–20 of 99` → `21–40 of 99` and changes which rows show; a product with no par level renders **no** stock bar (15 rows, 0 meters); clicking a non-interactive cell does not navigate |
| **The accessibility floor, on `/office/catalog`** | Same harness: 30 tab stops walked, none bare; every icon-only control has an accessible name; no heading-level skips; opening the account menu moves focus into it and Escape returns focus to the trigger. Both focus guards are mutation-checked — reverting either fails loudly |
| **One barcode, one product, in any written form** | 2026-11-05, docs/plans/barcode-integrity. Every barcode is stored and looked up as the 14-digit standard form (`lib/barcode.ts`), so the UPC-A, EAN-13 and UPC-E readings of one bottle are one code and the unique index refuses linking it to a second size. **Red first**: 7 DB tests failed against the old code exactly as the owner's bug predicts (linking the EAN-13 form to a second product *succeeded*; rapid scan of the EAN-13 reading said "Product for this barcode not found"), then passed. Mutation: the normalizer returning its input fails exactly the 18 barcode-form tests. Browser: a code stored from a UPC-A link is recognised when the fake camera reads its EAN-13 form |
| **Size before link, and naming the owner** | Same plan, browser harness with a fake camera: picking a product opens a confirmation with the size as the largest text and links nothing until "Link and count"; "It's a different size" opens a prefilled form with no size chosen and the rejected size disabled; a taken barcode is refused as "already belongs to Smirnoff 750 ml" with a working "Count Smirnoff 750 ml" button |
| **The app's own barcode reader loads under the production CSP** | 2026-11-05. Before this, the fallback reader fetched its engine from `fastly.jsdelivr.net`, which `connect-src 'self'` refuses — reproduced in headless Chromium against a production build: the camera opened and decoded nothing. The engine is now served from the app's origin and copied out of `node_modules` on every build (fingerprint-checked against the package's `ZXING_WASM_SHA256`). The harness hides any built-in reader, scans a generated UPC-A, and reaches "Which bottle is this?"; with the engine file removed, that check fails. **The built-in-reader branch is unverified** (open-item #45) |

**260 tests across 23 files**, all green as of 2026-11-05 — run against an empty
MariaDB **10.11** in a cloud session (not the owner's 11.8 Docker), so this also
proves every DB test file migrates for itself (see 2026-11-05 below). Browser
harness **53/55** against a production standalone build; the 2 failures are the
data-dependent stock checks, which need a closed count that database lacked.
The figure that stood here: **210 tests across 21 files**, all green — **re-run 2026-08-14 against MariaDB
11.8 in Docker: 210 pass, 0 fail, 612 assertions, 31.7s.** Plus **45 browser
checks** via `bun run verify:browser`.

**Read that browser number carefully, because two of its digits are not what
they look like.** The 2026-08-14 run against the dev server was **44 pass, 1
fail, of 45** — and of the 44, **two are skips** (`/office/vendors`' Edit button
needs a vendor row; the reorder copy/print check needs a par level and a closed
count) which the script prints but explicitly labels *Not a pass*. So 42 checks
actually executed. The one failure is a `Performance.measure` negative-timestamp
`TypeError` from Next's **dev** instrumentation, not app code; the same harness
reported **44/44 against a production build** on 2026-08-14 (`585d2b6`), which
is where the CSP-sensitive checks belong anyway. Neither number has been re-run
since. The two skips are printed as NOT VERIFIED on every run so they cannot
pass silently.

The paragraph below describes the
2026-07-31 state and its reasoning, which still holds — only the counts moved.

**94 tests across 7 files**, all green, as of 2026-07-31 — `bun run
test:docker` against MariaDB 11.8 in Docker, 381 assertions, 0 failures. The 16
in `tests/bottle-sizes.test.ts` are all 2026-07-30: 15 for the preset lists
themselves, plus 1 more from the review fix below that replaced a pinned
`58674` assertion with one computed from the catalog. `tests/vendor-write-path.test.ts`
and `tests/seed-csv-parser.test.ts` landed 2026-07-31 with the vendor work,
bringing the file count from 5 to 7. The 73 that existed before those two files
are unchanged, so nothing was modified or disabled to get there.

Two new test files landed 2026-08-03 (`tests/user-write-path.test.ts`,
`tests/rapid-scan.test.ts`), bringing the file count to 9. Both require a live
MariaDB connection (`test:docker`) and will error with a clear message outside
that context, consistent with all other DB-integration tests.

**121 tests across 10 files**, all green — **re-run 2026-08-11 against MariaDB
11.8 in Docker: 121 pass, 0 fail, 427 assertions, 32.4s.** So this count is
current, not inherited from the 2026-08-04 entry that first claimed it.
`tests/rescan-guard.test.ts`
is the tenth file and the only pure one of the recent batch — it models frame
sequences rather than touching a database, which is the point of having pulled
the guard out of the scanner's effect. The rapid-scan and user-write-path files
grew in the same pass: mixed case/each on one line, cross-tenant barcode
refusal, and the last-active-owner deactivation leg that had no coverage.

**The suite is checked for teeth, repeatedly.** Deleting the ledger insert from
`applyIncrement` — the whole idempotency mechanism — fails exactly the four
dependent tests. Stubbing out `upsertProductPar` fails exactly the 13
par/reorder tests. Widening `isCountWritable` to accept `submitted` fails
exactly the 3 write-refusal tests. In each case everything unrelated stays
green. A suite that passes against a broken implementation is worse than none,
so re-do this after any significant change to the write path.

**The 16 size tests have not had that treatment.** They were run, they pass, and
nobody has checked what they fail against. The seed-catalog block is the one
worth mutating first, since it is the only guard against a preset-list edit
orphaning a real product.

## What is built but unproven

Written, reviewed, typechecked — never observed working.

**Scanned invoices (2026-11-07).** Vision has never run: there is no API key. Scans
are routed straight to it and stop at `EXTRACTION_UNAVAILABLE`, so invoice B's lines
and the F9 path on Hostinger are unverified (open-item #47). **Vision is deferred past
go-live (owner decision 2026-11-08)**: at launch scans are archived, not extracted, and
their costs are entered by hand; this stays unproven on purpose until the feature
returns.

**The release gate is proven on GitHub (2026-11-08); a real deploy and a rollback are
not.** Deploy run #17 (PR #39's merge): `release` waited for the owner's approval
(created 04:11, started 04:14 after approval), its first step read the `production`
environment's rules with the workflow token and printed *"gated by a required reviewer
and limited branches — continuing"*, and migrate then stopped on the unset
`HOSTINGER_SSH_HOST`, so nothing reached Hostinger. Still unproven: a deploy with real
secrets, `rollback.yml` (never run — a day-one rehearsal in `docs/go-live.md`), and
`claude-review.yml`, which needs `ANTHROPIC_API_KEY`.

**The CI browser gate is now proven (2026-11-08).** `e2e-smoke` ran green on GitHub
on PR #38 (run #68, head `10256ee`): all three roles signed in, 26/26 passed. It was
mutation-checked locally (a nonce-less CSP fails it). Its first run never started:
`runner.temp` in job-level `env` made GitHub reject the whole of `ci.yml`.
The retired-product refusal (known defect #1, fixed 2026-11-08) is proven by DB tests
only, not on a phone: a refused write should be dropped and named on screen.

- **The entire redesigned mobile counting surface (Phase 2, 2026-08-14).**
  This is the biggest unproven thing in the project right now, and it is
  unproven in a specific way: the back office half of Phase 2 was verified
  screen by screen in a real browser, and the counting half was not opened on a
  phone at all. `app/(count)/count/page.tsx`, `count-leg.tsx`,
  `count-line-card.tsx`, `fill-entry.tsx`, `quantity-entry.tsx`,
  `barcode-scanner.tsx`, `catalog-search.tsx` and `tab-bar.tsx` all changed;
  the new floating bottom bar (search · scan · finish section) replaced the
  single *Finish section* button and the list gained padding to clear it. The
  bottom bar was checked at 400 px wide in a desktop browser — which proves the
  layout, not the reach, not the thumb, and not the dim bar.
  **Every phone-verified fact in this file predates the redesign.** The fill pad
  driven on 2026-08-12, the camera enrolments, the offline chip — all of those
  were observed on screens that have since been rebuilt. They are evidence about
  the mechanisms underneath, which did not change (no schema, no write path, no
  leg model), and they are **not** evidence about the surface that ships today.
  That is exactly the shape of failure this file exists to name, so treat the
  counting app as re-entering "never been on a phone" until Phase 2.9 puts it
  there.
  **Update 2026-11-07:** the phone sessions on 2026-10-25 and 2026-11-06 ran on a
  build that contains the redesign, so "never been on a phone" no longer holds.
  What is still unproven is the evaluation. None of the four bets in
  `docs/phone-count-test.md` §6 has a verdict. The 2026-10-25 recording also found
  new issues to fix or accept before a real count: V1 (Save drops a fill that was
  chosen but not added), A18 (the tab bar stays live during entry), A19 (Android
  Back), A20 (Submit and Close have no pre-flight check), DB-1 (`$0.00` shown as
  if it were a value) and DB-4 (a count can close with locations never visited).
- **The counting app on a phone, AT SCALE.** Scan, tenths, sealed quantities,
  scan-to-enroll and the locked-location leg have each now run on a handset
  (2026-08-12) — so this entry is no longer "does it work" but "does it hold
  up". Nothing here has been done more than a few times in a row: the longest
  session recorded **4 lines**, no pass has covered all six locations (count #3
  on 2026-10-25 touched 2 and closed with 4 never visited), the stray-bottle
  sheet has never been opened, and nothing has been timed. Fatigue, a wrong tap at bottle 80, a leg switch made
  in a hurry — none of that has been anywhere near this app. The 2026-08-01 UI pass
  (larger tap targets, safe-area insets, touch-manipulation, bigger fill and
  quantity buttons) is built and typechecked; **the fill pad has now been driven
  on a device** (2026-08-12, four tenths readings), so the 80 px Empty/Half/Full
  row and the tenths grid are no longer unpressed. The quantity stepper, the
  scanner chrome and the safe-area insets still are.
- ~~**The camera, on any real device.**~~ — **verified 2026-08-12**, and moved
  to the table above. Two real barcodes decoded and enrolled on the handset, by
  the WASM polyfill, one of them under the production CSP. The "last inch" that
  had been open since 2026-07-28 is closed.
  **What is still unproven about scanning** is narrower and now stands on its
  own below: rapid mode against a camera, and resolving a barcode to a product
  the catalog *already has* — both scans so far were enrolments of unknown
  codes, which is a different branch of `onBarcode`.
- **Everything added to the counting leg on 2026-07-30.** Four changes, all UI,
  none of them covered by a test and none of them driven on a device: the
  search-first barcode-link screen (which added a step to a path held to a
  20-second budget, so it wants timing specifically), the fill-correction mode,
  the optimistic rollback on a refused write, and the message naming a dropped
  queued write. Listed with how to exercise each as open-item #20.
- **Rapid-scan mode, against an actual camera** (2026-08-04). The write path and
  the frame guard are both tested — the guard hard, in both directions, because
  both of its failure modes are silent. But those tests feed it *modelled* frame
  sequences. What no test can tell us is whether the assumptions behind them
  hold in the hand: that a bottle leaving the frame reliably produces a clear
  frame the detector reports as empty, that 250ms is above the real flicker gap
  on a mid-range Android, and that a glossy label under bar lighting does not
  produce long runs of dropped frames that read as a bottle leaving. Writing the
  tests already found two silent miscounts in logic that looked right; the
  camera is the next layer down and nothing has exercised it. **Count a real
  shelf, then count it by hand, and compare** — this is the one feature where an
  off-by-one is invisible on screen by construction.
- **The size dropdown and the eaches-only quantity screen** (2026-07-30). Both
  are on the counting leg and **neither has been opened on a phone, or in any
  browser.** Typecheck, lint, `next build` and the full suite are green and none
  of them executed a React component: no test in this repo imports one, and the
  16 new tests import `lib/bottle-sizes.ts`, `node:fs` and `node:path` and
  nothing else. So every behavioural claim in that change is client state
  nothing has run — the size list re-pointing when the category or unit type
  changes, the size *not* moving on mount of the edit form, the Cases stepper
  appearing only for bottled beer, the "Other…" reveal, and the SET consequence
  line on the one-column layout.
  **This is more surface needing the phone test, not progress toward it.** It
  changed the enroll screen and the quantity screen since the last time anyone
  looked at either, while the number of humans who have counted a bottle with
  this app is still zero. Two of the three review findings below live on exactly
  these screens.
- **The three review findings from 2026-07-30 are fixed, and two of them are
  exactly the kind of change this section is about** (open-item #22 closed).
  `changeCategory` now diverts to "Other…" instead of rewriting a stored
  `size_ml`, and `describeAfter` now guards eaches falling to zero the same way
  it already guarded cases — both in `components/office/product-edit-form.tsx`
  and `components/count/quantity-entry.tsx`, both components no test in this
  repo executes. "Fixed" for those two means traced by hand against real
  before/after values in a confirm pass, not observed running. Only the third
  — the keg default moved from a half barrel to a sixtel in
  `lib/bottle-sizes.ts` — is backed by an executed test, because it is a
  pure-function default, not a component.
- ~~**The vendors screen's `router.refresh()` fix**~~ — **verified 2026-07-31**,
  and moved out of this list. It was the one line in the vendor work never
  opened in a browser. Driven in Chrome: creating a vendor from the empty
  state and editing its name both showed on the list with no manual reload,
  the database held exactly one row afterwards, and a real navigation
  reloaded to the same state — so there is no self-updates-but-disagrees-with-
  reload divergence, which would have been worse than the original staleness.
  The dev-only Fast Refresh flash seen in an earlier session did not
  reproduce. **Every line of the vendor work has now been executed against a
  browser and a database.**
- ~~**The offline write queue**~~ and ~~**the production CSP**~~ — both
  **verified 2026-08-12** and moved to the table above.
  ~~Two narrower gaps survive from the queue: the mount-time flush has never run,
  and the queue has never held more than one write.~~ **Superseded 2026-11-06.**
  The first phone test with more than one queued write **failed** twice. An older
  queued write overwrote a correction (F2), and nothing retried after the phone
  fell over to mobile data (F3). The fix in `components/count/count-leg.tsx` (a
  single lock, oldest write first, a 15 s retry timer and a flush on mount) is
  proven only by 3 e2e specs on a production build, not on the phone. What is
  left is in open-item #46.
- **Phase 2.5 at operating scale.** Every A–E capability has database-backed
  coverage, the review/cost/audit-packet surfaces have run in isolated browsers,
  and a real Southern Glazer's text-PDF shape is covered. What has not happened
  is the Gate 1 product measurement: 20–25 real invoices, including actual
  photographed/scanned documents through the live Claude Vision API, reviewed
  by the owner in under 30 minutes *(the scanned/Vision part is deferred past
  go-live, 2026-11-08; the measurement now runs on text-PDF invoices)*. The real SendGrid path and Hostinger storage
  also remain unproven. Open item #39 records the two accepted audit-packet
  reliability debts: whole-file memory buffering and no stale-build reaper.
- **The standalone server entrypoint.** The production-mode run used
  `next start`, which printed `"next start" does not work with "output:
  standalone" configuration`. It gave us what was needed — no HMR, the real CSP
  — but Hostinger runs `node .next/standalone/server.js`, which has still never
  been started. On the go-live list, not closed by 2026-08-12.
  **Still true after Phase 2, and one commit message says otherwise.** `585d2b6`
  reports the browser harness running "end to end against the standalone build —
  44/44". What it actually ran against was a production-mode server started the
  same way as before: `docker-compose.prod.yml` runs `npm run build && npm run
  start`, and its own header comment says it is *not* the real production image.
  The CSP that run exercised is real and the 44/44 stands; the word "standalone"
  in that message does not. Nothing has yet executed `.next/standalone/server.js`.
- **Concurrency.** The gap-lock deadlock and `withLockRetry` were reproduced by
  hand against MySQL — never against MariaDB, never as a test.
- **Valuation at catalog scale.** The *mechanism* is proven as of 2026-08-12 —
  count 2 closed at $170.90 and the figure reconciles to the cent against an
  independent SQL recompute. What is unproven is valuation of anything but kegs:
  **90 of 99** products are unpriced (was 88 of 97 — the two scan-to-enroll
  products added on 2026-08-08 are unpriced too), and the only priced products
  are the 9 draft kegs, which came costed in the seed. **No product has a
  `case_size`** — 0 of 99 — so the 16 bottled beers cannot be counted by the case
  yet either, and the `missing_case_size` exclusion branch has never fired
  against real data.
- **The deploy pipeline.** Built, never run against a real host.

## Recent history

The dated history log — every entry from 2026-07-27 on, newest first — lives in
[`docs/history/state-log.md`](docs/history/state-log.md). New entries go at the top
there, not here. This file keeps only current status: what is verified, what is
built but unproven, the current risk, and what is next.

## The current risk, stated plainly

**Everything verified so far is below the UI.** The domain layer is in good shape
and well covered. But the app's entire reason to exist is being faster than a
clipboard in a dim bar, one-handed, and no part of that claim has been tested.

**Phase 2 sharpened this rather than closing it, and in a way worth stating
exactly.** The back office is now the best-verified surface in the project — 45
browser checks, mutation-checked focus guards, role gating proven against the
rendered DOM. The counting app got a *larger* rebuild than the back office did
and received **none** of that: no test in this repo imports a React component,
`verify:browser` drives `/count` only far enough to confirm the page loads and
that locations are server-rendered, and no phone has opened any of it. So the
project now has a verified back office wrapped around an unverified product.
Four of Phase 2's own defects — a control in a corner the browser owns, a cookie
read through a client-reference proxy, an unnamed search field, and a focus ring
the harness was structurally unable to see — were all found by *looking at the
running app*, and three of the four would have passed any conceivable
server-side check. There is no reason to think the counting surface is cleaner
than the one that produced four; there is only less evidence about it.

The CSP incident is the cautionary tale: the failure was total — no interactive
element anywhere in the app — and it passed CI, `next build`, the `/ship` gate,
and every status-code assertion. **Server-side confidence does not transfer to
the client.**

**This got sharper on 2026-07-30, not weaker.** The gap audit found nine real
defects by reading code, and then a tenth surfaced only because a new test
exercised the real library — `isDuplicateKeyError` had been silently blind to
wrapped errors, disabling every `ConflictError` in the catalog. **Five of this
project's worst bugs now share one signature: every gate stayed green.**
Typecheck, build, lint, status codes, and the tests that existed — the static
CSP (#13), the dev cross-origin 403 on `127.0.0.1` (#17), the wrapped driver
error (#18), `db/seed.ts` running `main()` at module scope, which let
importing it for a unit test fire the real seed and left `bun test` printing
all-pass while `test:docker` exited 1 (2026-07-31, closing open item #19),
and now the cleanest example yet: `DEV_LAN_ORIGIN` silently reverting to
loopback-only whenever the app was brought up with plain `docker:up` instead
of `docker:up:lan` (2026-07-31, open item #24). `curl
https://192.168.12.33:3443/login` returned 200 for the entire time the app
was completely unusable on the device it was built for. When something here
looks like it cannot fail, that is the claim worth executing against the
actual library, the actual database, or the actual browser.

## Picking this up cold — the phone count

Everything needed to run it is built and committed. **As of 2026-08-11 the
stack is already up** — `docker compose ps` before re-running anything below.

```bash
bun run docker:up:lan     # LAN bind + self-signed cert + TLS proxy; prints both URLs
bun run docker:migrate    # only on a fresh volume
bun run docker:seed       # only on a fresh volume
```

Then on the phone, open **`https://<lan-ip>:3443/count/preflight`**, accept the
certificate warning once (*Advanced → Proceed*), and confirm **Secure context:
Yes** before anything else. Full protocol: `docs/phone-count-test.md`.

Four things to know before starting, each of which will otherwise waste an
hour:

1. **A later plain `docker:up` will silently undo this.** `docker:down &&
   docker:up` is the deliberate way back to loopback-only; the danger is an
   *incidental* `docker:up` — `docker:reset`, a script, an agent told to "try
   `docker:up` once if the database looks down" — reverting a live LAN
   session with zero warning. The container comes back up looking healthy and
   `curl` against the LAN URL still returns 200; the phone just silently
   loses its allowlisted origin. If sign-in that worked an hour ago stops
   working, check `docker compose exec -T app env | grep DEV_LAN_ORIGIN`
   before suspecting anything else — empty is the tell. See open item #24.
2. **The https URL is the one that matters.** Plain http on :3000 works for
   quantity and search-picker counting but the camera cannot exist there. If
   preflight says *Secure context: No*, you are on the wrong URL.
3. **A first pass enrols, it does not count.** All 97 seeded products ship with
   no barcode, so every scan opens the enroll screen. That measures the enroll
   flow's **20-second** budget, not the 20-minute one.
   **Changed 2026-07-30 — the old warning here is no longer true.** That screen
   used to only *create*, so a first pass produced duplicate products and the
   advice was to `docker:reset` between runs. It now opens on search and links
   the barcode to the product the catalog already has, which is the whole point
   of a first pass. Resetting between runs is now optional, and the thing to
   watch is the clock, not the duplicates.
4. **Accounts do not survive `docker:reset`.** Recreate with `bun run
   create-user`. There is no public signup, deliberately.

Local database state, **queried 2026-08-14** rather than remembered. Same volume
as the 2026-08-11 numbers that stood here; what moved, moved because the Phase 2
browser verification ran against it:

| | 2026-08-11 | **now (2026-08-14)** |
|---|---|---|
| Users | 1 — `owner@truestock.local` only | **3** — owner, manager, staff, all active |
| Counts | 4, all `closed` | **5** — 4 closed, **#5 `in_progress` since 2026-08-13** |
| Count lines | 8 | **13** |
| Ledger rows | 8, all distinct | **21**, all 21 `client_line_id`s distinct |
| Products | 101 (99 active) | **101** (99 active) |
| Costed products | 9 of 99 | **9 of 99** |
| `case_size` set | 0 | **0** |
| Barcodes | 4 | **4** |
| Locations | 6 | **6**, all active |
| Par levels | 0 | **0** |
| Vendors | 0 | **0** |

Three of those changes are worth knowing before you trust a screen:

- **`manager@truestock.local` and `staff@truestock.local` exist again**, created
  for Phase 2's role-gating browser checks. That closes the two checks the
  2026-08-12 notes listed as blocked on a missing account — the manager's
  cost-free DOM and the staff redirect off `/office/locations` both now run and
  pass. It also means the database no longer matches the "owner is the only
  account" sentence that used to stand here.
- **Count #5 is open.** The next phone pass does *not* have to start by opening
  one, and if you want a clean run you should close or ignore it deliberately
  rather than discover it mid-count.
- **Nothing about the data problem moved.** Still 9 of 99 costed, 0 case sizes,
  0 pars, 0 vendors. Every screen that needs those still degrades to its empty
  state, which is why two browser checks are permanent skips.

Two of the three newest products are test artifacts, not stock: product 100
`Testing A New Barcode Prod` and product 101 `Propane fuel`, both enrolled to
exercise the scanner. 101 has **no count line at all** — the enroll flow does
drop you on the entry screen (`count-leg.tsx:605`), so that is a test backing
out, not a defect. Set `active = false` on both when you want them gone;
invariant 6 says never hard-delete.

Four of those are the ones that bite:

- **Count #5 is already open.** The next pass does not start by opening one —
  the 2026-07-31 and 2026-08-11 notes both said the opposite, and both are now
  wrong. Decide deliberately whether to count into it or close it first.
- **0 pars** — the reorder list is *able* to produce rows as of 2026-07-30 and
  still won't until a par is set on something. Nothing is broken; nothing is
  configured.
- **0 vendors** — the write path and the `/office/vendors` screen both exist as
  of 2026-07-31, and `docs/catalog/vendors.csv` ships header-only on purpose
  (inventing supplier names would put fabricated business relationships in a
  catalog that drives real orders). Until the owner fills it in or adds one
  through the screen, every reorder row still groups under "No vendor set" — the
  same symptom as before #19 was closed, now with a cause that is one form away.
- **2 barcodes of 99 products** — a phone pass is still essentially all-enroll.

**All three roles now have an account** — `owner@truestock.local`,
`manager@truestock.local` and `staff@truestock.local`, created 2026-08-13/14 for
Phase 2's role-gating browser checks. The paragraph that stood here, saying the
owner was the only account left after the volume reset, is out of date. If a
password is not to hand, `bun run create-user` mints another — there is no public
signup, deliberately, so a forgotten password is a hard stop at the login screen
rather than a recoverable inconvenience. `verify:browser` reads `CHECK_EMAIL` /
`CHECK_PASSWORD` plus `CHECK_MANAGER_EMAIL` / `CHECK_MANAGER_PASSWORD` and
`CHECK_STAFF_*` from the gitignored `.env.local`; a missing pair **skips** the
role check rather than passing it.

Note there is no `delete-user` script — removing an account means SQL against
`session` then `account` then `user`, which is also why these accumulate. Same
for vendors, which have no delete path by design (invariant 6's spirit: history
references them).

## Next three things

Phase 2.5's A–E implementation is complete on its integration branch. The order
below separates repository closeout from field evidence and deployment; a green
suite proves the software contract, not the operating claims.

1. **Close Phase 2.5 into `main`.** PR #37 is open
   (`feat/phase-2.5-invoice-automation` → `main`, no conflicts). Before merging
   it, run the final branch-level review and ship gate. After merging, apply
   migrations `0004`–`0011` to every database, including the local dev volume.
   Phase F auto-approval stays deferred until about 100 real invoices provide
   correction data.
2. **Phase 2.9 — owner data and field validation.** Use real supplier invoices
   to populate the remaining costs, case sizes, pars, vendors and wine producer
   names; measure Phase 2.5's Gate 1 target with 20–25 real invoices in one
   under-30-minute sitting *(text PDFs — the scanned/Vision path is deferred
   past go-live, 2026-11-08)*. Then run the redesigned counting UI on
   the phone: enrollment pass, timed full count, all locations, rapid scan
   checked against a hand count, multi-write offline replay, and the four Phase
   2 UI bets in `docs/phone-count-test.md`. A 2026-08-21 query of the shared
   dev volume still had 9 of 99 active products costed, 0 case sizes,
   0 pars and 0 vendors; isolated Phase 2.5 verification stacks do not change
   that business data. **Start with the two things that would quietly corrupt the
   first real count.** First, prove the #46 queue fix on the phone: two or more
   queued writes, a correction arriving in the right order, falling over to
   mobile data, and the flush after the app is killed. Second, fix or accept the
   pre-count findings V1, A18, A20, DB-1 and DB-4. Then enter data through real
   invoices (add the 1 L product rows first, #47). (Vision with a real key is
   deferred past go-live, 2026-11-08.)
   The status of each item is in ROADMAP.md, Phase 2.9.
3. **Phase 3 — go-live.** Only after Phase 2.9. Start the real standalone
   artifact with `node .next/standalone/server.js`, exercise `pdf-inspector`
   from that artifact, run migrations `0000 → … → 0011` against production,
   verify the real SendGrid path, choose whether local pilot invoices migrate or
   are discarded, establish offsite backup, schedule the session sweep, rehearse
   rollback, and run `docs/go-live.md` against the real origin. Open item #39's
   audit-packet memory and stale-build limitations must be consciously accepted
   or fixed before production use.

**Local test-state caution.** The last recorded shared volume had three active
accounts (owner, manager and staff), count #5 open, four barcodes, and two test
products already deactivated rather than deleted. Check the database
rather than relying on that dated snapshot before the next phone run; isolated
worktree stacks used by Phase 2.5 do not establish the state of the shared dev
volume.

## Scope reminders

**In the MVP:** catalog, locations, barcode scan, tenths, quantities, count
sessions, valuation, reorder, three roles and tenant isolation.

**Built after the MVP in Phase 2.5:** secure invoice upload and retained local
files, text/vision extraction, human review, vendor matching, atomic cost
history, and a limited date-range ZIP of invoice files plus count snapshots.
This is the deliberate AI/file-storage exception in `AGENTS.md`.

**Still deliberately deferred:** AI fill estimation, bottle photos, Toast PMIX,
variance reporting, auto-approval until about 100 invoices provide correction
data, and the full Phase 6 compliance module. Phase 2.5's limited export does
not include the full month-end food/liquor reporting described for Phase 6.

**Multi-tenant, but not a complete commercial tenancy product:** `organization`
is the enforced data boundary and every query is scoped to it. Not built: users
in more than one organization, an organization switcher, billing, public signup
or per-tenant subdomains. Those remain additive work for the selling track.
