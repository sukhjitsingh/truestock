# Gate 3 — Program Design: finish the MVP, then make it survive daily use

Scope: the 7 slices in `00-status.md`, architecture per `02-architecture.md`
(12 numbered decisions, treated as authoritative below — any disagreement is
called out in "Least confident decisions," never silently redesigned).

---

## Files

### Slice 1 — `/office/locations` tracer bullet

| File | Why |
|---|---|
| `components/office/office-nav.tsx` (edit) | Add the "Locations" link, same pattern as the existing five. |
| `app/(office)/office/locations/page.tsx` (new) | Renders the seeded locations read-only via the existing `listLocationsAction()`. Proves the route, the nav link, and the role gate (`requireOfficeUser`) end to end before any new domain code exists. |

### Slice 2 — locations CRUD + migration 0003

| File | Why |
|---|---|
| `db/schema.ts` (edit) | Add `location.active boolean NOT NULL DEFAULT true` + `location_organization_active_idx (organization_id, active)` — Decision 2, mirrors `product` exactly. |
| `drizzle/0003_<generated>.sql` (new) | `drizzle-kit generate`'s output for the schema change above. Content must match Decision 2's SQL verbatim (`ALTER TABLE` + `CREATE INDEX`, no separate backfill — the column default does it). |
| `drizzle/meta/0003_snapshot.json` (new, generated) | drizzle-kit's schema snapshot for the new migration. |
| `drizzle/meta/_journal.json` (edit, generated) | Appends the `0003` entry drizzle-kit writes automatically. |
| `lib/domain/catalog.ts` (edit) | Extend `LocationSummary` with `active`; extend `listLocations` with `{ includeInactive }`; add `assertLocationOwned`, `hasOpenCountLines`, `createLocation`, `updateLocation`. All colocated with the existing location section (currently lines 789-815) since they share the same ownership/tenant reasoning as the vendor functions just above it. |
| `lib/validation/catalog.ts` (edit) | Add `locationCountModeSchema`, `locationCreateSchema`, `locationUpdateSchema`. |
| `app/actions/catalog.ts` (edit) | Add `listAllLocationsAction`, `createLocationAction`, `updateLocationAction`. `listLocationsAction` itself is untouched (Decision 5). |
| `components/office/locations-table.tsx` (new) | List + inline create/edit, mirroring `vendors-list.tsx` + `vendor-edit-form.tsx`'s combined shape. |
| `app/(office)/office/locations/page.tsx` (edit) | Swap the slice-1 read-only render for `listAllLocationsAction()` + `<LocationsTable>`. |

### Slice 3 — locations deactivate + guards

