# Gate 4 — Vertical Slices: finish the MVP, then make it survive daily use

Seven slices, in build order, matching `00-status.md`. Each slice ends in a
working, testable state. **Banned: horizontal building** — no slice below
touches "all of the schema, then all of the domain layer, then all of the
UI" with nothing runnable until the end. Slice 1 does almost nothing and is
provable in a browser; every later slice adds exactly one capability.

---

**Slice 1 — `/office/locations` tracer bullet.**
Delivers: the route exists, is in the nav, and renders the five seeded
locations read-only via the *existing, unchanged* `listLocationsAction()`.
No new domain code, no migration.
Proven by: browser — sign in as owner or manager, click "Locations" in the
office nav, see the five seeded locations listed (name, count mode, sort
order). Sign in as staff, confirm no "Locations" link appears and the URL
redirects to `/count`.
Not in it: create, edit, retire, the `active` column, any new server
action.

---

**Slice 2 — locations CRUD + migration 0003.**
Delivers: `location.active` exists in the database; a location can be
created and renamed/re-moded from the app; the management screen shows
active and retired locations (none retired yet, since deactivate doesn't
exist until slice 3).
Proven by: `bun run test:docker` — `tests/location-write-path.test.ts`'s
`createLocation`/`updateLocation`/`listLocations` describes all pass, freshly
written, against a real MariaDB running the new migration. Then browser:
add a location named "Patio Bar," confirm it appears immediately without a
manual refresh; rename it; change its count mode; reload the page and
confirm the change persisted.
Not in it: retiring a location, the last-active-location guard, the
open-count guard (both land in slice 3 — `updateLocation`'s count-mode-change
guard ships here per Gate 2 Decision 3, but is *unexercised* until a count
with lines exists to test it against, which slice 2's tests cover directly
against the domain function even though there is no UI path yet to trigger
an open count from `/office/locations` itself).

---

