# Gate 2 — Architecture: finish the MVP, then make it survive daily use

Scope: the 7 slices in `00-status.md`. Read first: `01-product.md` (APPROVED),
`AGENTS.md` invariants 1–11, and the recon at
`/private/tmp/claude-501/-Users-moni-Claude-Workspace-truestock/ef0643ca-89a4-4a87-a3b6-17ab6eaeed5f/scratchpad/recon-catalog-bulk.md`.

---

## Fit

| Slice | Touches |
|---|---|
| 1 — `/office/locations` tracer bullet | `components/office/office-nav.tsx:22-27` (new link); new page `app/(office)/office/locations/page.tsx`; existing `listLocationsAction` (`app/actions/catalog.ts:126-131`) |
| 2 — locations CRUD + migration 0003 | `db/schema.ts:333-362` (`location`, new `active` column); new `drizzle/0003_*.sql`; `lib/domain/catalog.ts` (new `createLocation`/`updateLocation`, extended `listLocations`); `lib/validation/catalog.ts` (new location schemas); `app/actions/catalog.ts` (new actions); new `components/office/locations-table.tsx` (mirrors `components/office/vendors-list.tsx` + `vendor-edit-form.tsx`) |
| 3 — locations deactivate + guards | Same `lib/domain/catalog.ts` additions as slice 2 (`deactivateLocation`, `assertLocationOwned`, `hasOpenCountLines`); `app/(count)/count/[countId]/scan/page.tsx:21-49` (must keep consuming active-only locations — no change needed if `listLocationsAction` behavior is preserved, see Decisions) |
| 4 — inline cost/case-size editing | `components/office/catalog-table.tsx` (new editable `<td>`s, reuses the selection/save-state pattern already in the file at lines 65-160); `app/(office)/office/catalog/page.tsx:56-58` (pass `canEditCost`); **no domain or action change** — reuses `updateProductAction` (`app/actions/catalog.ts:103-111`) verbatim |
| 5 — dashboard aggregate reads | `lib/domain/catalog.ts` (new `getCatalogHealth` — active-product count and owner-gated unpriced count only, Amendment 1); `lib/domain/reports.ts` (new `getLastClosedCount`, next to `reorderList` at line 330); `app/actions/catalog.ts` + `app/actions/reports.ts` (new actions); `app/(office)/office/page.tsx:34-67` (drop `searchProductsAction`, `listCountsAction`, and `countSummaryAction` from the `Promise.all` entirely — not just the search call — and add `catalogHealthAction()` + `lastClosedCountAction()`; removing all three capped/50-row reads is the actual fix for `#14`, Amendment 4b) |
| 6 — reorder copy/print | `app/(office)/office/reorder/page.tsx` (extract the per-vendor block into a new client component `components/office/reorder-vendor-block.tsx`); `lib/domain/reports.ts` (extend `ReorderList` with `asOfClosedAt`, sourced from `getOnHandSnapshot`'s already-computed value — no new query, Amendment 4a); no action or route change — reuses `reorderListAction` (`app/actions/reports.ts:23-27`) with one added field on its return type |
| 7a — `#23` create-user guard | `scripts/create-user.ts:215-222` only |
| 7b — `#24` LAN dev-state guard | `package.json` (`docker:up` script); new `scripts/docker-up-guard.sh` — inspects the running container directly (`docker inspect`'s `Env` for `DEV_LAN_ORIGIN`/`APP_BIND`, and the `tls` profile's proxy container's presence) — no state file, no `.gitignore` change (Amendment 3) |
| 7c — `#1b` session sweep | New `lib/domain/sessions.ts` (or a plain query in a new script — see Decisions), new `scripts/sweep-sessions.ts` guarded like `db/seed.ts:363-375` |

---

## Endpoints

All are server actions (`"use server"`), never route handlers — consistent
with every existing catalog/report action. None of the new work adds a route
handler.

| Action | File | Role gate | Purpose |
|---|---|---|---|
| `listLocationsAction()` | `app/actions/catalog.ts` (existing, unchanged signature) | owner, manager, staff | Active locations only — the count-picker consumer. Behavior must NOT change: still active-only, per Decision 5. |
| `listAllLocationsAction()` | `app/actions/catalog.ts` (new) | owner, manager | Active + retired locations, for the management screen. |
| `createLocationAction(input)` | `app/actions/catalog.ts` (new) | owner, manager | Add a location. |
| `updateLocationAction(input)` | `app/actions/catalog.ts` (new) | owner, manager | Rename / change `sortOrder` / `notes` / `countMode`. Enforces the count-mode-change guard. |
| `deactivateLocationAction(input)` | `app/actions/catalog.ts` (new) | owner, manager | Retire. Enforces last-active-location and in-use-by-open-count guards. |
| `updateProductAction(input)` | `app/actions/catalog.ts:103-111` (existing, unchanged) | owner, manager | Reused per-cell for inline cost/case-size edits. No change. |
| `catalogHealthAction()` | `app/actions/catalog.ts` (new) | owner, manager | Dashboard: active product count, unpriced count (owner only) — no incomplete count (Amendment 1). |
| `lastClosedCountAction()` | `app/actions/reports.ts` (new, beside `reorderListAction`) | owner, manager | Dashboard: the single most-recently-closed count, cost-gated like `listCounts`. |
| — | reorder copy/print | none | Client-side only; reuses `reorderListAction`'s existing payload. |
| — | session sweep | none | CLI script only. Never a route or action — Phase 3 wires the cron directly to the script against production `DATABASE_URL`, per `00-status.md`. |
| — | LAN dev-state guard | none | Shell/npm-script change only. |
| — | create-user guard | none | Script-only change. |

New page (not an endpoint, but new routable surface): `/office/locations` —
gated by `requireOfficeUser()` (redirects staff to `/count`, matching every
other `/office/*` page) plus the same owner/manager expectation the actions
enforce; a manager who somehow renders the page still hits real role checks
on every write.

---

## Data

### Migration 0003 — `location.active`

```sql
-- drizzle/0003_<name>.sql

ALTER TABLE `location`
  ADD COLUMN `active` boolean NOT NULL DEFAULT true;

CREATE INDEX `location_organization_active_idx`
  ON `location` (`organization_id`, `active`);
```

Mirrors `product.active` + `product_organization_active_idx` exactly
(`db/schema.ts:747,755`). `DEFAULT true` on a `NOT NULL` column addition
backfills every existing row (all 5 seeded locations) to `active = 1` as part
of the same `ALTER` — MariaDB 11.8 performs this as an instant metadata
operation for a trailing column with a fixed default (same class of change
already verified portable per `AGENTS.md`'s MariaDB section), so there is no
separate backfill step and no window where an existing row reads `NULL`.

`location_organization_name_unique` (`db/schema.ts:359`) is **left
unchanged** — it stays `UNIQUE(organization_id, name)`, with no `active`
filter. A retired location's name stays taken. See Decision 1.

No change to `location_organization_id_id_unique` — it still needs to cover
every row (active or not) because it's the target of `product_par`'s
composite tenant FK.

### New reads/writes

**`listLocations(actor, { includeInactive })`** — extends the existing
function (`lib/domain/catalog.ts:803-815`) with one optional flag,
default `false`:

```sql
SELECT id, name, sort_order, count_mode, notes, active
FROM location
WHERE organization_id = ?
  AND (? /* includeInactive */ = 1 OR active = 1)
ORDER BY sort_order, name;
```

**`createLocation(actor, input)`**:

```sql
INSERT INTO location (organization_id, name, sort_order, count_mode, notes, active)
VALUES (?, ?, ?, ?, ?, true);
-- then re-select by insertId, mirroring createVendor (lib/domain/catalog.ts:848-877)
```

Catch the duplicate-key error on `location_organization_name_unique` and
raise `ConflictError("A location with this name already exists.")` — same
message whether the collision is with an active or a retired location (see
Decision 1; no cross-tenant concern here, this is same-tenant, so nothing is
leaked by being specific).

**`assertLocationOwned(runner, organizationId, locationId)`** — new helper,
same shape as `assertVendorOwned` (`lib/domain/catalog.ts:392-405`) but
returns the row (needed by the count-mode guard), not just existence:

```sql
SELECT id, count_mode FROM location
WHERE id = ? AND organization_id = ?
LIMIT 1;
-- throws NotFoundError("Location") if empty
```

**`hasOpenCountLines(runner, organizationId, locationId)`** — new helper,
shared by the count-mode-change guard and the deactivate guard. Carries a
comment tying `status <> 'closed'` to `countStatusEnum` (`db/schema.ts`), so
a future status added to that enum surfaces this function in the blast
radius instead of silently bypassing the guard (Gate 3 least-confident item
4, accepted as-is 2026-08-12 — see Amendments):

```sql
-- NOTE: `<> 'closed'` is intentionally tied to `countStatusEnum`
-- (db/schema.ts). If that enum ever gains another terminal, effectively-
-- immutable status, this predicate must widen to match — see Decision 3/4.
SELECT 1
FROM count_line cl
JOIN `count` c
  ON c.id = cl.count_id AND c.organization_id = cl.organization_id
WHERE cl.organization_id = ?
  AND cl.location_id = ?
  AND c.status <> 'closed'
LIMIT 1;
```

**`updateLocation(actor, input)`** — mirrors `updateVendor`
(`lib/domain/catalog.ts:884-930`): one transaction, `assertLocationOwned`
first, build a patch from `!== undefined` fields, guard `count_mode` changes,
then:

```sql
UPDATE location
SET name = ?, sort_order = ?, count_mode = ?, notes = ?
WHERE id = ? AND organization_id = ?;
```

**`deactivateLocation(actor, locationId)`**:

```sql
-- 1. last-active-location guard
SELECT COUNT(*) AS n FROM location
WHERE organization_id = ? AND active = 1 AND id <> ?;
-- refuse if n = 0

-- 2. in-use guard: hasOpenCountLines(...) above; refuse if any row

-- 3. the write
UPDATE location SET active = false
WHERE id = ? AND organization_id = ?;
```
All three inside one `db.transaction`, matching `setUserActive`'s shape
(`lib/domain/users.ts:110-155`) for the same reason: the guard and the write
must not race.

**Inline cost/case-size cell** — no new SQL. `updateProduct`
(`lib/domain/catalog.ts:689-771`) already does exactly this per product,
including the accept-then-strip cost rule via `canManageCost`. Called once
per cell commit with a single-field patch, e.g. `{ productId, currentUnitCost }`
or `{ productId, caseSize }`.

**`getCatalogHealth(actor)`** — new, in `lib/domain/catalog.ts`. Returns only
what the dashboard's real tiles use (verified against
`app/(office)/office/page.tsx`: four tiles exist today — last-closed count,
reorder pressure, catalog health, and owner-gated unpriced; there is no
"incomplete" tile). No hand-written incomplete-count predicate, and
therefore nothing to keep in lockstep with `incompleteReasons`
(`lib/domain/catalog.ts:109-127`) — that duplication risk is deleted, not
reconciled (Amendment 1; Risk 4 below is obsolete as a result). The catalog
table's "needs attention" view keeps calling `incompleteReasons` on a real
row read, unchanged — it needs per-product reasons, which this aggregate
never did:

```sql
-- activeCount
SELECT COUNT(*) AS n FROM product
WHERE organization_id = ? AND active = 1;

-- unpricedCount — only run/returned when canSeeCost(actor.role); otherwise
-- the function returns null for this field without issuing the query at all
SELECT COUNT(*) AS n FROM product
WHERE organization_id = ? AND active = 1 AND current_unit_cost IS NULL;
```

**`getLastClosedCount(actor)`** — new, in `lib/domain/reports.ts`, same
join shape as `listCounts` (`lib/domain/reports.ts` around line 318) but a
direct query instead of "fetch 50, filter, sort client-side":

```sql
SELECT c.id, c.type, c.status, c.started_at, c.closed_at, c.notes,
       c.total_value, opener.name AS opened_by_name, closer.name AS closed_by_name
FROM `count` c
LEFT JOIN user opener ON opener.id = c.opened_by
LEFT JOIN user closer ON closer.id = c.closed_by
WHERE c.organization_id = ? AND c.status = 'closed'
ORDER BY c.closed_at DESC
LIMIT 1;
```
`total_value` is only attached to the returned object when
`canSeeCost(actor.role)`, exactly like `listCounts`.

**Session sweep**:

```sql
DELETE FROM session WHERE expires_at < NOW();
```
Not organization-scoped, deliberately — `session` is one of the two tables
invariant 9 explicitly excepts (`AGENTS.md` invariant 9). Uses
`session_expires_at_idx` (`db/schema.ts` session table, already present).

---

## Flow

**1. Add a location** (`/office/locations`)
1. Inline add row: name, count mode select, optional sort order/notes.
2. Client calls `createLocationAction({ name, countMode, sortOrder?, notes? })`.
3. Action: `requireRole("owner","manager")` → `locationCreateSchema.parse` →
   `catalog.createLocation(actor, parsed)`.
4. Domain: `INSERT` (org-stamped, `active` always `true` at creation) →
   duplicate-name → `ConflictError`; otherwise re-select and return.
5. Client: `result.ok` → clear the row, `router.refresh()`.

**2. Retire a location** (`deactivateLocationAction`)
1. Row-level "Retire" control, two-step (tap → confirm in place, no modal —
   consistent with the rest of the back office having no confirmation
   dialogs, and this action is used rarely enough that a modal isn't
   earning its keep the way it would on a 150-scans-per-count control).
2. Client calls `deactivateLocationAction({ locationId })`.
3. Action: `requireRole("owner","manager")` → parse → `catalog.deactivateLocation`.
4. Domain, one transaction: `assertLocationOwned` → last-active-location
   count → `hasOpenCountLines` → `UPDATE ... SET active = false`. Any guard
   failure throws a `DomainError` with an actionable message; nothing is
   written.
5. Client: `result.ok` → `router.refresh()`; `!result.ok` → show
   `result.error.message` inline on that row (mirrors `catalog-table.tsx`'s
   `assignError` banner pattern).

**3. Edit a cost cell** (catalog table, owner only; case-size cell is
owner+manager, same flow)
1. Click the cell → becomes an `Input` (mirrors `product-edit-form.tsx`'s
   `inputMode="decimal"`, not `type="number"`, string value).
2. On blur/Enter: empty string → `null` (never `0`/`""` — Decision 6/Risk 7);
   otherwise the raw string, validated client-side against the same
   `unitCostSchema` regex used server-side (`lib/validation/catalog.ts:38-43`)
   for instant feedback, but the server call is the source of truth.
3. Client calls `updateProductAction({ productId, currentUnitCost })` (or
   `{ productId, caseSize }`) — one call per cell, independent of every
   other cell and row.
4. Action/domain: unchanged existing path (`app/actions/catalog.ts:103-111`
   → `lib/domain/catalog.ts:689-771`).
5. Client: on `ok`, patch **only that row** in local table state from the
   **returned** `ProductSummary` value, not from the locally-typed string —
   the server's stripped/rounded value is the truth (Risk 6). No
   `router.refresh()` on a per-cell commit (Amendment 2 — Gate 1's 45-minute,
   90-cost budget does not survive ~180 full-page round trips). On failure,
   the cell reverts and shows the per-cell error inline
   (`fieldErrors.currentUnitCost` / `fieldErrors.caseSize`). A full
   `router.refresh()` runs only on navigation away from the page or an
   explicit user action — never per cell — so `incomplete` pills and
   dashboard-adjacent counts catch up at that point, not on every keystroke's
   commit.

**4. Copy a vendor's reorder order**
1. `/office/reorder`'s server component still calls `reorderListAction()`
   once (unchanged) and groups by vendor (unchanged logic).
2. Each vendor group is now rendered by a small client component that
   receives that vendor's already-fetched items as props — no new fetch.
3. "Copy": builds a plain-text block client-side from those props (vendor
   name, `asOfCountId` and `asOfClosedAt` — the latter sourced from
   `getOnHandSnapshot`'s already-computed value, no new query, Amendment 4a —
   one line per item — name, suggested qty), calls
   `navigator.clipboard.writeText(text)`, shows a 2s "Copied" confirmation
   (same auto-dismiss convention as `catalog-table.tsx:124`).
4. "Print": sets which vendor block is print-visible, calls `window.print()`
   scoped to that block via a print stylesheet, clears the print-target on
   `window.onafterprint`.
5. No server round trip for either action.

---

## External

None for slices 1–6.

Slice 7 introduces no new **env vars** — it reuses `APP_BIND`,
`DEV_LAN_ORIGIN`, `PROD_LAN_ORIGIN` (already named in `AGENTS.md`/existing
scripts) and adds no file of any kind — the guard reads them straight off
the running container's `Env` via `docker inspect` (Decision 8, revised by
Amendment 3).

The session-sweep **cron** itself is explicitly out of scope here — Hostinger
only exists at Phase 3 (`00-status.md`). This bundle ships the query and the
script; Phase 3 wires a cron to invoke it against production `DATABASE_URL`.

---

## Decisions taken

1. **`location_organization_name_unique` stays `(organization_id, name)`,
   unfiltered by `active`.** A retired location's name stays taken. Matches
   the existing precedent on `product` — `product_organization_name_size_ml_unique`
   (`db/schema.ts:751`) is likewise not filtered by `active`. Excluding
   inactive rows would let a new location silently reuse a retired one's
   display name, splitting one conceptual place across two rows with the
   same name in the UI — confusing, and directly against invariant 6's
   "history references it."
2. **Migration 0003 adds `location.active boolean NOT NULL DEFAULT true`
   plus `location_organization_active_idx (organization_id, active)`** —
   mirrors `product` exactly. Backfill is automatic via the column default;
   no data migration step.
3. **Count-mode change guard fires only when `count_mode` is actually
   changing** (not on every rename/reorder save) **and only when the
   location has `count_line` rows on a non-closed count.** Closed counts are
   immutable by invariant 1, so a location used only by closed counts is
   safe to re-mode — its historical lines are frozen regardless of what the
   location is configured to do today.
4. **Deactivate guard is the same `hasOpenCountLines` check**, but applied
   unconditionally (not just on a `count_mode` diff) — a location with lines
   on any open count cannot be retired at all, closed-count-only locations
   can.
5. **`listLocationsAction()` (the scan-picker consumer) keeps returning
   active-only locations with its existing signature and role gate.** A
   second action, `listAllLocationsAction()`, serves the management screen.
   This avoids touching the count app's highest-risk existing consumer
   (`app/(count)/count/[countId]/scan/page.tsx:21-49`) at all while still
   giving the management screen visibility into retired rows.
6. **Last-active-location guard mirrors `setUserActive`'s last-active-owner
   check** (`lib/domain/users.ts:110-155`): count remaining active locations
   excluding the target; refuse at zero.
7. **Inline cost/case-size editing reuses `updateProductAction` per cell,
   one call per commit — no new bulk endpoint.** `assignVendorToProducts`
   (`lib/domain/catalog.ts:954-999`) sets one value across many rows and does
   not generalize to per-row-different values (recon finding). A bulk
   endpoint would also have to re-implement the cost/case-size role split
   inside a single payload (cost is owner-only, case size is owner+manager —
   two different gates in the same row). Per-cell reuse sidesteps all of it:
   the existing accept-then-strip cost logic and existing zod schema need no
   change, and the mockup's per-cell save states (focus/dirty/saving/saved/
   error) map directly onto one call per field. Cost: up to ~180 sequential
   `updateProductAction` calls across 90 rows in one sitting — but each
   commit patches only its own row in local state from the response and does
   **not** call `router.refresh()` (Amendment 2), so the cost is ~180
   lightweight server-action round trips, not ~180 full-page Server
   Component re-renders. That distinction is what keeps this within Gate 1's
   under-45-minutes, 90-cost budget.