| File | Why |
|---|---|
| `lib/domain/catalog.ts` (edit) | Add `deactivateLocation`, reusing `assertLocationOwned`/`hasOpenCountLines` written in slice 2 (both guards are needed there too, for `updateLocation`'s count-mode check — see Decision 3). |
| `lib/validation/catalog.ts` (edit) | Add `locationDeactivateSchema`. |
| `app/actions/catalog.ts` (edit) | Add `deactivateLocationAction`. |
| `components/office/locations-table.tsx` (edit) | Add the tap-to-confirm retire control and its inline refusal message. |

### Slice 4 — inline cost + case-size editing

| File | Why |
|---|---|
| `components/office/catalog-table.tsx` (edit) | Add a case-size column; make the cost cell (owner-only) and case-size cell (owner+manager) editable in place. No new column for products with `!isCountedByCase` — they keep the existing static rendering. |
| `app/(office)/office/catalog/page.tsx` (edit) | Pass the new `canEditCost={user.role === "owner"}` prop (today only `canSeeCost` and `userRole` are passed — recon finding). |

No domain, validation, or action file changes — `updateProductAction` (`app/actions/catalog.ts:103-111`) and `updateProduct` (`lib/domain/catalog.ts:689-771`) are reused verbatim (Decision 7).

### Slice 5 — dashboard aggregate reads

| File | Why |
|---|---|
| `lib/domain/catalog.ts` (edit) | Add `getCatalogHealth` — `activeCount` and owner-gated `unpricedCount` only, no `incompleteCount` (Amendment 1 deletes it rather than reconciling it against `incompleteReasons`). |
| `lib/domain/reports.ts` (edit) | Add `getLastClosedCount`, same join shape as the existing count-summary reads. |
| `app/actions/catalog.ts` (edit) | Add `catalogHealthAction`. |
| `app/actions/reports.ts` (edit) | Add `lastClosedCountAction`. |
| `app/(office)/office/page.tsx` (edit) | Drop `searchProductsAction`, `listCountsAction`, and `countSummaryAction` from the `Promise.all` (nothing else on this page uses `counts` besides deriving `lastClosed`/`summary`, which `lastClosedCountAction` now does directly) and add `catalogHealthAction()` + `lastClosedCountAction()`. `getActiveCountAction()` and `reorderListAction()` are unchanged (Decision 11: the reorder tile needs no fix). Amendment 4b: Gate 2's Fit section is corrected to record this — removing three capped/50-row reads is the actual fix for `#14`, not merely adding two uncapped ones. |

### Slice 6 — reorder output: copy + print

| File | Why |
|---|---|
| `lib/domain/reports.ts` (edit) | Extend `ReorderList` with `asOfClosedAt: Date \| null`, sourced from `getOnHandSnapshot`'s existing `asOfClosedAt` field (already computed, not queried again). Gate 3 addition beyond Gate 2's Fit section, accepted as Amendment 4a (2026-08-12) — Risk 8 requires it. |
| `lib/reorder-format.ts` (new) | Pure text formatter, dependency-free like `lib/pack-level.ts`, so it is unit-testable without a DOM environment and importable from the client component. |
| `components/office/reorder-vendor-block.tsx` (new) | Per-vendor Copy/Print client component, replacing the inline `<section>` block in the reorder page. |
| `app/(office)/office/reorder/page.tsx` (edit) | Keep the existing single `reorderListAction()` fetch and vendor grouping; render `<ReorderVendorBlock>` per group instead of the inline table markup. |

### Slice 7a — `#23` create-user guard

| File | Why |
|---|---|
| `scripts/create-user.ts` (edit, lines 215-222) | Wrap the bare `main().catch(...).finally(...)` in the same `import.meta.url === pathToFileURL(process.argv[1]).href` guard `db/seed.ts:363` already uses. |

### Slice 7b — `#24` LAN dev-state guard

| File | Why |
|---|---|
| `package.json` (edit) | `docker:up` becomes `bash scripts/docker-up-guard.sh` (currently `docker compose up -d --wait`). |
| `scripts/docker-up-guard.sh` (new) | Inspects the running container directly via `docker inspect` — reads `DEV_LAN_ORIGIN`/`APP_BIND` off the container's `Env` and checks the `tls` profile's proxy container's presence; refuses loudly if a LAN session looks live (Decision 8, revised by Amendment 3, 2026-08-12). No state file. |

### Slice 7c — `#1b` session sweep

| File | Why |
|---|---|
| `lib/domain/sessions.ts` (new) | Business logic lives in `lib/domain/*` per the project's working agreements, even though this one has no `Actor` (invariant 9's deliberate exception) — this also makes it importable directly from a test, matching every other domain function's test convention. |
| `scripts/sweep-sessions.ts` (new) | CLI entry point, guarded exactly like `db/seed.ts:363-375` and slice 7a's fix — never a route or action (Phase 3 wires a cron to invoke this script directly). |
| `package.json` (edit) | Add `"sweep-sessions": "tsx scripts/sweep-sessions.ts"` so Phase 3's cron has a stable command name to target. |

### Docs (updated once the bundle ships, not per-slice)

| File | Why |
|---|---|
| `STATE.md` | One-line history entry per the project's dated-log convention. |
| `docs/open-items.md` | Close #14 (dashboard caps), #23 (create-user guard), #24 (LAN guard), #1b (session sweep) using the file's own `~~N. …~~ — closed <date>` convention. |
| `docs/plans/phase-1-to-1.5/00-status.md` | Slice checkboxes and gate status, updated at every gate/slice boundary per `docs/plans/README.md`'s standing rules. |

---

## Types & signatures

### `lib/validation/catalog.ts` — location schemas

```ts
import { locationCountModeEnum } from "@/db/schema"; // added to the existing import line

export const locationCountModeSchema = z.enum(locationCountModeEnum);

/**
 * Location creation. `countMode` is required — the add-location row always
 * offers the select (Gate 2 Flow 1), so there is no ambiguous default to
 * resolve here the way there is on the column itself.
 */
export const locationCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(100),
  countMode: locationCountModeSchema,
  sortOrder: z.number().int().nonnegative().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type LocationCreateInput = z.infer<typeof locationCreateSchema>;

/** `undefined` = don't touch; `notes: null` clears it. Same convention as `vendorUpdateSchema`. */
export const locationUpdateSchema = z.object({
  locationId: z.number().int().positive(),
  name: z.string().trim().min(1).max(100).optional(),
  countMode: locationCountModeSchema.optional(),
  sortOrder: z.number().int().nonnegative().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type LocationUpdateInput = z.infer<typeof locationUpdateSchema>;

export const locationDeactivateSchema = z.object({
  locationId: z.number().int().positive(),
});
export type LocationDeactivateInput = z.infer<typeof locationDeactivateSchema>;
```

