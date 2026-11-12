# Truestock

Beverage and food inventory for bars and restaurants, costed from supplier invoices. Counted, costed, and correct.

This file is the always-loaded core: every rule, stated short. **The reason behind each
rule — the incident, the failure mode — is in [`docs/lessons.md`](docs/lessons.md)**
under the same heading. Read that section before changing anything a rule touches.

## Start of a session

1. **`STATE.md`** — *what is proven vs. merely built*, the distinction that matters most
   here. Read its "One-line status" and "What is built but unproven".
2. **The active plan**, if the task is part of one: every doc in `docs/plans/<slug>/`,
   starting with `00-status.md` (resume rule in `docs/plans/README.md`).
3. **Only what the task touches:** `docs/spec.md` (scope, data model — the source of
   truth; read the relevant section, not all of it), `docs/open-items.md` (look items up
   by number — each says the trigger that makes it due; most are correct to ignore until
   then), `ROADMAP.md` (what comes next), `docs/go-live.md` (the gate before the first
   deploy), `docs/known-defects.md`.

## What we are building

A manager walks the bar with an Android phone, scans each bottle's barcode, and records
how much is left. Output: a valued inventory count, par-level reorder lists, and an
audit-ready record.

**Core loop:** scan barcode → product resolves → tap tenths (open bottles) or enter a
quantity (sealed) → next. **Two count buckets:** sealed backstock (60–75% of units) needs
only a number; open bottles need a fill level. They are handled differently on purpose.

## Stack