8. **The LAN dev-state guard is a refusal, not a silent revert — and it
   inspects the running container directly, with no state file (revised by
   Amendment 3, 2026-08-12).** `docker:up` becomes a wrapper
   (`scripts/docker-up-guard.sh`) that runs `docker inspect` against the
   running compose containers to read the effective `DEV_LAN_ORIGIN` and
   `APP_BIND` straight from the container's `Env`, and to check directly
   whether the `tls` profile's proxy container is present and running. If a
   LAN session looks live, it refuses, naming `docker:up:lan` as the reason
   and `bun run docker:down` as the fix. Chosen over silently reverting
   because a silent revert is precisely this project's worst failure mode —
   a plausible-looking `docker:up` success that quietly kicks the phone off
   the network mid-count, discovered only by the counter, not by the
   terminal. A loud refusal costs one extra command; a silent revert costs a
   confused counting session. Gate 2 originally proposed a gitignored state
   file (`.truestock-lan-state.json`) written by `dev-lan.sh`/`prod-lan.sh`;
   Gate 3 objected that the file's only failure mode is staleness and that
   the guard has to reconcile against real container state regardless, so
   the file adds no information a direct `docker inspect` doesn't already
   have while introducing a false-refusal risk (former Risk 7, now obsolete)
   that doesn't exist without a file to go stale. Resolved by deleting the
   file, not reconciling it — same shape as Amendment 1.