### `lib/domain/catalog.ts` — location domain functions

```ts
export interface LocationSummary {
  id: number;
  name: string;
  sortOrder: number;
  countMode: (typeof location.$inferSelect)["countMode"];
  notes: string | null;
  /** NEW — see migration 0003. Absent from the type before this bundle. */
  active: boolean;
}

/**
 * `includeInactive` defaults to false. `listLocationsAction` (the scan-picker
 * consumer, every role) always calls this with the default — Decision 5.
 * `listAllLocationsAction` (owner/manager, the management screen) is the only
 * caller that passes `true`.
 */
export async function listLocations(
  actor: Actor,
  options?: { includeInactive?: boolean },
): Promise<LocationSummary[]>;

/**
 * Invariant 9: a cross-tenant id is answered as NotFound, never an answer
 * that confirms the row is real. Returns the row (not just a boolean) because
 * `updateLocation`'s count-mode guard needs `countMode` to detect a real
 * change.
 */
async function assertLocationOwned(
  runner: Runner,
  organizationId: number,
  locationId: number,
): Promise<{ id: number; countMode: (typeof location.$inferSelect)["countMode"] }>;

/**
 * True if this location has at least one `count_line` row on a count whose
 * `status <> 'closed'`. Shared by `updateLocation`'s count-mode-change guard
 * (Decision 3) and `deactivateLocation`'s guard (Decision 4) — same
 * predicate, applied unconditionally in one case and only on a `countMode`
 * diff in the other. `<> 'closed'` is tied to `countStatusEnum`
 * (`db/schema.ts`) by a comment at the call site — accepted as-is, least-
 * confident item 4, 2026-08-12: if that enum ever grows another terminal,
 * effectively-immutable status, this predicate must widen alongside it.
 */
async function hasOpenCountLines(
  runner: Runner,
  organizationId: number,
  locationId: number,
): Promise<boolean>;

/**
 * Owner/manager only (enforced in the action). Always inserts `active: true`.
 * Duplicate `(organization_id, name)` — active or retired — raises
 * ConflictError (Decision 1).
 */
export async function createLocation(
  actor: Actor,
  input: LocationCreateInput,
): Promise<LocationSummary>;

/**
 * Owner/manager only. One transaction: `assertLocationOwned` first, then —
 * only if `countMode` is present AND differs from the current row — run
 * `hasOpenCountLines` and refuse with `DomainError("LOCATION_MODE_LOCKED", …)`
 * if true (Decision 3). Then the patch write.
 */
export async function updateLocation(
  actor: Actor,
  input: LocationUpdateInput,
): Promise<LocationSummary>;

/**
 * Owner/manager only. One transaction, three steps in order (mirrors
 * `setUserActive`, `lib/domain/users.ts:110-155`):
 *   1. `assertLocationOwned`
 *   2. count other active locations in the org; refuse with
 *      `DomainError("LAST_ACTIVE_LOCATION", …)` if zero remain (Decision 6)
 *   3. `hasOpenCountLines` unconditionally; refuse with
 *      `DomainError("LOCATION_IN_USE", …)` if true (Decision 4)
 *   4. `UPDATE location SET active = false WHERE id = ? AND organization_id = ?`
 */
export async function deactivateLocation(actor: Actor, locationId: number): Promise<void>;
```

### `app/actions/catalog.ts` — location actions

```ts
/** Every role. Active-only, UNCHANGED signature and behavior (Decision 5). */
export async function listLocationsAction(): Promise<ActionResult<catalog.LocationSummary[]>>;

/** Owner/manager only — the management screen; includes retired locations. */
export async function listAllLocationsAction(): Promise<ActionResult<catalog.LocationSummary[]>>;

/** Owner/manager only. */
export async function createLocationAction(
  input: unknown,
): Promise<ActionResult<catalog.LocationSummary>>;

/** Owner/manager only. */
export async function updateLocationAction(
  input: unknown,
): Promise<ActionResult<catalog.LocationSummary>>;

/** Owner/manager only. */
export async function deactivateLocationAction(
  input: unknown,
): Promise<ActionResult<{ locationId: number }>>;
```

