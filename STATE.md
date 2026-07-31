# Truestock — current state

Where the project actually is. Updated 2026-07-31.

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

**MVP is built and not deployed — and as of 2026-07-31 a human has counted
with it.** The sentence that stood here since this file was written — *"the
counting app, the actual product, has never been used by a human"* — is finally
false.

On 2026-07-31 the owner signed in on a phone over the LAN https origin, scanned
a barcode the catalog did not have, created the product through scan-to-enroll,
recorded a quantity, and closed the count. Confirmed in the database rather than
reported: product 99 (`Smirnoff`, 200 ml, Spirits) created 19:01:30, barcode
`08200802` enrolled `each`/primary, count line written 19:01:54 as **18 eaches,
0 cases**, count `closed` 19:04:29. The `count_line_write` ledger holds 4 rows
with 4 distinct `client_line_id`s — no duplicate write, idempotency intact.

**Three things proved themselves on real hardware in that one pass**, none of
which any test in this repo can exercise: the camera and decoder opened and read
a real barcode (the "last inch" that had never happened on any device); 200 ml
came from the size preset list rather than a typed number; and a spirit was
recorded with no Cases stepper, which is the 2026-07-31 beer-only-cases rule
behaving correctly outside a browser harness.

**What this does NOT prove, and the distinction is the whole point of this
file.** One product is not a count. Untested still: the sub-20-minute target
(nothing was timed), the offline queue (WiFi never dropped, never went into the
walk-in), open-bottle tenths (only sealed quantities were entered), the locked
location leg across all five sections, and valuation — every line is unpriced,
so the count closed at a `total_value` of 0.00. This is the first successful
transaction, not a first real count.

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

**94 tests across 7 files**, all green, as of 2026-07-31 — `bun run
test:docker` against MariaDB 11.8 in Docker, 381 assertions, 0 failures. The 16
in `tests/bottle-sizes.test.ts` are all 2026-07-30: 15 for the preset lists
themselves, plus 1 more from the review fix below that replaced a pinned
`58674` assertion with one computed from the catalog. `tests/vendor-write-path.test.ts`
and `tests/seed-csv-parser.test.ts` landed 2026-07-31 with the vendor work,
bringing the file count from 5 to 7. The 73 that existed before those two files
are unchanged, so nothing was modified or disabled to get there.

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

- **The counting app on a phone.** Scan, tenths, sealed quantities, scan-to-enroll,
  the locked-location leg. This is the product, and it is the biggest unknown.
  The environment around it is now built and largely verified (see below); what
  has never happened is a human counting bottles with it.
- **The camera, on any real device.** The LAN HTTPS path was built precisely so
  the camera can exist at all, and everything testable from a terminal passes —
  certificate SAN, a 200 over TLS, client chunks served, Server Actions
  surviving the proxy's `Host` rewrite, sign-in trusted from the https origin
  and refused from a foreign one. **What is unverified is the last inch:**
  accepting the certificate warning on the handset and `getUserMedia` actually
  opening a lens. No camera has been opened by this project yet, on any device.
- **Everything added to the counting leg on 2026-07-30.** Four changes, all UI,
  none of them covered by a test and none of them driven on a device: the
  search-first barcode-link screen (which added a step to a path held to a
  20-second budget, so it wants timing specifically), the fill-correction mode,
  the optimistic rollback on a refused write, and the message naming a dropped
  queued write. Listed with how to exercise each as open-item #20.
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
- **The offline write queue** (`lib/count-queue.ts`). Reasoned about only. It was
  already wrong once — the original had no drain path at all — and 2026-07-30
  changed its rejection behaviour, so a permanently-refused write now leaves the
  queue instead of jamming it. That makes exercising it more worthwhile, not less.
- **The production CSP.** Dev proves the nonce mechanism; production is a
  different, stricter policy that has never run.
- **Concurrency.** The gap-lock deadlock and `withLockRetry` were reproduced by
  hand against MySQL — never against MariaDB, never as a test.
- **Valuation against real costs.** 88 of 97 products are unpriced.
- **The deploy pipeline.** Built, never run against a real host.

## Recent history

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

Everything needed to run it is built and committed. Nothing has been run.

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

Local database state, queried 2026-07-31 rather than remembered: draft count #1
open, 5 locations, 98 products, **1 barcode**, **0 par levels**, **0 vendors**,
0 products carrying a vendor.

Three of those numbers are the ones that bite:

- **0 pars** — the reorder list is *able* to produce rows as of 2026-07-30 and
  still won't until a par is set on something. Nothing is broken; nothing is
  configured.
- **0 vendors** — the write path and the `/office/vendors` screen both exist as
  of 2026-07-31, and `docs/catalog/vendors.csv` ships header-only on purpose
  (inventing supplier names would put fabricated business relationships in a
  catalog that drives real orders). Until the owner fills it in or adds one
  through the screen, every reorder row still groups under "No vendor set" — the
  same symptom as before #19 was closed, now with a cause that is one form away.
- **1 barcode** — a single enrolment survives from a browser session. A first
  phone pass is still essentially all-enroll.

Throwaway owner accounts left from browser checks: `tester@truestock.local` and
`browsercheck@truestock.local`. Delete them or reset the volume. The real seeded
accounts are `owner@truestock.local` and `manager@truestock.local`.

Note there is no `delete-user` script — removing an account means SQL against
`session` then `account` then `user`, which is also why these accumulate. Same
for vendors, which have no delete path by design (invariant 6's spirit: history
references them).

## Next three things

Unchanged by the 2026-07-30 work, and that is the point: closing the code gaps
removed the reasons a phone test would have dead-ended, it did not substitute
for one. Protocol for 1 and 2: **`docs/phone-count-test.md`**. Start at
`/count/preflight` on the phone.

1. **Drive a real count on a phone.** Time it against the sub-20-minute target the
   whole design is justified by. A *first* pass enrols rather than counts — every
   barcode is unknown — so it measures the enroll flow's 20-second budget, not
   the 20-minute one. Fold in open-item #20's six checks while you are in there;
   they exercise the same screens — and two of the six only exist because the
   2026-07-30 size and case work changed those screens again afterwards.
2. **Exercise the offline queue for real** — turn the WiFi off mid-scan, and go
   into the walk-in.
3. **Verify the production CSP** with `next build && next start` before any deploy.

After those, the shortest path to a genuinely useful reorder list is real
costs and pars (open item #4) — **#19 (vendors have no write path) is done**
as of 2026-07-31, so the list can now group by vendor instead of dumping
everything under "No vendor set". What is still missing is the par levels and
costs to make the rows worth ordering from.

## Scope reminders

**In the MVP:** catalog, locations, barcode scan, tenths, quantities, count
sessions, valuation, reorder, three roles, multi-tenancy.

**Deliberately out:** AI fill estimation, bottle photos, invoice OCR, Toast PMIX
import, variance reporting, compliance packet. **The MVP contains no AI and no
file storage** — if a task seems to need either, it is probably scope creep.

**Multi-tenant, but not multi-tenant yet:** `organization` is the tenant boundary
and every query is scoped to it. Not built: users in more than one org, an org
switcher, billing, signup, per-tenant subdomains. All additive.