9. **Reorder copy/print is 100% client-side — no new server route.** The
   data is already fetched once via `reorderListAction`, already role-gated,
   and already present in the rendered page; formatting it into plain text
   or printing the DOM is presentation, not a new read. Adding an endpoint
   here would be a route that does nothing a client already holding the data
   can't do itself.
10. **Dashboard aggregate reads are dedicated `COUNT(*)` queries, not a
    bigger `limit`.** Raising the 100-row cap on `searchProductsAction` only
    postpones the exact same bug at the next catalog size and keeps paying
    the cost of transferring full `ProductSummary` rows just to count them.
11. **The reorder-pressure tile needs no fix.** `reorderList`
    (`lib/domain/reports.ts:330`) already queries `product_par` and `product`
    directly with no row limit — it was never subject to the 100-row cap the
    other two tiles had. Confirmed by reading the function; not assumed.
12. **`getCatalogHealth`'s `unpricedCount` is `null`, never computed, for a
    non-owner caller** — the query itself is skipped, not just the field
    hidden after the fact, matching invariant 8's "filter server-side, never
    client-side" and the existing `showCost` pattern in `selectProducts`.

---

## Risks and what breaks

This project's worst failure mode is a number that looks plausible and is
wrong. Every place that can happen in this bundle:

1. **A retired location that still shows up in the count picker is the
   single highest risk in this bundle.** If `listLocationsAction` is ever
   changed to include inactive rows (Decision 5 says it must not be), a
   "retired" location keeps accepting real scans with zero errors anywhere —
   the count total stays numerically correct and only the fact that this
   place was supposed to be gone is wrong, which is invisible until someone
   notices weeks later that a closed-down tap line is still on the reorder
   list.