### `components/office/locations-table.tsx` — props

```tsx
export function LocationsTable({
  locations,
}: {
  /** Active + retired — `listAllLocationsAction`'s payload. */
  locations: catalog.LocationSummary[];
}): JSX.Element;

/** Mirrors `VendorEditForm`: `location` undefined = create mode. */
function LocationEditForm({
  location,
  onSuccess,
}: {
  location?: catalog.LocationSummary;
  onSuccess?: () => void;
}): JSX.Element;
```

### `components/office/catalog-table.tsx` — changed props

```tsx
export function CatalogTable({
  products,
  query,
  view,
  canSeeCost,
  canEditCost,
  vendors,
  userRole,
}: {
  products: ProductSummary[];
  query: string;
  view: "all" | "attention";
  canSeeCost: boolean;
  /** NEW — owner-only, same predicate as `canSeeCost` today (recon: three
   * spellings of one rule) but named for what this prop gates: whether the
   * cost cell renders as an <Input> or read-only Money. Case-size edit
   * ability reuses the existing `canManage` local const (owner OR manager) —
   * two different gates in the same row, per Decision 7. */
  canEditCost: boolean;
  vendors: VendorSummary[];
  userRole: "owner" | "manager" | "staff";
}): JSX.Element;
```

### `lib/domain/catalog.ts` — dashboard aggregate read

```ts
/** Amendment 1 (2026-08-12): no `incompleteCount` field — verified the
 * dashboard has no "incomplete" tile, only catalog health (active count) and
 * an owner-gated unpriced count. The catalog table's "needs attention" view
 * keeps using `incompleteReasons` on a real row read, unchanged. */
export interface CatalogHealth {
  activeCount: number;
  /** Null — and never queried — for a non-owner caller (Decision 12). */
  unpricedCount: number | null;
}

/** No role restriction of its own — the action gates owner/manager; this
 * function further gates `unpricedCount` on `canSeeCost(actor.role)`. */
export async function getCatalogHealth(actor: Actor): Promise<CatalogHealth>;
```

### `lib/domain/reports.ts` — dashboard + reorder aggregate reads

```ts
export interface LastClosedCount {
  id: number;
  type: (typeof count.$inferSelect)["type"];
  closedAt: Date;
  notes: string | null;
  openedByName: string | null;
  closedByName: string | null;
  /** Present only for `canSeeCost(actor.role)` — invariant 8, same pattern as `CountSummary.totalValue`. */
  totalValue?: string;
}

/** Owner/manager only (enforced in the action). Null if nothing has ever closed. */
export async function getLastClosedCount(actor: Actor): Promise<LastClosedCount | null>;

export interface ReorderList {
  asOfCountId: number | null;
  /** NEW — sourced from `getOnHandSnapshot`'s existing field; no new query. */
  asOfClosedAt: Date | null;
  items: ReorderItem[];
  productsWithPar: number;
}
```

### `app/actions/catalog.ts` / `app/actions/reports.ts` — new actions

```ts
/** Owner/manager only. */
export async function catalogHealthAction(): Promise<ActionResult<catalog.CatalogHealth>>;

/** Owner/manager only. */
export async function lastClosedCountAction(): Promise<ActionResult<reports.LastClosedCount | null>>;
```

### `lib/reorder-format.ts` — pure formatter (new)

```ts
export interface ReorderTextItem {
  productName: string;
  suggestedOrderQty: number;
}

export interface ReorderTextInput {
  vendorName: string;
  asOfCountId: number;
  /** ISO date string, already formatted by the caller — this module stays
   * dependency-free (no date library), same rule as `lib/pack-level.ts`. */
  asOfClosedAt: string | null;
  items: ReorderTextItem[];
}

/** Risk 8: a stale copy must be labeled, not silently missing its date. */
export function formatReorderOrderText(input: ReorderTextInput): string;
```

### `components/office/reorder-vendor-block.tsx` — props (new)

```tsx
"use client";

export function ReorderVendorBlock({
  vendorName,
  items,
  asOfCountId,
  asOfClosedAt,
}: {
  vendorName: string;
  items: ReorderItem[]; // from lib/domain/reports.ts
  asOfCountId: number;
  /** ISO date string or null — page.tsx formats the Date before passing it down. */
  asOfClosedAt: string | null;
}): JSX.Element;
```

### `lib/domain/sessions.ts` — session sweep (new)