| Layer | Choice |
|---|---|
| Hosting | Hostinger Cloud Startup, managed Node.js web app |
| Runtime | Node (not Bun, not Deno — the host decides this) |
| Framework | Next.js 16, App Router, TypeScript |
| Database | MariaDB 11.8 (what Hostinger's "MySQL" actually is) |
| ORM | Drizzle + drizzle-kit |
| Auth | Better Auth (NOT NextAuth — it is in maintenance mode) |
| UI | Tailwind + shadcn/ui |
| Barcode | Native `BarcodeDetector` + `barcode-detector` WASM polyfill |
| Forms / data | React Hook Form + Zod, TanStack Query, TanStack Table |
| Package manager | `bun install` is fine; run the app on Node. Bun is pinned to 1.4.0 in CI, deploy and the Dockerfile — change all three together |

**Config that must not drift:**
- `output: 'standalone'` and `images: { unoptimized: true }` in `next.config.ts`.
- Database connection pool of 5–10 (the plan allows 100 connections, shared with the website).
- **The CSP is served from `middleware.ts` with a per-request nonce — never from
  `next.config.ts` `headers()`.** A static CSP makes every page render, return 200, and
  never hydrate. **A 200 is not evidence that a page works.** (Enforced by an edit hook.)
  → [lessons](docs/lessons.md#the-csp-lives-in-middleware-with-a-nonce)
- **MariaDB, not MySQL** — but the driver stays `mysql2`, drizzle's dialect stays
  `"mysql"`, and `DATABASE_URL` keeps `mysql://`; all correct for MariaDB. MariaDB has no
  native JSON type, so `partial_fills` parsing is a *driver* guarantee that must stay
  covered by a test. → [lessons](docs/lessons.md#the-database-is-mariadb-not-mysql)

## Commands and the definition of done

| | |
|---|---|
| Typecheck | `bun run typecheck` |
| Lint | `bun run lint` (0 errors; existing warnings are known) |
| Unit + DB tests | `bun run test` with `DATABASE_URL` pointing at a database whose name ends in `_test` (the suite truncates every table and refuses any other name); in Docker: `bun run test:docker` |
| Browser (e2e) | `bun run e2e:desktop` and `bun run e2e:mobile` against a running production build — see `e2e/README.md`; CI runs both in full. `bun run e2e:phone` (a real Android phone) is a dev/QA run, never CI |
| Build | `bun run build` |
| Migrations | `bun run db:generate` (never hand-edit SQL) · `bun run check:migrations-immutable` |

**Before reporting any task complete:** run typecheck, lint and test, and paste the tail
of each output. For anything under `app/` or `components/`, also drive it in a browser
(`bun run e2e`, or the rig in `e2e/README.md`) — a UI change is not done until a browser
has shown it working. **If a test fails, fix the code, not the test.** Never skip,
weaken, or `.failing` a test to get to green; a known defect is pinned with
`test.failing` *before* it is fixed, never after (see `docs/known-defects.md`). A fix
that is not mutation-checked — revert it, watch the test go red — proves nothing about
that fix.

## MVP scope — do not exceed without asking

**Out of the MVP (deferred, do not build without the named phase):** AI fill
estimation, bottle photos, Toast PMIX import, variance reporting, and the full
compliance module (month-end food/liquor figures and regulator-ready reporting).

*The MVP contains no AI and no file storage. Phase 2.5 is the deliberate
exception: invoice OCR, retained local invoice files, and a limited date-range
export of invoice files plus count snapshots are built there. The broader
compliance module remains Phase 6; the Phase 2.5 export does not silently pull
that whole phase forward.*

It is **multi-tenant** (invariant 9) but one org per user, seeded by hand — no org
switcher, billing, signup or subdomains. Invoice automation (Phase 2.5) replaces
xtraCHEF; deposits are never folded into product cost; auto-approval stays off until
~100 real invoices. → [lessons](docs/lessons.md#two-decisions-that-changed-the-shape-of-this-2026-07-27)

## Non-negotiable invariants

Correctness rules, not preferences. Violating them produces numbers that look plausible
and are wrong — the worst failure mode this app has. **A plausible-but-wrong default is
more dangerous than an obviously broken one**: derive defaults from the seed catalog and
assert them in a test. → [lessons](docs/lessons.md#a-plausible-but-wrong-default)

1. **Closed counts are immutable.** Status `closed` means no edits, ever. Corrections are
   new adjustment records. Never update a closed count's lines.
2. **Snapshot cost and case size onto the count line** (`unit_cost_at_count`,
   `case_size_at_count`). Never value a historical count from current product data.
3. **`UNIQUE (count_id, product_id, location_id)` on CountLine.** A second scan of the
   same product in the same location increments the line; it never inserts a second row.
4. **Store cases and eaches separately.** Never convert cases to eaches at entry time.
   `case_size` changes; observations must not.
5. **`client_line_id` (UUID) makes writes idempotent.** A retried submit must not create
   a duplicate row.
6. **Never hard-delete a product** (or location, vendor, user) — set `active = false`;
   history references it.
   **Refuse inactive rows on the WRITE path, above any existing-row lookup**, not only in
   reads. → [lessons](docs/lessons.md#invariant-6--active--false-on-the-write-path)
7. **Authorization is checked in every server action and route handler**, not only in
   middleware. Several Next.js CVEs are middleware bypasses; defence in depth makes them
   non-events.
8. **Cost and margin data is gated by role.** Staff never see it.
9. **Every query is scoped to one organization.** `Actor.organizationId` comes from
   `requireSession`, never from client input; reads filter on it, writes stamp it.
   Client-supplied ids are **ownership-checked, not just existence-checked**; a
   cross-tenant id is `NotFound`. `user.email` and `count_line_write.client_line_id` are
   deliberately global. → [lessons](docs/lessons.md#invariant-9--tenant-scoping)
10. **Draft depletion is grossed up by the waste factor** — a pour draws
    `pour / (1 - waste_factor)`. Theoretical depletion only, never counted inventory.
    Draft gets `0.100`, everything else `0.000`. → [lessons](docs/lessons.md#invariant-10--the-waste-factor)
11. **Deactivating a user revokes their sessions in the same `db.transaction`.**
    → [lessons](docs/lessons.md#invariant-11--deactivation-revokes-sessions)

## Roles

`owner` — everything. `manager` — counts, receiving, reorder. No cost visibility.
`staff` — count only.

## Domain vocabulary

- **Par / par level** — target stock to hold for a product
- **Tenths** — fill granularity for open bottles; `partial_fills` is a JSON array like `[0.3, 0.8]`
- **Each vs case** — beer is counted both ways; barcodes carry `pack_level`
- **Handle** — a 1.75L bottle
- **86** — out of stock
- **Ullage** — the empty space in a partly-full vessel
- **Half barrel / quarter barrel / sixtel** — keg sizes: 1984 oz, 992 oz, 660.5 oz
- **Waste factor** — beer lost to foam, line cleaning, and the first and last pour

## The catalog

The seed is the three CSVs in `docs/catalog/`, deterministic extracts of
`docs/handlebar-catalog.xlsx` (named before the Handlebar → Truestock rename), which was
built from the owner's two prior spreadsheets. **100 products:** 65 spirits, 16 bottled beers, 9 draft kegs, 5 wines,
2 liqueurs, 3 NA. (The CSV leads the xlsx by three 1 L spirit rows — Black Velvet, Maker's
Mark, Grey Goose, 1000 ml, open item #47; the xlsx was not regenerated and no script does so.)

- **Costs come from supplier invoices**; valuation can't be tested until they are filled.
- **`case_size` is for the 16 bottled beers only.** NULL on spirits, liqueurs, wine, NA
  and kegs is correct, not missing — do not backfill it.
  → [lessons](docs/lessons.md#case_size-is-for-bottled-beer-not-liquor)
- **Spirits default to 750 ml.** A 1.75L handle is its own row (own barcode, case cost,
  pour economics).
- **`upc` is deliberately blank** — it fills through scan-to-enroll during the first count.
- Wines are varietals (`Merlot`, `Chardonnay`) and need a producer before they can be
  costed or scanned.
- The **Draft Economics** tab is the owner's pour model (16 / 22 oz, per-keg waste, margin
  per pour) — the manual prototype of the variance report. Read it before building that.

## Draft beer

Draft is simpler than it looks and should not be special-cased:

- A keg is a Product with `unit_type: keg` and `size_ml` set to its volume
  (half barrel 58,674 · quarter barrel 29,337 · sixtel 19,533).
- A tapped keg records as a decimal in `partial_fills`, same as a bottle.
- Tap lines can be modelled as Locations (`Tap 1`, `Tap 2`) — no schema change needed.
- **Draft menu items map one-to-one to products** (one Toast item, one product, one pour
  size), so the recipe map is nearly free for draft; cocktails are the tedious part.
- Eyeballing a keg's level is not possible. Tenths is the MVP answer; weight
  (`empty_weight_g`, `full_weight_g`) is the accurate method, deferred.

## Working agreements

Each links to its reason in `docs/lessons.md`.

- **The catalog is the foundation.** Scan-to-enroll: an unknown barcode opens a fast
  new-product form that must stay under **20 seconds** to complete. If it gets slow, the
  catalog decays and the whole system dies. The highest-risk interaction.
- **Always offer a search picker beside the scan button** — damaged labels, house
  infusions and some wine have no usable barcode.
- **The active location is locked per leg**; "count something elsewhere" records a stray
  bottle and returns to the current leg, never silently switching it. Input mode (tenths
  vs quantities) is driven by location. Don't copy the free-switch dropdown in
  `prototypes/count-scan.html`. → [lessons](docs/lessons.md#the-active-location-is-locked-per-leg)
- **Count-line writes are optimistic** — UI first, background save, pending writes queue
  in IndexedDB; the server stays authoritative.
- **A quantity SET shows its before/after on the button, live** (`SET TO 3 EA / was 12 ea
  · −9`, `ADD 3 EA / 12 → 15`). No confirmation modal.
  → [lessons](docs/lessons.md#a-quantity-set-shows-its-beforeafter)
- **One fresh `client_line_id` per write attempt, never one per count line**; reuse an id
  only to resend the same failed request.
  → [lessons](docs/lessons.md#one-fresh-client_line_id-per-write-attempt)
- **Row-level edit is a real `<button>`, never an `onClick` on the `<tr>`** (remove the
  row's `onClick`; don't bolt `role`/`tabIndex` on). Edit forms name their subject
  (`Edit Speed Rail`). (Warned by an edit hook.)
  → [lessons](docs/lessons.md#row-level-edit-is-a-real-button)
- **Barcodes are only stored or looked up through `normalizeBarcode` (`lib/barcode.ts`)**
  — the 14-digit GTIN; 8-digit codes converted only when the camera reported the format.
  Test fixtures insert the standard form. → [lessons](docs/lessons.md#barcodes-go-through-normalizebarcode)
- **Sizes are printed only by `formatProductSize` (`lib/bottle-sizes.ts`)** — `750 ml`,
  `1.75 L`, `Sixtel keg` — on the phone and in the back office alike. Never format
  `size_ml` inline in a component.
- **The scanner's fallback engine loads from this origin** (`/zxing/zxing_reader.wasm`,
  copied by `scripts/copy-zxing-wasm.mjs`), never a CDN.
  → [lessons](docs/lessons.md#the-scanners-engine-loads-from-this-origin)
- **Dim-bar UI.** High contrast, large tap targets, dark mode, one-handed — the other hand
  is holding a bottle.
- **Any form whose submit is handled in JavaScript carries `method="post"`** (a method-less
  form submits as GET before hydration — it once leaked a password into the URL). (Warned
  by an edit hook.) → [lessons](docs/lessons.md#js-submitted-forms-carry-methodpost)
- **Verify UI work in a browser, not with `curl`.** → [lessons](docs/lessons.md#verify-ui-work-in-a-browser)
- Migrations go through drizzle-kit; applied migrations are append-only (blocked by an
  edit hook and by CI). No hand-edited schema drift.
- Conventional commits. Small, reviewable changes.
- **Every work branch PRs into `qa-release`, never `main`.** `main` is production
  and accepts only the `qa-release` release PR or a `hotfix/*` branch, and only as
  merge commits. After a hotfix, back-merge `main` into `qa-release` with a merge
  commit. The required `branch-policy` check enforces the source branch. See
  `docs/branching.md`. Branch new work from `origin/qa-release`, not `origin/main`.

## Open questions — ask, don't assume

1. **Shelf life.** The owner's previous sheet tracked *Discard Date*, *Days Until Discard*,
   and *Status*. Nothing in the current spec covers it. If it was load-bearing (opened
   vermouth, cream liqueurs), it needs a home before the schema hardens.
2. **Par scope.** Undecided whether par is per product or per location. `ProductPar` is
   built with a nullable `location_id` so this can stay unanswered — write null rows for now.
3. **Open vs sealed split.** How many of the 95 units are open bottles versus sealed
   backstock is still unknown. It drives the counting-speed estimates.
4. **Count cadence.** Weekly gives usable variance; monthly barely does. Not yet fixed.

## The team and the planning workflow

Subagents live in `.claude/agents/`; per slice, build in this order:
`database` → `backend` → `frontend` + `ui-design` (sequential — they both edit `app/`) →
`code-reviewer` and `security-reviewer` (read-only, safe in parallel) → `devops` once
ship-ready. Running two writers on the same files collides; independent slices can run in
separate git worktrees. Agent memory (`.claude/agent-memory/`) **is tracked in git** —
shared context across sessions and machines (owner decision 2026-11-08); don't untrack it.

Non-trivial work (schema changes, new endpoints, anything touching the count-write path)
goes through the 4-gate workflow — Product → Architecture → Program Design → Vertical
Slices — in `docs/plans/<slug>/`, each gate approved by the user (`docs/plans/README.md`,
including when to skip it). `STATE.md` / `ROADMAP.md` / `docs/open-items.md` stay
authoritative for *what* and *when*; the plan folder for *how*, for that feature's
lifetime. When a feature ships, add one line to `docs/history/state-log.md`.
→ [lessons](docs/lessons.md#planning-workflow--the-two-things-easy-to-get-backwards)

## Guardrails that run on their own

`.claude/settings.json` allowlists the safe inner loop and wires
`.claude/hooks/guard-edits.mjs`: it **blocks** edits to applied migrations and a CSP in
`next.config.ts`, and **warns** on a method-less `<form>` or `onClick` on a row. Pinned
by `tests/edit-guards.test.ts`. CI (`.github/workflows/ci.yml`) runs typecheck, lint, the
DB suite, the migration check, the build, and the whole Playwright suite against a
production build, as two runs (desktop, emulated mobile; the real-phone project is dev/QA only); `workflow-lint.yml` runs actionlint on every workflow. Each PR gets an
independent Claude review against `REVIEW.md` (informational — it never approves or
blocks). **Deploys wait for the owner's approval** (`production` environment), and the
release job refuses to run if that environment is unprotected (`docs/deploy.md` §3).

## CodeGraph (local only)

If `.codegraph/` exists, reach for `codegraph_explore` (MCP) or `codegraph explore "…"`
before grep. It is gitignored, so cloud sessions, CI and fresh worktrees have no index —
then use grep/glob, and don't install or build it unless asked. → [lessons](docs/lessons.md#codegraph)