2. **A missed or bypassed count-mode-change guard** silently reinterprets
   already-recorded lines: a `sealed_case_qty` of 3 was true under
   `quantity` mode and becomes meaningless once the screen switches to
   `tenths` for that location, with no flag anywhere that the meaning
   changed underneath the data. Stored numbers never change — only what they
   mean does — so this fails silently by construction. Must be covered by a
   test that opens a count, writes a line, then asserts the guard refuses
   the mode change.
3. **A missed deactivate guard** lets a location with in-progress lines
   disappear from every UI list while its rows keep summing into totals —
   the data is safe (nothing is deleted, invariant 6), but it becomes
   unauditable-*looking*: a manager staring at the location list sees no
   trace of where those units were recorded.
4. ~~**Dashboard aggregate drift.**~~ **OBSOLETE (Amendment 1, 2026-08-12).**
   This risk existed only because Gate 2 gave `getCatalogHealth` a
   hand-written `incompleteCount` SQL predicate meant to shadow
   `incompleteReasons` (`lib/domain/catalog.ts:109-127`). There is no
   "incomplete" dashboard tile — verified against
   `app/(office)/office/page.tsx` — so Amendment 1 deletes that field from
   the aggregate entirely rather than trying to keep two predicates in
   lockstep. `getCatalogHealth` now returns only `activeCount` and
   `unpricedCount`, both single unambiguous `COUNT(*)` predicates with no JS
   counterpart to drift from. Numbering kept as-is rather than renumbering
   the list.