```ts
export interface SessionSweepBatch {
  deletedCount: number;
}

/**
 * Deliberately NOT scoped to organization — `session` is one of exactly two
 * tables invariant 9 names as an exception. `batchSize` bounds a single
 * `DELETE ... LIMIT ?` so one run against a large backlog cannot hold a
 * table lock indefinitely; the caller loops until a batch returns fewer rows
 * than requested.
 */
export async function sweepExpiredSessions(
  now?: Date,
  batchSize?: number,
): Promise<SessionSweepBatch>;
```

### `scripts/sweep-sessions.ts` — CLI entry (new)

```ts
async function main(): Promise<void>; // loops sweepExpiredSessions() until deletedCount < batchSize, logs a total

// Guarded exactly like db/seed.ts:363 / scripts/create-user.ts (slice 7a):
// if (import.meta.url === pathToFileURL(process.argv[1]).href) { main()... }
```

### `scripts/docker-up-guard.sh` — LAN guard (new)

No TypeScript types; documented here as the shell contract Gate 4 will build
against. Rewritten for Amendment 3 (2026-08-12) — no state file, container
state only:

- Runs `docker inspect` against the compose project's containers to read the
  effective `DEV_LAN_ORIGIN` and `APP_BIND` straight off the container's
  `Env`, and to check directly whether the `tls` profile's proxy container is
  present and running.
- If that inspection shows a LAN session live: refuse, name `docker:up:lan`
  as the reason and `bun run docker:down` as the fix, exit non-zero.
- Otherwise: proceed normally to the real `docker compose up -d --wait`.
- If, while implementing this, container inspection turns out unable to
  determine the effective `DEV_LAN_ORIGIN`, STOP and report rather than
  reintroducing a state file silently (explicit instruction accompanying
  Amendment 3).

---

## Call stack

### 1. Add a location

```
LocationsTable (inline add row, client)
  -> createLocationAction(input)                         app/actions/catalog.ts
       -> requireRole("owner", "manager")                 lib/authz.ts
       -> locationCreateSchema.parse(input)                lib/validation/catalog.ts
       -> catalog.createLocation(actor, parsed)            lib/domain/catalog.ts
            -> db.insert(location).values({ ...active: true })
            -> [duplicate key] -> ConflictError
            -> re-select by insertId -> LocationSummary
  <- ActionResult<LocationSummary>
  client: result.ok -> clear row, router.refresh()
       -> app/(office)/office/locations/page.tsx re-renders
            -> listAllLocationsAction() -> catalog.listLocations(actor, { includeInactive: true })
```

### 2. Retire a location

```
LocationsTable ("Retire" control, tap -> confirm in place)
  -> deactivateLocationAction({ locationId })              app/actions/catalog.ts
       -> requireRole("owner", "manager")
       -> locationDeactivateSchema.parse(input)
       -> catalog.deactivateLocation(actor, locationId)     lib/domain/catalog.ts
            db.transaction:
              -> assertLocationOwned(tx, orgId, locationId)      [cross-tenant -> NotFoundError]
              -> count active locations excluding target         [zero -> DomainError LAST_ACTIVE_LOCATION]
              -> hasOpenCountLines(tx, orgId, locationId)         [true -> DomainError LOCATION_IN_USE]
              -> tx.update(location).set({ active: false })...
  <- ActionResult<{ locationId }>
  client: ok -> router.refresh(); !ok -> inline row error (assignError-banner pattern)
```

### 3. Edit a cost cell (case-size cell: same flow, different gate)

```
CatalogTable editable <td> (owner-only for cost; owner+manager for case size)
  onBlur/Enter
  -> updateProductAction({ productId, currentUnitCost } | { productId, caseSize })   UNCHANGED
       -> requireRole("owner", "manager")                                            app/actions/catalog.ts:107
       -> productUpdateSchema.parse(input)                                           UNCHANGED
       -> catalog.updateProduct(actor, parsed)                                       UNCHANGED
            -> canManageCost(actor.role) gates whether the cost half of the patch is kept
            db.transaction:
              -> assertProductOwned(tx, orgId, productId)        [cross-tenant -> NotFoundError]
              -> tx.update(product).set(patch)...                [dup name+size -> ConflictError]
            -> selectProducts(actor, eq(product.id, productId), 1)   [re-derives `incomplete`, cost-gated]
  <- ActionResult<ProductSummary>
  client: on ok, patch ONLY that row's local table state from the RETURNED ProductSummary
          (Risk 6, never the locally-typed string) — no router.refresh() per cell
          (Amendment 2, 2026-08-12: ~180 sequential full-page refreshes across a 90-cost
          sitting broke Gate 1's under-45-minutes budget). On failure, revert the cell and
          show fieldErrors.currentUnitCost / fieldErrors.caseSize inline. A full
          router.refresh() runs only on navigation away or an explicit user action, so
          incomplete pills and dashboard-adjacent counts catch up there, not per keystroke.
```

