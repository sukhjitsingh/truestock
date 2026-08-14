# Truestock — current state

Where the project actually is. Updated 2026-08-14.

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

**MVP is built and not deployed, and as of 2026-08-12 every part of the
counting loop has now run on a real phone** — scan, enrol, tenths, sealed
quantities, valuation, and the offline queue, the last three under the
production CSP. The sentence that stood here since this file was written —
*"the counting app, the actual product, has never been used by a human"* — is
not just false now, it is comprehensively so.

**What has NOT happened is a count.** Four sessions, 8 lines between them. Every
mechanism is proven and nothing has been measured: no timed pass, no full
five-location walk, 90 of 101 products unpriced. The project moved from "does it
work at all" to "does it work at scale" in one day, and this file should not be
read as saying more than that.

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

| Area | Evidence |
|---|---|
| **Schema + migrations** | Chain `0000 → 0001 → 0002` applied to MariaDB 11.8 in Docker. Composite tenant FKs reject cross-tenant ids (1452), `product_par` blocks a second overall par (1062), `DECIMAL(10,4)` exact, accented names round-trip |
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
| **Seed CSV parser** | `tests/seed-csv-parser.test.ts` — the pure parser, moved to `db/csv.ts` so this test never has to import the seed's own entry-point module (see Recent history, 2026-07-31) |
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

**210 tests across 21 files**, all green — **re-run 2026-08-14 against MariaDB
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
- **The counting app on a phone, AT SCALE.** Scan, tenths, sealed quantities,
  scan-to-enroll and the locked-location leg have each now run on a handset
  (2026-08-12) — so this entry is no longer "does it work" but "does it hold
  up". Nothing here has been done more than a few times in a row: the longest
  session recorded **4 lines**, no pass has covered all five locations, and
  nothing has been timed. Fatigue, a wrong tap at bottle 80, a leg switch made
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
  Two narrower gaps survive from the queue and are worth keeping visible: the
  **mount-time flush** has never run (only the `online` listener was observed),
  and the queue has never held **more than one write at a time**, so ordered
  replay of several writes to the same line is still only reasoned about.
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

**Re-sequenced 2026-08-12 by owner decision — see `ROADMAP.md`.** The three
items that stood here (a timed count, rapid mode against a camera, and the
standalone entrypoint) are all **measurement**, and all three were deliberately
deferred to the field-validation phase — **which moved again on 2026-08-13, from
1.9 to 2.9**, so it now sits after the UI redesign and OCR invoice automation
rather than before them. They are not abandoned and nothing about their risk has
changed; they are simply not next. The new order also moves
go-live to **Phase 3**, behind a UI redesign (Phase 2) and OCR invoice
automation (Phase 2.5).

**Both of Phase 1's remaining construction items shipped on 2026-08-12** — the
locations screen and inline cost entry — so what is next is no longer code.
Their original entries are kept at the bottom of this section for the record.

`owner@truestock.local` is the **only** account in the database — have its
password or run `bun run create-user` before walking anywhere. Two browser
checks are blocked on that: a manager's DOM must not contain the cost column,
and staff must be redirected off `/office/locations`. Both are covered at the
action layer by the test suite; only the browser half is missing, and
`bun run verify:browser` prints them as NOT VERIFIED on every run so they
cannot pass silently.

The stack is currently in **dev mode** (`next dev` in the app container, HMR
connected). `bun run docker:up:prod` is the production-mode path, which has no
hot reload and accepts sign-in **only on the https origin** — and it is the only
way to test the CSP behaviour that broke this project once, because that failure
was a production config problem. A clean CSP result under `next dev` is not a
production result.