5. **Emptied cost/case-size cells must submit `null`, never `0` or `""`.**
   `unitCostSchema` (`lib/validation/catalog.ts:38-43`) would reject a bare
   `""`, which protects against an empty string reaching the DB, but a bug
   that sends `"0"` instead of `null` passes validation and silently prices
   a product at $0.00 — the exact "plausible-but-wrong default" `AGENTS.md`
   names by name. The inline editor must copy `product-edit-form.tsx`'s
   `cost.trim() === "" ? null : cost` conversion exactly, not re-derive it.
6. **Rendering the optimistic client-typed value instead of the server's
   returned `ProductSummary`.** Because `updateProduct` strips cost silently
   for non-owners (never rejects), any inline editor that trusts its own
   input on `ok: true` rather than the response body could show "saved"
   for a value the database never actually took — indistinguishable from a
   real save without checking the network tab. The cost cell is only ever
   rendered for `canSeeCost` callers so this specific path shouldn't fire in
   practice, but the principle (trust the response, not the request) is the
   guard against every future field added the same way.
7. ~~**Stale LAN-state file.**~~ **OBSOLETE (Amendment 3, 2026-08-12).** This
   risk existed only because Gate 2's guard trusted a gitignored state file
   that could survive a crash. Amendment 3 deletes the file — the guard now
   reads `DEV_LAN_ORIGIN`/`APP_BIND` and the `tls` proxy container's presence
   directly off the running container via `docker inspect`, so there is no
   file to go stale and no false-positive refusal to design around.
   Numbering kept as-is rather than renumbering the list.