### 4. Copy a vendor's reorder order

```
app/(office)/office/reorder/page.tsx (server component, unchanged fetch)
  -> reorderListAction()                                    app/actions/reports.ts, UNCHANGED signature
       -> requireRole("owner", "manager")
       -> reports.reorderList(actor)                          lib/domain/reports.ts
            -> getOnHandSnapshot(orgId)   [already fetched; asOfClosedAt now also read off it]
            -> ...existing par/product/vendor joins, unchanged...
  <- ReorderList { asOfCountId, asOfClosedAt, items, productsWithPar }
  page groups items by vendor (unchanged logic), renders one <ReorderVendorBlock>
  per group with { vendorName, items, asOfCountId, asOfClosedAt } as props

ReorderVendorBlock (client)
  "Copy" click
    -> formatReorderOrderText({ vendorName, items, asOfCountId, asOfClosedAt })   lib/reorder-format.ts (pure)
    -> navigator.clipboard.writeText(text)
    -> 2s "Copied" confirmation state, auto-dismiss (catalog-table.tsx:124 convention)
  "Print" click
    -> sets this block as the print target (local/lifted state)
    -> window.print()
    -> window.onafterprint clears the print target
  No server round trip for either button.
```

### 5. Dashboard page load

```
app/(office)/office/page.tsx (server component)
  -> requireOfficeUser()                                     lib/current-user.ts
  -> Promise.all([
       getActiveCountAction(),                                UNCHANGED
       catalogHealthAction(),                                 NEW
       lastClosedCountAction(),                                NEW
       reorderListAction(),                                   UNCHANGED (Decision 11)
     ])
       catalogHealthAction -> requireRole("owner","manager") -> catalog.getCatalogHealth(actor)
            -> COUNT(*) active                                  [uncapped]
            -> COUNT(*) unpriced, SKIPPED entirely for a manager (Decision 12)
            -- no incomplete-count query at all (Amendment 1: the aggregate never had one)
       lastClosedCountAction -> requireRole("owner","manager") -> reports.getLastClosedCount(actor)
            -> single ORDER BY closedAt DESC LIMIT 1 query; totalValue attached iff canSeeCost
  <- four typed results
  render Cards directly from them — no client-side .filter()/.length counting of a
  capped array (the bug #14 exists to fix)
```

---

## Test plan

All tests are `bun:test` domain/action integration tests against a real
MariaDB via `tests/helpers/test-db.ts` (`migrateTestDatabase`, `resetDatabase`,
`createFixtures`, `newClientLineId`), except `reorder-format.test.ts`, which is
a pure-function test with no database — same convention as
`tests/bottle-sizes.test.ts`. There is no DOM test environment in this repo;
no `.test.tsx` file is introduced. UI correctness for slices 2-6 is proven in
a browser per `AGENTS.md` ("a 200 is not evidence"), not by a component test
that does not exist as a harness here.

### `tests/location-write-path.test.ts` (new)

`describe("createLocation")`
- `"writes a row scoped to the actor's organization, active by default"`
- `"a duplicate name in the same org is refused with ConflictError"`
- `"a duplicate name against a RETIRED location in the same org is still refused"` — Decision 1
- `"a duplicate name in a DIFFERENT org succeeds"` — negative control for the unique index's scope

`describe("listLocations")`
- `"returns only active locations by default"`
- `"includeInactive: true also returns retired locations"`
- `"returns only the caller's org's locations — a second org's location is the negative control"`
- `"listLocationsAction (the scan-picker consumer) still excludes a location after it is deactivated"` — **MUTATION-CHECKED**: fails if `listLocations`'s default flips, or if `listLocationsAction` ever passes `includeInactive: true`. This is Risk 1, the single highest risk in the bundle.

`describe("updateLocation")`
- `"renames without touching count_mode when count_mode is omitted"`
- `"a cross-tenant locationId is refused with NotFoundError, and the row is unchanged"` — **MUTATION-CHECKED**: removing the `assertLocationOwned` call lets the write through.
- `"changing count_mode succeeds when the location has no count_line rows"`
- `"changing count_mode is refused when the location has a line on a non-closed count"` — **MUTATION-CHECKED**: removing the guard lets the mode change through. Risk 2.
- `"changing count_mode succeeds when the location's only lines are on a CLOSED count"` — negative control paired with the previous test: proves the guard is "no open lines," not "never touched."

