# Status: Phase 1 + Phase 1.5 — finish the MVP and make it survive daily use

Covers the buildable work in ROADMAP.md Phases 1 and 1.5 as **one planning
bundle**, because the items are small, independent, and share one set of
architectural decisions. Slices are the unit of work; each slice is one
ROADMAP item.

- Gate 1 — Product: APPROVED 2026-08-12
- Gate 2 — Architecture: APPROVED 2026-08-12 (including the three amendments — see 02's Amendments section)
- Gate 3 — Program Design: APPROVED 2026-08-12
- Gate 4 — Slice plan: APPROVED 2026-08-12

## Slices
- [x] Slice 1 — tracer bullet: `/office/locations` renders the seeded locations read-only, nav link included — `00bfb8f`
- [x] Slice 2 — locations create/rename/`count_mode`, with migration `0003` adding `location.active` — `ae9d7d5` (migration) + `d27ef2e`
- [x] Slice 3 — locations deactivate + the guards (last-active-location, in-use-by-open-count) — `891cbce`
- [x] Slice 4 — inline cost + case-size editing in the catalog table (Phase 1.2) — `1e756ce`
- [x] Slice 5 — dashboard aggregate reads (#14) — `3d8a347`
- [x] Slice 6 — reorder output: copy + print per vendor — `a8c5e50`
- [x] Slice 7 — the two script/dev-env guards (#23, #24) and the session-sweep query (#1b) — `9f81967`
- [x] Post-review fix — refuse count-line writes into a retired location — `ed5580b`

**Built and machine-verified 2026-08-12**: `bun run lint`, `bun run typecheck`,
`bun run build` and `bun run test:docker` (163 pass / 0 fail, 533 assertions,
15 files) all confirmed by the orchestrator independently, not only by the
agents that wrote the code. **Browser proof is still owed** — see below.

## Notes for a fresh session

**The security review found one real high-severity gap, and it is the exact
risk Gate 2 named — approached from the side nobody planned for.** Decision 5
protected the *read* side: `listLocationsAction` excludes retired locations, so
a retired location vanishes from the picker on a fresh fetch. But the scan
screen fetches locations **once**, at page load, and `CountLeg` holds them as a
static prop — which is correct, because AGENTS.md deliberately locks the active
location per leg. So a counter who had already loaded a location and not yet
scanned into it kept a live, writable handle on it. `deactivateLocation`'s
open-count guard structurally cannot see that client: there are no
`count_line` rows yet, so retirement succeeds and every subsequent scan lands
in a retired location with no error anywhere. Fixed in `ed5580b`:
`upsertCountLineRow` now checks `location.active`, and the check sits **above**
the existing-line lookup so it runs on every write, not only on the insert
branch. Four tests cover it, one mutation-checked, plus a still-active negative
control.

The durable lesson, worth remembering beyond this feature: **excluding a row
from a list is not the same as refusing a write to it.** Any future
"deactivate" affordance needs both halves.

## Browser verification, 2026-08-12 — 34/34, no skips

Final state: **every check runs and passes, nothing is skipped.** A manager and
a staff account now exist (3 users), which closed the last two gaps.

**The two role-gating checks, which are the ones that needed a browser at all:**

- **A manager's catalog has no cost column anywhere in the DOM** — 0 cost
  inputs, 0 cost column headers, and the string `Unit cost for` does not appear
  in the served HTML. That last part is the point: the action-layer tests prove
  the *payload* omits cost, but only the DOM can distinguish "never sent" from
  "sent and hidden with CSS", and the second is a leak.
- **A manager CAN still edit case size — 16 inputs**, the positive control.
  Without it the check above would pass just as happily against a page that
  failed to render a table. And 16 is exactly right: only the 16 bottled beers
  carry a `case_size`, so this incidentally confirms the catalog rule that a
  NULL case size on the 62 spirits is correct data rather than missing data.
- **Staff are redirected off `/office/locations`** — landed on `/count` — and
  see **0** links to it.

Each role signs in in its own browser context, so no cookie leaks between
roles.

## Earlier snapshot: 28/28

`bun run verify:browser` against a real Chrome with a real owner session,
`next dev` in Docker. Every check below failed at least once during
development, so none of them is vacuous.

| What | Result |
|---|---|
| Locations server-rendered, React attached, nav link | pass |
| Create a location → visible immediately | **0 document loads** |
| The edit form is editing the row that was clicked | pass (see the finding below) |
| Rename + `count_mode` survive a reload | pass |
| Retire → row stays listed, marked Retired | pass |
| `scan/page.tsx` untouched in `main...HEAD` (Decision 5) | pass |
| Catalog health tile vs `SELECT COUNT(*)` | **tile 99 = db 99** |
| 4 cost cells saved (Amendment 2) | **0 document loads** |
| Cell settles on the server's value | typed `007.5` → `7.5000` |
| Clipboard is dated and itemised | `Count #4 · Aug 12, 2026`, qty 5 |
| Print applies the scope classes before printing | pass |
| Print CSS shows only the target block | target visible, **sibling hidden** |
| CSP violations / console errors | none |

Three of those deserve a note on *why* they are worth trusting:

- **"0 document loads" is measured, not eyeballed.** A `window` marker that a
  hard navigation would destroy, plus a count of Next's `_rsc` requests. The
  create path does exactly one soft `router.refresh()`; the cost cells do
  none, which is Amendment 2's whole claim.
- **The dashboard is compared against a direct SQL count.** Comparing it to a
  number the page produced would be circular — `#14` *was* a page counting its
  own truncated array.
- **The print-scoping check was hollow at first** and was fixed rather than
  accepted. With only one vendor group on screen, "shows *only* the target"
  passed with `sibling=n/a` — an assertion that could not fail. A second
  vendor group was fixtured in, and the sibling then computed to
  `visibility: hidden` under print media. Same rule as the test suite: a check
  that cannot fail proves nothing.

Fixtures were created for the two data-dependent checks (a par level, a
vendor, a product→vendor link) because the dev catalog has none, and all of
them were removed afterwards. Verified back to the original state: 0 par rows,
0 vendors, 9 costed products, 6 locations all active.

**Reproducing a full 34/34 from a cold clone** needs three things the dev
database does not have by default, and the harness reports each as SKIPPED
rather than passing when they are missing:

1. A manager and a staff account (`bun run create-user`), plus their
   credentials in `.env.local`.
2. At least one vendor, for the `/office/vendors` Edit check.
3. A par level on a product that appears in a closed count, for the reorder
   copy/print checks — without one the reorder screen cannot produce a row at
   all, and says so in its own empty state.

Items 2 and 3 are created by hand and torn down again around a verification
run; **do not leave them in the database**, because a par level and a vendor
that nobody chose are exactly the plausible-but-wrong data this project keeps
warning about. Verified back to baseline after each run: 0 par rows, 0 vendors,
9 costed products, 6 active locations.

The account credentials go in `.env.local` as:

```
CHECK_MANAGER_EMAIL=…      CHECK_MANAGER_PASSWORD=…
CHECK_STAFF_EMAIL=…        CHECK_STAFF_PASSWORD=…
```

Each role signs in in its own browser context so no cookie leaks between
roles. The manager check searches the **served HTML** for `Unit cost for`, not
just the rendered widgets — a cost column that is rendered and then hidden is
a leak the action-layer tests structurally cannot see, because the value was in
the payload all along. It carries a positive control (a manager *can* still
edit case size), without which the check would also pass against a page that
failed to render a table at all.

Both are also covered at the action layer in `tests/catalog-write-path.test.ts`
and `tests/location-write-path.test.ts`; the browser adds the DOM half.

Two harness bugs were fixed along the way, both worth remembering because both
reported the wrong cause: it filled the login form before React attached, so
Better Auth answered `INVALID_EMAIL` for a valid address; and a
`.catch(() => {})` around a click on a button whose label had been guessed
turned that miss into a `page.fill` timeout 40 lines later.

### Finding: the locations edit affordance is invisible and unlabelled

Not a slice bug — the slice works — but it nearly caused real damage during
verification and should be fixed before the owner touches this screen.

Editing a location is done by clicking **the row itself**. That row is a `<tr>`
with an `onClick`, `tabIndex: -1`, no `role`, and no `aria-label`. Three
consequences:

1. **Keyboard and screen-reader users cannot edit a location at all.** Every
   other action on the screen is a real `<button>`; this one is not.
2. **Nothing on screen says the row is clickable.** There is a visible RETIRE
   button and no EDIT button, so the affordance is discoverable only by
   hovering and noticing the cursor change.
3. **The edit form does not name the location it is editing.** Its heading is
   the generic "EDIT LOCATION". Because the whole row is the target and rows
   reflow when the inline form opens and closes, a click aimed at one row
   landed on **Speed Rail** during this run and prefilled its name — one more
   click would have renamed the bar's real speed rail and flipped its count
   mode to `quantity`. Nothing on screen would have looked wrong afterwards,
   which is this project's signature failure mode (see invariant 10's preamble
   and the locked-active-location rationale). It was caught only by reading the
   form's prefilled value before typing.

Smallest fix that closes all three: a real `<button>` labelled Edit in the row,
and the location's name in the form heading so the form states its own subject.

**Browser proof is now automated: `bun run verify:browser`.** It reads
`CHECK_EMAIL` / `CHECK_PASSWORD` from the gitignored `.env.local` via Node's
own `--env-file`, and drives the Chrome already installed on the machine
(`channel: "chrome"` — Playwright's own browser is deliberately not
downloaded). It restores every value it overwrites and deletes every row it
creates. Results above.

Two limits to keep in mind when reading a green run:
- It runs against `next dev`. The CSP failure that shipped in this project was
  a *production* config problem, so a clean CSP result here is not a
  production result. `bun run docker:up:prod` is the path that tests it.
- A green run does not cover the manager and staff DOM checks; see above.

**One pre-existing bug found while proving `#24`, not caused by this bundle.**
On Docker Compose v2.23.0, `bun run docker:down` does **not** stop the
`truestock-tls` container that `--profile tls up` starts, so a LAN session is
not fully torn down and the new `docker:up` guard keeps (correctly) refusing.
Clearing it today needs `docker compose --profile tls down`. That is a gap in
`docker:down`/`dev-lan.sh`'s own teardown, and belongs in `docs/open-items.md`.

**All four gates were approved on 2026-08-12.** Gate 2's approval explicitly
covers its three amendments; they were not deferred, because each one *removes*
scope rather than adding it (a dashboard tile that does not exist, a
refresh-per-cell-edit, and a gitignored LAN state file). Gates 3 and 4 were
written against the amended Gate 2, so the three docs are already consistent —
do not "re-apply" the amendments.

**Implementation is delegated to subagents, not done in the orchestrator's
context**, at the user's instruction. Every slice ends in `bun run lint`,
`bun run typecheck`, `bun run build`, and `bun run test:docker` — a slice that
does not pass all four is not done. Browser proof stays with a human: no agent
can satisfy AGENTS.md's "verify UI work in a browser" rule, and **a 200 is not
evidence**.

**The 20-minute count test is Phase 1.9's, confirmed at Gate 1 approval.**
`ROADMAP.md` already carries this: Phase 1's exit criterion is "locations are
manageable from the app, the catalog is costed, and a count produces a valuation
and a reorder list worth acting on", with a blockquote recording that the
sub-20-minute target moved to Phase 1.9 and became *its* exit criterion. Phase 1
can therefore close without it. Do not re-import that measurement into any slice
here.

**Scope boundary.** ROADMAP 1.3 ("data entry — not construction": 90 unit
costs, 16 case sizes, par levels, vendors, 5 wine producers) is **the owner's
data entry, not this bundle's code**. Slice 4 is what makes it survivable.
Phase 1 cannot be *closed* until that data is entered, and no agent can close
it.

**#1b is deliberately half-built here.** The sweep query and script belong to
this bundle; the *cron that runs it* can only be created against Hostinger,
which is Phase 3. Build it here, schedule it there. Do not treat the missing
cron as an incomplete slice.

**Facts established by recon on 2026-08-11** — three of them contradicted the
ROADMAP's own description and are load-bearing for the plan:

1. `location` has **no `active` column** (`db/schema.ts:333-362`). "Deactivate,
   never delete" therefore requires a new migration, which the ROADMAP text did
   not anticipate.
2. **There is no TanStack Table.** `@tanstack/react-table` is in
   `package.json:35` with zero imports repo-wide.
   `components/office/catalog-table.tsx` is a hand-rolled `<table>` over
   `products.map()` with a manual `Set<number>` for selection. The ROADMAP's
   "reusing the selection and bulk-bar machinery already there" is still correct
   — that machinery just isn't a library.
3. `assignVendorToProducts` (`lib/domain/catalog.ts:954-999`) is a transaction
   of exactly two statements — one batched ownership `SELECT ... IN`, one
   `UPDATE ... IN` — so it sets **one value across many rows**. Per-row cost
   entry cannot reuse its write shape, only its ownership check.

**There are no component tests and no DOM test environment** (no
testing-library, no jsdom/happy-dom, zero `.test.tsx`). Every test in this
bundle is a domain/action integration test against real MariaDB
(`tests/*.test.ts`, `bun run test:docker`). UI correctness is proven in a
browser, per AGENTS.md — **a 200 is not evidence**.