8. **A stale reorder Copy/Print.** Because the client component reads props
   captured at the last server render, an order copied from a tab left open
   since before the day's count closed carries yesterday's on-hand numbers
   with nothing on screen distinguishing it from a fresh one. The plain-text
   block must state the `asOfCountId`/close date so a stale copy is at least
   labeled, not just wrong.
9. **Session sweep must stay un-scoped to organization.** `session` is one
   of exactly two tables invariant 9 names as a deliberate exception
   (`AGENTS.md` invariant 9). A future edit that "fixes" this by adding an
   `organization_id` filter would not be a correctness improvement — it
   would just be a slower, more complex version of the same unconditional
   `expires_at < NOW()` sweep this table needs. Flagging this so it isn't
   "corrected" by someone unaware of the exception.
10. **`create-user.ts`'s bare `main()`.** Left unguarded, any future test or
    script that imports something from `scripts/create-user.ts` (however
    unlikely today) triggers a live password prompt and a real `INSERT`
    against whatever `DATABASE_URL` happens to be active — the same incident
    class the comment at `db/seed.ts:355-362` already documents for the seed
    script. The fix must copy that exact `import.meta.url` guard, not
    approximate it.

---

## Amendments

Gate 3 review (`03-program-design.md`) surfaced three objections to this
gate's decisions and one addition. All four are resolved as follows, applied
consistently across `02-architecture.md`, `03-program-design.md`, and
`04-slices.md`. Dated 2026-08-12.