**Slice 3 — locations deactivate + guards.**
Delivers: the "Retire" control, the last-active-location refusal, and the
in-use-by-open-count refusal, each with an inline message.
Proven by: `bun run test:docker` — the new `deactivateLocation` describes in
`tests/location-write-path.test.ts`, including both mutation-checked guard
tests. Then browser, three checks: (1) retire a location with no open
lines — it disappears from the active picker on `/count` but stays visible
(marked retired) on `/office/locations`; (2) try to retire the org's last
active location — see the refusal message, nothing changes; (3) open a
count, scan into a location, try to retire that location mid-count — see
the refusal message naming the open count.
Not in it: any change to `app/(count)/count/[countId]/scan/page.tsx` — it
keeps consuming `listLocationsAction()` unchanged and should visibly keep
excluding the just-retired location without a single line of scan-page code
touched (Decision 5's whole point; this is the browser check that proves
Risk 1 didn't happen).

---

**Slice 4 — inline cost + case-size editing in the catalog table.**
Delivers: cost (owner) and case-size (owner+manager) cells editable in
place in the catalog table, saving one cell at a time.
Proven by: `bun run test:docker` — the new `describe("inline cost/case-size
editing…")` block in `tests/catalog-write-path.test.ts`. Then browser, timed:
as the owner, open `/office/catalog`, edit cost and case-size cells for at
least 10 products in a row. Confirm each cell shows its own saved state (its
own focus/dirty/saving/saved/error cycle) with **no full-page reload between
edits** — check the network tab: only `updateProductAction` POSTs, no
navigation entries (Amendment 2, 2026-08-12: no `router.refresh()` per
cell). Confirm the cell's displayed value is the server's **returned**
value, not the locally-typed one — type an edge-case value (e.g. leading
zeros) and confirm the cell settles on the server's normalized value.
Confirm the "Needs attention" pills and dashboard-adjacent counts do **not**
update between individual cell saves — they are expected to lag until the
next navigation or explicit refresh, the accepted tradeoff Amendment 2 makes
for staying under Gate 1's 45-minute, 90-cost budget. Separately, sign in as
a manager: confirm the cost column is entirely absent from the DOM (not
disabled — open devtools and check), and that the case-size cell for a
bottled beer *is* editable.
Not in it: a bulk/batch cost endpoint, CSV import, any change to
`updateProductAction` or `productUpdateSchema` (Decision 7 — this slice is
UI-only).

---

**Slice 5 — dashboard aggregate reads (`#14`).**
Delivers: `getCatalogHealth` (active count and owner-gated unpriced count
only — no `incompleteCount`, Amendment 1) and `getLastClosedCount`, and the
dashboard wired to them in place of THREE capped/50-row reads
(`searchProductsAction`, `listCountsAction`, `countSummaryAction`) dropped
from the page entirely — removing those three is the actual fix for `#14`,
not merely adding two uncapped calls (Amendment 4b).
Proven by: `bun run test:docker` — `tests/catalog-health.test.ts` and
`tests/reports-write-path.test.ts`, especially the 101-active-products test
(run it once against the old dashboard code path first and watch it read
100, to see the bug this closes, per Gate 1's success metric #2 — "the
dashboard's product count reads 99 active with 101 rows in the catalog").
Then browser: with the seed's 97 products plus a few more added in slice 2's
testing, confirm the "Catalog health" tile's count matches
`SELECT COUNT(*) FROM product WHERE active = 1` run by hand.
Not in it: pagination anywhere else in the catalog UI; the reorder tile
(already correct, Decision 11, untouched).

---

**Slice 6 — reorder output: copy + print.**
Delivers: a per-vendor Copy button (clipboard) and Print button on
`/office/reorder`, each labeled with the as-of count id and close date
(`asOfCountId` / `asOfClosedAt` — the latter a Gate 3 addition accepted as
Amendment 4a).
Proven by: `bun run test:docker` — `tests/reorder-format.test.ts` (pure,
no database). Then browser: on `/office/reorder`, click Copy on a vendor
group, paste into a text field, confirm the pasted text has the vendor
name, the as-of date, and one line per item with a quantity; click Print,
confirm only that vendor's block appears in the print preview (not the
whole page).
Not in it: emailing or texting the list (explicitly out of Gate 1's
bundle); any new server action (Decision 9 — both buttons are client-side
only, against data the page already fetched).

---

**Slice 7 — the two script/dev-env guards (`#23`, `#24`) and the
session-sweep query (`#1b`).** Three independent, low-risk changes bundled
because none touches `app/` and none depends on the others.
Delivers:
  - `#23`: `scripts/create-user.ts` refuses to run `main()` when imported.
  - `#24`: `bun run docker:up` refuses when a LAN session (dev or prod)
    looks live, naming the fix — determined by inspecting the running
    container directly, no state file (Amendment 3, 2026-08-12).
  - `#1b`: `sweepExpiredSessions` exists and is invocable via
    `bun run sweep-sessions`; no cron yet (Phase 3).
Proven by:
  - `#23`: import `scripts/create-user.ts` from a scratch file (or from
    `tests/location-write-path.test.ts` temporarily) and confirm no password
    prompt and no database write occurs — mirrors how `db/seed.ts`'s
    existing guard would be proven, since neither has an automated test.
  - `#24`: manual — start a LAN session (`bun run docker:up:lan`), then in
    another shell run `bun run docker:up` and watch it refuse, naming
    `docker:up:lan` (not a state file — Amendment 3, 2026-08-12) and `bun
    run docker:down` as the fix; then run `bun run docker:down` followed by
    `bun run docker:up` and confirm it now succeeds normally.
  - `#1b`: `bun run test:docker` — `tests/session-sweep.test.ts`, including
    the mutation-checked batch-limit test. Then manually:
    `bun run sweep-sessions` against the dev database and confirm the row
    count in `session` drops by exactly the number of already-expired rows.
Not in it: the cron itself (Hostinger doesn't exist yet — Phase 3, per
`00-status.md`'s explicit note not to treat this as an incomplete slice).