`describe("deactivateLocation")`
- `"sets active = false"`
- `"refuses to deactivate the LAST active location in the org"` — **MUTATION-CHECKED**
- `"deactivating a non-last active location succeeds when at least one other stays active"` — negative control
- `"refuses to deactivate a location with a line on a non-closed count"` — **MUTATION-CHECKED**. Risk 3.
- `"deactivating a location whose only lines are on a CLOSED count succeeds"` — negative control, Decision 4
- `"a cross-tenant locationId is refused with NotFoundError"`

`describe("closed-count immutability under a location edit")` — invariant 1/2
- `"renaming, retiring, and changing a DIFFERENT location's count_mode does not alter an existing closed count_line's unit_cost_at_count or case_size_at_count"` — asserts the snapshot columns are byte-identical before/after; this is the invariant this whole bundle must not quietly violate.

`describe("role gating")` (dynamic `import()` inside the block, mocking `next/headers` and `@/lib/auth`, per `tests/vendor-write-path.test.ts:16-28`'s existing convention)
- `"staff cannot create, update, or deactivate a location"`

### `tests/catalog-write-path.test.ts` (extended)

`describe("inline cost/case-size editing (per-cell updateProductAction)")`
- `"owner's cost edit lands in the database"`
- `"manager's cost edit is silently stripped while other fields in the same call still save"` — Decision 7's crux; domain-layer call with `fx.manager`, no action mocking needed (recon: `updateProduct` already inspects role itself)
- `"manager's case-size edit lands — case size is owner+manager, cost is owner-only, in the same row"`
- `"submitting currentUnitCost: null clears the column to NULL, never 0.00"` — covers the domain-layer half of Risk 5. The client-side `"" -> null` conversion itself is UI code with no DOM harness to test here; noted as a manual/browser check in `04-slices.md`, not silently assumed covered.
- Amendment 2 (2026-08-12) test-plan entry: the domain-layer stripped-cost
  test above is what the client's row-patch behavior depends on — the client
  must render the cell from `updateProductAction`'s **returned**
  `ProductSummary`, not the locally-typed value, and must not call
  `router.refresh()` per cell. There is no DOM harness in this repo to
  assert that directly, so it is verified manually in the browser per
  `04-slices.md`'s Slice 4 check, not silently assumed covered here.

### `tests/catalog-health.test.ts` (new)

`describe("getCatalogHealth")`
- `"activeCount is correct with 101 active products"` — **the test that must fail against a capped implementation**: seeds 101 active products, expects `activeCount === 101`; would fail today against the old `searchProductsAction({ limit: 100 }).length` pattern this replaces.
- `"unpricedCount is null for a manager caller"` — invariant 8/Decision 12.
- `"a second tenant's products never affect the counts"` — negative control.

No `incompleteCount` test — Amendment 1 (2026-08-12) deleted the field
itself rather than testing it against `incompleteReasons` for drift; the
catalog table's own "needs attention" view still exercises
`incompleteReasons` directly via `tests/catalog-write-path.test.ts` and
needs no cross-check here.

### `tests/reports-write-path.test.ts` (new)

`describe("getLastClosedCount")`
- `"returns the most recently CLOSED count, not the most recently started or submitted one"`
- `"returns null when no count has ever been closed"`
- `"a manager caller never receives totalValue; an owner caller does"` — invariant 8
- `"a second tenant's closed count never appears"` — negative control

### `tests/reorder-format.test.ts` (new, pure — no database)

`describe("formatReorderOrderText")`
- `"includes the vendor name, the as-of count id and close date, and one line per item with its suggested quantity"`
- `"labels a null asOfClosedAt distinctly rather than omitting the date silently"` — Risk 8
- `"an empty items array still produces a labeled, non-empty block"`

### `tests/session-sweep.test.ts` (new)

`describe("sweepExpiredSessions")`
- `"deletes only rows whose expires_at is in the past, leaving a future-expiring session untouched"`
- `"respects its batch size — batchSize: 2 against 5 expired rows deletes exactly 2"` — **MUTATION-CHECKED**: removing the `LIMIT` clause deletes all 5 in one call.
- `"is not scoped to organization — a second tenant's expired session is deleted too"` — deliberate exception (invariant 9); a positive assertion that scoping is absent, so a future "fix" that adds one is caught (Risk 9).

### Not automated — script/shell guards (slices 7a, 7b)

- `scripts/create-user.ts`'s import guard has no test, matching the existing
  precedent: `db/seed.ts`'s identical guard has none either. Verified by
  code review against the working pattern, not a new test.
- `scripts/docker-up-guard.sh` is a shell script with no `bun:test` coverage
  path (nothing in this repo tests shell scripts). Verified manually — start
  a LAN session, then run `docker:up` and watch it refuse, naming
  `docker:up:lan` in the refusal (Amendment 3's exact proof step,
  2026-08-12); then `docker:down` and confirm `docker:up` succeeds. Recorded
  as a manual check in `04-slices.md`, per `AGENTS.md`'s "verify in a
  browser, not curl" for exactly this class of infrastructure script. No
  state file to reconcile or delete — Amendment 3 removed it.

---

## Least confident decisions

Status as of 2026-08-12: items 1-3 below are what Gate 3 review surfaced as
its three objections to Gate 2, and the orchestrator RESOLVED all three (see
`02-architecture.md`'s "Amendments" section, dated 2026-08-12). Kept here,
marked resolved, as the record of what was flagged and how it was decided —
not deleted. Items 4 and 5 were accepted as originally written, unchanged.

1. **RESOLVED by Amendment 1 (2026-08-12).** ~~`getCatalogHealth`'s
   `incompleteCount` as a hand-written SQL predicate (Gate 2's Data section)
   may be the wrong tradeoff.~~ Gate 2's own Risk 4 names the exact failure
   this creates: the SQL predicate must be kept in lockstep with
   `incompleteReasons` by hand, with only a cross-check test as a backstop.
   Since `getCatalogHealth` lives in the same file as `incompleteReasons`
   and catalogs are ~100-200 rows, fetching the uncapped raw columns
   (`brand, category, unit_type, case_size, current_unit_cost`) and running
   `incompleteReasons` itself in JS would cost one query either way and
   remove the drift risk **by construction** instead of by test. The
   resolution went further than either option raised here: the aggregate's
   `incompleteCount` field was deleted outright, because the dashboard has
   no "incomplete" tile to back it in the first place (verified against
   `app/(office)/office/page.tsx`) — there was nothing to reconcile.
2. **RESOLVED by Amendment 2 (2026-08-12).** ~~Per-cell `updateProductAction`
   reuse (Gate 2 Decision 7) for up to ~180 sequential writes in one
   sitting.~~ Each commit re-runs `selectProducts` (a fresh, cost-gated
   re-derivation) and the client called `router.refresh()`, which
   re-rendered the whole visible table — on a ~100-150 row catalog that was
   180 full-page Server Component round trips for a single evening's data
   entry, not 180 single-row patches. The alternative proposed here — patch
   just the edited row's returned `ProductSummary` into local state, and
   never call a per-cell `router.refresh()` — is exactly what Amendment 2
   adopted, with the full refresh deferred to navigation-away or an explicit
   user action rather than a manual "Done" button or idle timer.
3. **RESOLVED by Amendment 3 (2026-08-12).** ~~The gitignored LAN state file
   (`#24`, Decision 8) may be unnecessary given Risk 9's own requirement.~~
   Since the guard must independently reconcile against real container state
   regardless of what the file says, the file only ever *added* information
   when the container check was ambiguous — and `docker inspect` naming the
   `tls` profile's proxy container is not ambiguous. The simpler design
   flagged here (query container state directly, no file) is exactly what
   Amendment 3 adopted — no state file, no stale-file failure mode (former
   Risk 7 is now obsolete).
4. **ACCEPTED as originally written (2026-08-12).** `hasOpenCountLines`'s
   join direction. As written it joins `count_line` to `count` filtering
   `status <> 'closed'`. This is correct today, but if a count's status enum
   ever grows a new terminal state that is also effectively immutable
   (Gate 2's own Decision 3 reasoning is "closed counts are safe because
   they're frozen"), this predicate would need to widen alongside it — a
   comment at the call site pointing back at `countStatusEnum` (not just at
   Decision 3/4's prose) now ties the two together, so a future change to
   the enum surfaces this function in the blast radius. See the Data section
   in `02-architecture.md` and the JSDoc above.
5. **ACCEPTED as originally written (2026-08-12).** Where the session-sweep
   domain logic lives. Gate 2 left this open ("`lib/domain/sessions.ts` — or
   a plain query in a new script"). The domain-file choice, for testability
   and consistency with "business logic lives in `lib/domain/*`," stands as
   written — flagged originally because Gate 2 explicitly deferred it rather
   than choosing, not because it was in doubt.