1. **`getCatalogHealth` drops `incompleteCount` entirely — the aggregate is
   deleted, not reconciled.** Gate 3 objected that hand-writing a SQL
   predicate for `incompleteCount` duplicates `incompleteReasons`'s logic
   (`lib/domain/catalog.ts:109-127`) and will silently drift (former Risk 4).
   Verified first, against `app/(office)/office/page.tsx`: the dashboard has
   exactly four tiles today — last-closed count, reorder pressure, catalog
   health (`products.length`), and owner-gated unpriced (`uncostedCount`).
   There is no "incomplete" tile; Gate 2 invented one. `getCatalogHealth` now
   returns only `activeCount` and an owner-gated `unpricedCount`
   (`current_unit_cost IS NULL`) — both single, unambiguous `COUNT(*)`
   predicates with no JS counterpart to drift from. The catalog table's
   "needs attention" view keeps using `incompleteReasons` on a real row
   read, unchanged, because it needs per-product reasons, not a count.
   Former Risk 4 is marked obsolete rather than deleted, to preserve the
   existing numbering.
2. **No `router.refresh()` per cell edit in the inline cost/case-size
   editor.** Decision 7 stands — `updateProductAction` is still reused
   per-cell, one call per commit, no bulk endpoint. But a full
   `router.refresh()` per commit means ~180 full-page round trips across a
   90-cost sitting, which breaks Gate 1's approved success metric of
   entering 90 costs in one sitting in under 45 minutes. On a successful
   cell save, the client now patches only that row in local state from the
   action's **returned** `ProductSummary` — never from the locally-typed
   value, so a stripped or coerced value visibly snaps back, the same
   contract `components/office/user-management`-style controls already use.
   A full `router.refresh()` runs only on navigation away or an explicit
   user action, never per cell.