**Phase 2 closed 2026-08-14 (PR #13), so Phase 2.5 is next.** Phase 1 closed
2026-08-12; the owner's data entry moved out of it into **Phase 2.9**, together
with the measurements it was always coupled to. See `ROADMAP.md`.

1. **Phase 2.5 — OCR invoice automation.** Costs come from supplier invoices,
   and this is the automated version of typing 90 of them, so it is also what
   shrinks Phase 2.9's data-entry burden. Build it in the order set out in
   `docs/invoice-automation-research.md`; a Gate 1 PRD is drafted on the
   `feat/phase-2.5-invoice-automation` branch and is **not on `main` yet** —
   check that branch before re-deriving one. **This is the first phase that is
   allowed AI and file storage** — `AGENTS.md` says invoice automation "reverses
   two exclusions above", and it is the only thing that does. Settle the
   xtraCHEF question before building (one hour of testing decides how much needs
   building at all); the 2.5 branch's PRD records it as already settled in favour
   of building the OCR pipeline, so reconcile the two rather than assume either.
2. **Phase 2.9 — the data and the measurements, together.** 90 unit costs, 16 case
   sizes, par levels, vendors, 5 wine producers; then the timed count, the
   five-location walk, and rapid mode against a real camera. They were merged
   because a timed count against an uncosted catalog measures the wrong thing:
   the reorder list cannot produce a row and valuation stays near-empty, so "are
   the numbers worth acting on" is unanswerable until the data exists. Re-checked
   2026-08-14: 9 of 99 active products costed, 0 with a `case_size`, 0 par rows,
   0 vendors — unmoved since 2026-08-12.
   **Phase 2 added to this phase's job rather than subtracting from it.** The
   whole redesigned counting surface is new since anyone last held a phone, and
   Phase 2 wrote down four explicit bets about where count time goes — they are
   now §6 of `docs/phone-count-test.md`, and settling them is part of Run A and
   Run B, not a separate exercise.
3. **Phase 3 — go-live.** Behind both of the above. The two items on it that are
   pure code and still open are the **standalone entrypoint**
   (`node .next/standalone/server.js` has never been started, whatever
   `585d2b6`'s commit message says) and the deploy pipeline, which is built and
   has never run against a real host. `docs/go-live.md` is the gate.

**No open items remain from Phases 1 and 1.5.** Items 25 and 26, both found while
verifying, were fixed 2026-08-12 and are closed in `docs/open-items.md`. Phase 2
opened three new ones, none of them urgent and none of them a correctness risk:
**#28**, the owed `--chart-2..5` palette, not due until the first chart is drawn
in Phase 4; **#29**, the accessibility floor asserted on `/office/catalog` only
when Gate 1 asked for every screen; and **#30**, three table surfaces that never
moved onto the shared primitives (`users-list.tsx` is the one that matters — no
`scope="col"` on any header). #29 and #30 are the two Gate 1 criteria that came
out **partial** when the phase was audited against its own contract; see
`docs/plans/phase-2-ui-redesign/00-status.md` for that audit.

The entry that used to stand first here, now done:

1. ~~**Phase 2 — the UI redesign.**~~ Shipped 2026-08-14. It was designed from
   judgement rather than from measurements, exactly as this section warned, and
   the mitigation held: no schema, no write path, no leg-model change, and the
   judgement calls written down as bets for 2.9 to settle.

The two entries that used to stand here, both now done:

1. ~~**A locations management screen** (`/office/locations`).~~ Shipped
   2026-08-12. `lib/domain/catalog.ts`
   has `listLocations` and nothing else — no create, no update, no route. This
   already cost real time on 2026-08-12: adding `Tap 1` so kegs could be counted
   at all took a CSV edit plus SQL against the live database. `location.count_mode`
   is what decides whether a product gets the fill pad or a quantity stepper, and
   it is unreachable from the app.
2. ~~**Bulk cost and case-size entry.**~~ Shipped 2026-08-12 as per-cell inline
   editing. The fields already exist on
   `product-edit-form.tsx` and are correctly role-gated; what is missing is
   throughput. 90 unit costs today means 90 separate page loads. Inline-editable
   columns in `catalog-table.tsx`, reusing the bulk-bar machinery the vendor work
   already built.

   One decision from building it is worth carrying forward: the cells
   deliberately do **not** refresh the page after each save. A
   `router.refresh()` per commit is ~180 round trips against a 45-minute,
   90-cost budget, so only the edited row is patched — from the value the action
   *returned*, not the value typed, so a manager's role-stripped cost visibly
   snaps back. The accepted cost is that the "needs attention" pills and the
   catalog-health counts lag until the next navigation. That is a tradeoff, not
   a bug; do not "fix" it with cross-row recomputation.

**#19 (vendors have no write path) is done** as of 2026-07-31, so the reorder
list can group by vendor rather than dumping everything under "No vendor set" —
what it still lacks is par levels and costs to make the rows worth ordering from,
and any way to *send* the list, which is now a Phase 1.5 item.

## Scope reminders

**In the MVP:** catalog, locations, barcode scan, tenths, quantities, count
sessions, valuation, reorder, three roles, multi-tenancy.

**Deliberately out:** AI fill estimation, bottle photos, invoice OCR, Toast PMIX
import, variance reporting, compliance packet. **The MVP contains no AI and no
file storage** — if a task seems to need either, it is probably scope creep.

**One exception, and only one: Phase 2.5.** Invoice OCR is out of the *MVP* and
is the *next phase*, which reads as a contradiction and is not one — 2.5 is the
phase that deliberately reverses the no-AI and no-file-storage exclusions, per
`AGENTS.md`. Nothing else may reach for either on the strength of that.

**Multi-tenant, but not multi-tenant yet:** `organization` is the tenant boundary
and every query is scoped to it. Not built: users in more than one org, an org
switcher, billing, signup, per-tenant subdomains. All additive.