3. **The gitignored LAN state file for `#24` is dropped; `docker:up`
   inspects real container state instead.** Gate 3 was right that the
   file's only failure mode is staleness, and that the guard has to
   reconcile against real container state regardless. `docker inspect`
   exposes the running container's `Env` (so the effective
   `DEV_LAN_ORIGIN` and `APP_BIND` are both readable directly from the
   container) and makes the `tls` profile's proxy container's presence
   directly observable — no file, no `.gitignore` entry, no staleness.
   Former Risk 7 is marked obsolete rather than deleted. If container
   inspection turns out unable to determine the effective `DEV_LAN_ORIGIN`
   during implementation, that must be reported rather than silently
   reintroducing the file.
4. **Two Gate 3 additions accepted.** (a) `ReorderList` gains an
   `asOfClosedAt` field sourced from `getOnHandSnapshot`'s already-computed
   value (no new query), so a copied/printed order carries the as-of date
   and a stale copy is labeled rather than anonymous. (b) The dashboard page
   drops its `listCountsAction`, `countSummaryAction`, and
   `searchProductsAction` calls once `lastClosedCountAction` and
   `catalogHealthAction` land — recorded here as a simplification of this
   gate's Fit section, since removing three capped reads is the actual fix
   for `#14`, not merely adding two uncapped ones.

Also accepted as originally written, per Gate 3's own "least confident"
items 4 and 5: the `hasOpenCountLines` SQL carries a comment tying
`status <> 'closed'` to `countStatusEnum` so a future status can't silently
bypass the guard (see the Data section above); and the session sweep lives
in a domain file (`lib/domain/sessions.ts`) for testability, called by a
thin script.
