# Truestock

Beverage and food inventory for bars and restaurants, costed from supplier invoices. Counted, costed, and correct.

**Read `docs/spec.md` before any non-trivial work.** It is the source of truth for scope,
data model, and rationale. This file is the short version.

**Read `docs/open-items.md` too.** It lists what is deliberately unfinished and, more
importantly, the trigger that says when each item becomes due. Most are correct to
ignore until then.

**`STATE.md` says where the project actually is** — specifically what is *proven*
versus what is merely built, which is the distinction that matters most here.
`ROADMAP.md` is what comes next. `docs/go-live.md` is the gate before the first
deploy and the list to verify after it.

---

## What we are building

A manager walks the bar with an Android phone, scans each bottle's barcode, and records
how much is left. Output: a valued inventory count, par-level reorder lists, and an
audit-ready record.

**Core loop:** scan barcode → product resolves → tap tenths (open bottles) or enter a
quantity (sealed) → next.

**Two count buckets.** Sealed backstock is 60–75% of units and only needs a number.
Open bottles are the ones needing a fill level. They are handled differently on purpose.

---

## Stack

| Layer | Choice |
|---|---|
| Hosting | Hostinger Cloud Startup, managed Node.js web app |
| Runtime | Node (not Bun, not Deno — the host decides this) |
| Framework | Next.js 16, App Router, TypeScript |
| Database | MariaDB 11.8 (what Hostinger's "MySQL" actually is — see below) |
| ORM | Drizzle + drizzle-kit |
| Auth | Better Auth (NOT NextAuth — it is in maintenance mode) |
| UI | Tailwind + shadcn/ui |
| Barcode | Native `BarcodeDetector` + `barcode-detector` WASM polyfill |
| Forms / data | React Hook Form + Zod, TanStack Query, TanStack Table |
| Package manager | `bun install` is fine; run the app on Node |

**Config that must not drift:**
- `output: 'standalone'` in `next.config.ts`
- `images: { unoptimized: true }`
- Database connection pool of 5–10 (the plan allows 100 connections, shared with the website)
- **The CSP is served from `middleware.ts` with a per-request nonce, and must
  never move back into `next.config.ts`'s `headers()`.** Next's App Router
  delivers the request id (`self.__next_r`) and the streamed RSC payload
  (`self.__next_f.push`) as *inline* `<script>` tags. A static header cannot
  carry a nonce, so `script-src 'self'` blocks both and **nothing on any page
  hydrates**. Setting it in both places is worse than either alone: browsers
  intersect multiple CSP headers, so the nonce-less one keeps blocking.
  This is not hypothetical — it shipped in and was caught only by opening a
  browser (2026-07-28). The failure is silent by construction: the server
  renders correctly and returns 200, so `curl`, `next build`, the `/ship` gate
  and every status-code check pass against a completely inert app. **A 200 is
  not evidence that a page works.** Note also that Chrome reports CSP
  violations through a channel the devtools console API does not carry, so the
  absence of a "Refused to execute inline script" message proves nothing.

**The database is MariaDB, not MySQL — corrected 2026-07-28.** hPanel's menu says
"MySQL Databases" and every document in this repo took that at face value.
`SELECT VERSION()` against the real host returns `11.8.8-MariaDB-log`. Local
development runs `mariadb:11.8` in Docker (`docker-compose.yml`) so the gate
tests the engine production actually runs.

What does **not** change, and should not be "fixed": the driver stays `mysql2`,
drizzle's dialect stays `"mysql"`, and `DATABASE_URL` keeps the `mysql://`
scheme. All three are correct for MariaDB — it speaks the MySQL wire protocol.

The schema was re-verified on MariaDB 11.8 and is portable: migrations apply
clean from empty, the `product_par` generated column still rejects a second
overall par (1062), composite tenant foreign keys still reject a cross-tenant
id (1452), and `DECIMAL(10,4)` round-trips exactly.

One real difference to keep in mind: **MariaDB has no native JSON type** —
`JSON` is an alias for `longtext`. `partial_fills` still comes back as a parsed
array because mysql2 parses it, and drizzle has no `mapFromDriverValue` of its
own for MySQL JSON. That makes the guarantee a *driver* one, not a schema one,
so it must be covered by a test rather than assumed after a driver bump.

---

## MVP scope — do not exceed without asking

**Out of the MVP (deferred, do not build without the named phase):** AI fill
estimation, bottle photos, Toast PMIX import, variance reporting, and the full
compliance module (month-end food/liquor figures and regulator-ready reporting).

*The MVP contains no AI and no file storage. Phase 2.5 is the deliberate
exception: invoice OCR, retained local invoice files, and a limited date-range
export of invoice files plus count snapshots are built there. The broader
compliance module remains Phase 6; the Phase 2.5 export does not silently pull
that whole phase forward.*

### Two decisions that changed the shape of this, 2026-07-27

**This is going to be sold, so it is multi-tenant** \(invariant 9\). Done before
the first migration ever ran, because tenant isolation is the one thing that is
cheap now and a data migration plus a full invariant re-audit later. What is NOT
built: a user belonging to more than one organization, an org switcher, billing,
signup, or per-tenant subdomains. One org per user, seeded by hand. All of that
is additive.

**Invoice automation is built in Phase 2.5** — it requires AI \(OCR\) and
file storage \(two-year retention, spec §10\). The xtraCHEF subscription is not
used; costs are captured from supplier invoices through the pipeline built in
Phase 2.5. It covers secure upload and archive, pdf-inspector for text PDFs,
Claude Vision for scanned/mixed documents, arithmetic checks, human review,
vendor-alias matching, atomic cost posting, and the limited audit export named
above. Deposits are never folded into product cost. Auto-approval stays off
until about 100 real invoices provide correction data. The full Phase 2.5
product metric — 20–25 real invoices reviewed in under 30 minutes — is still a
field measurement, not a claim made by the implementation alone.

## Non-negotiable invariants

These are correctness rules, not preferences. Violating them produces numbers that look
plausible and are wrong, which is the worst failure mode this app has.

**A plausible-but-wrong default is more dangerous than an obviously broken
one, and this is not hypothetical — see "Draft beer" below.** The enroll
form's keg size once defaulted to 750 ml, which is absurd on sight and
self-correcting: nobody ships a keg count that small. It was changed to
58674 (a half barrel), which looks like a real keg and is wrong for 7 of the
9 kegs this bar actually stocks — and the whole point of a preselected
default on a 20-second enroll form is that the counter is not expected to
check it. The fix is not "pick a better guess"; it is deriving the default
from the seed catalog and asserting it in a test, so the default and the
catalog cannot drift apart silently again.

1. **Closed counts are immutable.** Status `closed` means no edits, ever. Corrections are
   new adjustment records. Never update a closed count's lines.
2. **Snapshot cost and case size onto the count line** (`unit_cost_at_count`,
   `case_size_at_count`). Never value a historical count from current product data.
3. **`UNIQUE (count_id, product_id, location_id)` on CountLine.** Scanning the same
   product twice in the same location increments the existing line. It never inserts a
   second row.
4. **Store cases and eaches separately.** Never convert cases to eaches at entry time.
   `case_size` changes; observations must not.
5. **`client_line_id` (UUID) makes writes idempotent.** A retried submit must not create
   a duplicate row.
6. **Never hard-delete a product.** Set `active = false`. History references it.
   **And `active = false` must be enforced on the WRITE path, not only excluded
   from reads.** Excluding a row from a list query does not stop writes to it: a
   client that loaded the row before it was deactivated still holds a valid id,
   and its next write succeeds silently. This shipped for locations on 2026-08-12
   and was caught in review — retiring a location removed it from the scan picker
   on a *fresh fetch*, but the scan screen fetches locations once and holds them
   per leg by design, so a counter mid-session kept writing into a retired
   location with no error anywhere. The `active` check belongs in the write path,
   **above** any existing-row lookup so it runs on every write and not just the
   insert. A "refuses retirement while in use" guard is not a substitute — a
   client that has loaded the row but not yet written leaves nothing to detect.
7. **Authorization is checked in every server action and route handler**, not only in
   middleware. Several Next.js CVEs are middleware bypasses; defence in depth makes them
   non-events.
8. **Cost and margin data is gated by role.** Staff never see it.
9. **Every query is scoped to one organization.** `organization` is the tenant
   boundary. `Actor.organizationId` comes from `requireSession`, re-read from the
   database on every call and never from client input. Every domain read filters on
   it; every write stamps it. A cross-tenant lookup returns `NotFound`, never an
   answer that confirms the row is real.
   Client-supplied ids (`productId`, `locationId`, `countId`, `countLineId`) are
   **ownership-checked, not just existence-checked** — a foreign key proves a row
   exists, not whose it is. That gap was a real finding in review: an unchecked
   `locationId` leaked another tenant's location name.
   Two constraints are deliberately NOT per-tenant, and both should stay that way:
   `user.email` (Better Auth resolves sign-in by email with no tenant in hand) and
   `count_line_write.client_line_id` (a v4 UUID that *is* the idempotency
   mechanism — scoping it would make the guarantee depend on the retry carrying a
   matching org).
10. **Draft depletion is grossed up by the waste factor.** A 16 oz pour draws
   `16 / (1 - waste_factor)` ≈ 17.8 oz from the keg. Theoretical usage that ignores this
   makes every keg look ~10% short and turns the variance report into false positives.
   Applies to *theoretical depletion only* — never to counted inventory, which is measured
   as it actually is.
11. **Deactivating a user revokes their sessions in the same transaction.** Setting
   `active = false` and deleting that user's `session` rows happen inside one
   `db.transaction` — never one without the other. `lib/authz.ts` already re-reads
   `active` on every request and refuses an inactive account, so this is defence in
   depth: it closes the window where a session row minted before deactivation is still
   a valid Better Auth credential. Enforced in `lib/domain/users.ts` and covered by
   `tests/user-management.test.ts` against a real MariaDB (mutation-checked: removing
   the session delete fails exactly the revocation test). The mirror of invariant 6 —
   users, like products, are deactivated, never hard-deleted; history references them.

---

## Roles

`owner` — everything. `manager` — counts, receiving, reorder. No cost visibility.
`staff` — count only.

---

## Domain vocabulary

- **Par / par level** — target stock to hold for a product
- **Tenths** — fill granularity for open bottles; `partial_fills` is a JSON array like `[0.3, 0.8]`
- **Each vs case** — beer is counted both ways; barcodes carry `pack_level`
- **Handle** — a 1.75L bottle
- **86** — out of stock
- **Ullage** — the empty space in a partly-full vessel
- **Half barrel / quarter barrel / sixtel** — keg sizes: 1984 oz, 992 oz, 660.5 oz
- **Waste factor** — beer lost to foam, line cleaning, and the first and last pour

---

## The catalog

`docs/truestock-catalog.xlsx` is the seed, built from the owner's two prior spreadsheets.
**97 products:** 62 spirits, 16 bottled beers, 9 draft kegs, 5 wines, 2 liqueurs, 3 NA.

Things to know about it:

- **Costs are not filled in yet.** They come from supplier invoices. Nothing that depends
  on valuation can be tested until they are.
- **`case_size` applies to bottled beer, not liquor.** Liquor is counted as bottles —
  eaches and partial fills — so `case_size` stays NULL for all 62 spirits, the 2 liqueurs,
  5 wines and 3 NA, and that is correct rather than missing data. Only the **16 bottled
  beers** are counted both ways and need a case size. Draft kegs don't either: a keg is one
  unit measured in tenths.
  This matters because `computeLineUnits` only treats a NULL `case_size` as indeterminate
  when `sealed_case_qty > 0` — "zero cases of an unknown size" is unambiguously zero. So a
  NULL case size on liquor never excludes a line. Do not "fix" the catalog by backfilling
  case sizes onto spirits; that would invent a pack level the bar doesn't use.
- **Spirits default to 750 ml.** Anything also stocked as a 1.75L handle needs its own
  row — different barcode, different case cost, different pour economics.
- **`upc` is deliberately blank.** It fills through scan-to-enroll during the first count.
- Wines are currently varietals (`Merlot`, `Chardonnay`) rather than specific bottles.
  They need a producer before they can be costed or scanned.
- The **Draft Economics** tab holds the owner's own pour model: 16 oz and 22 oz serving
  sizes, per-keg waste factor, margin per pour. It is the manual prototype of the Phase 2
  variance report — read it before building that.

## Draft beer

Draft is simpler than it looks and should not be special-cased:

- A keg is a Product with `unit_type: keg` and `size_ml` set to its volume
  (half barrel 58,674 · quarter barrel 29,337 · sixtel 19,533).
- A tapped keg records as a decimal in `partial_fills`, same as a bottle.
- Tap lines can be modelled as Locations (`Tap 1`, `Tap 2`) — no schema change needed.
- **Draft menu items map one-to-one to products.** A 16 oz Coors Light is one Toast item,
  one product, one pour size. This makes the Phase 2 recipe map nearly free for draft;
  cocktails are where the tedious work lives.
- Eyeballing a keg's level is not possible. Tenths is the MVP answer. Weight
  (`empty_weight_g`, `full_weight_g`) is the accurate method, deferred.

## Working agreements

- **The catalog is the foundation.** Scan-to-enroll: an unknown barcode opens a fast
  new-product form. That form must stay under 20 seconds to complete. If it gets slow,
  the catalog decays and the whole system dies. This is the highest-risk interaction.
- **Always offer a search picker beside the scan button** — damaged labels, house
  infusions, and some wine have no usable barcode.
- **The active location is locked per leg, with an escape hatch.** A count covers all five
  locations, but scanning is scoped to one at a time: pick a location, count it, tap
  *Finish section*, move on. A separate "count something elsewhere" action records a stray
  bottle into another location and returns you to the current leg — it never silently
  changes which leg you are in.
  Why it is locked: a wrong active location fails *silently*. Every scan lands on a real,
  legitimate line in the wrong place; the count total stays correct and only the
  distribution is wrong, so nothing looks broken until a reorder list is nonsense weeks
  later. Locking also makes the input-mode switch explicit — Speed Rail and Back Bar are
  tenths, Storeroom is quantities only, and that is driven entirely by location.
  Note: `prototypes/count-scan.html` predates this decision and still shows a free-switch
  dropdown. Do not copy that part of it.
- **Count-line writes are optimistic.** UI updates immediately, saves in the background,
  pending writes queue in IndexedDB. The server stays authoritative.
- **A quantity SET shows its before/after on the button, live.** `ADD` and `SET` take the
  same input in the same box, and afterward the line just reads `3 ea` either way — a SET
  the user meant as an ADD loses bottles with nothing on screen looking wrong. So the
  submit button states the consequence as they type: `SET TO 3 EA / was 12 ea · −9`, or
  `ADD 3 EA / 12 → 15`. No modal — a confirmation dialog on a control used 150 times a
  count gets clicked through blind inside a week, which is worse than no guard because it
  feels like one. The `count_line_write` ledger records the delta either way, so this is
  about the human noticing at the time, not about recovering afterward.
- **One fresh `client_line_id` UUID per write attempt — never one per count line.**
  Idempotency lives in the append-only `count_line_write` ledger, whose unique index on
  `client_line_id` makes a replayed write roll back and return success. Reuse an id only
  when literally resending the same failed request. Reusing one id per line instead would
  make every legitimate second scan of a bottle a silently swallowed no-op — the count
  comes out short with no error anywhere, which is quieter and worse than the
  double-count this ledger replaced.
- **Row-level edit is a real `<button>`, never an `onClick` on the `<tr>`.** Both
  the locations and vendors tables shipped with the row itself as the edit
  affordance and were fixed on 2026-08-12. Three defects at once: it is
  unreachable by keyboard and invisible to a screen reader (`tabIndex: -1`, no
  role) while every other control on the screen is a button; nothing on screen
  says the row is clickable; and because the inline form opens *above* the table,
  every row below it reflows, so a click aimed at one row lands on another. That
  last one put a real location — Speed Rail — into the edit form, one confirm from
  a renamed location and a changed `count_mode`, with nothing looking wrong
  afterwards. **The fix is an explicit Edit button with the row's `onClick`
  removed**, not a `role`/`tabIndex` bolted onto the `<tr>` — that fixes the
  accessibility third and leaves the wrong-target hazard. Any edit form must also
  name its subject in the heading (`Edit Speed Rail`, not `Edit location`).
- **Dim-bar UI.** High contrast, large tap targets, dark mode, one-handed operation.
  The other hand is holding a bottle.
- **Any form whose submit is handled in JavaScript carries `method="post"`.**
  `preventDefault()` only runs once React has attached; before that — or if
  hydration fails outright — the browser submits natively, and a form with no
  method defaults to **GET**, serializing every field into the query string.
  On the login form that put a plaintext password into the server access log,
  the user's history, and the `Referer` of any later outbound link. POST
  degrades to a bare 405 instead, which leaks nothing. Gating the submit
  button on a hydrated flag is the complement, not the substitute: the flag
  handles the ordinary race, the method handles hydration never happening.
- **Verify UI work in a browser, not with `curl`.** Server-rendered HTML and a
  200 prove the server ran, nothing more. Every client-side failure this
  project has hit — the CSP hydration break, the credential leak — was
  invisible to status codes and obvious on first page load.
- Migrations go through drizzle-kit. No hand-edited schema drift.
- Conventional commits. Small, reviewable changes.

---

## Schema delta not yet in docs/spec.md §8

One column must be added to `Product` before the schema is built:

```
waste_factor   DECIMAL(4,3)   NOT NULL DEFAULT 0.000
```

Draft products get `0.100`. Bottles and wine stay `0.000`. Theoretical depletion then
computes as `pour_ml / (1 - waste_factor)`. One column now versus a migration and a
recount later. Update §8 of the spec when you touch it.

## Open questions — ask, don't assume

1. **Shelf life.** The owner's previous sheet tracked *Discard Date*, *Days Until Discard*,
   and *Status*. Nothing in the current spec covers it. If it was load-bearing (opened
   vermouth, cream liqueurs), it needs a home before the schema hardens.
2. **Par scope.** Undecided whether par is per product or per location. `ProductPar` is
   built with a nullable `location_id` so this can stay unanswered — write null rows for now.
3. **Open vs sealed split.** How many of the 95 units are open bottles versus sealed
   backstock is still unknown. It drives the counting-speed estimates.
4. **Count cadence.** Weekly gives usable variance; monthly barely does. Not yet fixed.

## The team

Subagents live in `.claude/agents/`. Suggested sequence for the MVP:

1. `database` — schema and migrations first; everything depends on it
2. `backend` — server actions, route handlers, business logic
3. `frontend` + `ui-design` — the counting screen, then the back office
4. `code-reviewer` and `security-reviewer` — read-only, run after changes
5. `devops` — deploy pipeline, once there is something to deploy

**A note on using them:** `backend` and `frontend` both edit files in `app/`. Run them
sequentially, not in parallel, or they will collide. The read-only reviewers are the ones
that parallelise safely.

## Planning workflow

Non-trivial, multi-file, decision-heavy work (schema changes, new endpoints, anything
touching the count-write path) goes through the software-factory 4-gate workflow:
Product → Architecture → Program Design → Vertical Slices, written to
`docs/plans/<slug>/` and gated on explicit user approval at each stage. See
`docs/plans/README.md` for the gate templates and the skip-the-gates rule for trivial
work. Two things are easy to get backwards, so state them explicitly:

- **Authority split.** `STATE.md` / `ROADMAP.md` / `docs/open-items.md` stay
  authoritative for *what* the project is doing and *when* — status, phase
  sequencing, deferred-item triggers. Unchanged by this workflow.
  `docs/plans/<slug>/` is authoritative for *how* one non-trivial feature gets
  built, for that feature's lifetime only. A feature's Gate 1 doc should cite
  the relevant ROADMAP phase or open-item rather than re-deriving it; when the
  feature ships, STATE.md's history log gets its usual one-line entry.
- **Gate 4 vs. the subagent sequence above — they compose, not compete.** Gate 4
  slices are the *unit of work* (tracer bullet → real logic → one capability
  per slice). The `database → backend → frontend/ui-design →
  code-reviewer/security-reviewer → devops` order is *how each slice gets
  built* — schema first, then business logic, then UI (frontend/ui-design
  sequential, never parallel, per the rule above), then the two read-only
  reviewers in parallel, then devops only once ship-ready.

## CodeGraph

This repo is indexed by CodeGraph — a `.codegraph/` directory holds a regenerable
SQLite knowledge graph of every symbol, edge, and file (not source, not checked in).
Reach for it BEFORE grep/find or reading files when you need to understand or locate
code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in
  one call — the relevant symbols' verbatim source plus the call paths between them,
  including dynamic-dispatch hops grep can't follow. Name a file or symbol in the
  query to read its current line-numbered source.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints
  the same output.
 bottled beer, not liquor.** Liquor is counted as bottles —
  eaches and partial fills — so `case_size` stays NULL for all 62 spirits, the 2 liqueurs,
  5 wines and 3 NA, and that is correct rather than missing data. Only the **16 bottled
  beers** are counted both ways and need a case size. Draft kegs don't either: a keg is one
  unit measured in tenths.
  This matters because `computeLineUnits` only treats a NULL `case_size` as indeterminate
  when `sealed_case_qty > 0` — "zero cases of an unknown size" is unambiguously zero. So a
  NULL case size on liquor never excludes a line. Do not "fix" the catalog by backfilling
  case sizes onto spirits; that would invent a pack level the bar doesn't use.
- **Spirits default to 750 ml.** Anything also stocked as a 1.75L handle needs its own
  row — different barcode, different case cost, different pour economics.
- **`upc` is deliberately blank.** It fills through scan-to-enroll during the first count.
- Wines are currently varietals (`Merlot`, `Chardonnay`) rather than specific bottles.
  They need a producer before they can be costed or scanned.
- The **Draft Economics** tab holds the owner's own pour model: 16 oz and 22 oz serving
  sizes, per-keg waste factor, margin per pour. It is the manual prototype of the Phase 2
  variance report — read it before building that.

## Draft beer

Draft is simpler than it looks and should not be special-cased:

- A keg is a Product with `unit_type: keg` and `size_ml` set to its volume
  (half barrel 58,674 · quarter barrel 29,337 · sixtel 19,533).
- A tapped keg records as a decimal in `partial_fills`, same as a bottle.
- Tap lines can be modelled as Locations (`Tap 1`, `Tap 2`) — no schema change needed.
- **Draft menu items map one-to-one to products.** A 16 oz Coors Light is one Toast item,
  one product, one pour size. This makes the Phase 2 recipe map nearly free for draft;
  cocktails are where the tedious work lives.
- Eyeballing a keg's level is not possible. Tenths is the MVP answer. Weight
  (`empty_weight_g`, `full_weight_g`) is the accurate method, deferred.

## Working agreements

- **The catalog is the foundation.** Scan-to-enroll: an unknown barcode opens a fast
  new-product form. That form must stay under 20 seconds to complete. If it gets slow,
  the catalog decays and the whole system dies. This is the highest-risk interaction.
- **Always offer a search picker beside the scan button** — damaged labels, house
  infusions, and some wine have no usable barcode.
- **The active location is locked per leg, with an escape hatch.** A count covers all five
  locations, but scanning is scoped to one at a time: pick a location, count it, tap
  *Finish section*, move on. A separate "count something elsewhere" action records a stray
  bottle into another location and returns you to the current leg — it never silently
  changes which leg you are in.
  Why it is locked: a wrong active location fails *silently*. Every scan lands on a real,
  legitimate line in the wrong place; the count total stays correct and only the
  distribution is wrong, so nothing looks broken until a reorder list is nonsense weeks
  later. Locking also makes the input-mode switch explicit — Speed Rail and Back Bar are
  tenths, Storeroom is quantities only, and that is driven entirely by location.
  Note: `prototypes/count-scan.html` predates this decision and still shows a free-switch
  dropdown. Do not copy that part of it.
- **Count-line writes are optimistic.** UI updates immediately, saves in the background,
  pending writes queue in IndexedDB. The server stays authoritative.
- **A quantity SET shows its before/after on the button, live.** `ADD` and `SET` take the
  same input in the same box, and afterward the line just reads `3 ea` either way — a SET
  the user meant as an ADD loses bottles with nothing on screen looking wrong. So the
  submit button states the consequence as they type: `SET TO 3 EA / was 12 ea · −9`, or
  `ADD 3 EA / 12 → 15`. No modal — a confirmation dialog on a control used 150 times a
  count gets clicked through blind inside a week, which is worse than no guard because it
  feels like one. The `count_line_write` ledger records the delta either way, so this is
  about the human noticing at the time, not about recovering afterward.
- **One fresh `client_line_id` UUID per write attempt — never one per count line.**
  Idempotency lives in the append-only `count_line_write` ledger, whose unique index on
  `client_line_id` makes a replayed write roll back and return success. Reuse an id only
  when literally resending the same failed request. Reusing one id per line instead would
  make every legitimate second scan of a bottle a silently swallowed no-op — the count
  comes out short with no error anywhere, which is quieter and worse than the
  double-count this ledger replaced.
- **Row-level edit is a real `<button>`, never an `onClick` on the `<tr>`.** Both
  the locations and vendors tables shipped with the row itself as the edit
  affordance and were fixed on 2026-08-12. Three defects at once: it is
  unreachable by keyboard and invisible to a screen reader (`tabIndex: -1`, no
  role) while every other control on the screen is a button; nothing on screen
  says the row is clickable; and because the inline form opens *above* the table,
  every row below it reflows, so a click aimed at one row lands on another. That
  last one put a real location — Speed Rail — into the edit form, one confirm from
  a renamed location and a changed `count_mode`, with nothing looking wrong
  afterwards. **The fix is an explicit Edit button with the row's `onClick`
  removed**, not a `role`/`tabIndex` bolted onto the `<tr>` — that fixes the
  accessibility third and leaves the wrong-target hazard. Any edit form must also
  name its subject in the heading (`Edit Speed Rail`, not `Edit location`).
- **Dim-bar UI.** High contrast, large tap targets, dark mode, one-handed operation.
  The other hand is holding a bottle.
- **Any form whose submit is handled in JavaScript carries `method="post"`.**
  `preventDefault()` only runs once React has attached; before that — or if
  hydration fails outright — the browser submits natively, and a form with no
  method defaults to **GET**, serializing every field into the query string.
  On the login form that put a plaintext password into the server access log,
  the user's history, and the `Referer` of any later outbound link. POST
  degrades to a bare 405 instead, which leaks nothing. Gating the submit
  button on a hydrated flag is the complement, not the substitute: the flag
  handles the ordinary race, the method handles hydration never happening.
- **Verify UI work in a browser, not with `curl`.** Server-rendered HTML and a
  200 prove the server ran, nothing more. Every client-side failure this
  project has hit — the CSP hydration break, the credential leak — was
  invisible to status codes and obvious on first page load.
- Migrations go through drizzle-kit. No hand-edited schema drift.
- Conventional commits. Small, reviewable changes.

---

## Schema delta not yet in docs/spec.md §8

One column must be added to `Product` before the schema is built:

```
waste_factor   DECIMAL(4,3)   NOT NULL DEFAULT 0.000
```

Draft products get `0.100`. Bottles and wine stay `0.000`. Theoretical depletion then
computes as `pour_ml / (1 - waste_factor)`. One column now versus a migration and a
recount later. Update §8 of the spec when you touch it.

## Open questions — ask, don't assume

1. **Shelf life.** The owner's previous sheet tracked *Discard Date*, *Days Until Discard*,
   and *Status*. Nothing in the current spec covers it. If it was load-bearing (opened
   vermouth, cream liqueurs), it needs a home before the schema hardens.
2. **Par scope.** Undecided whether par is per product or per location. `ProductPar` is
   built with a nullable `location_id` so this can stay unanswered — write null rows for now.
3. **Open vs sealed split.** How many of the 95 units are open bottles versus sealed
   backstock is still unknown. It drives the counting-speed estimates.
4. **Count cadence.** Weekly gives usable variance; monthly barely does. Not yet fixed.

## The team

Subagents live in `.claude/agents/`. Suggested sequence for the MVP:

1. `database` — schema and migrations first; everything depends on it
2. `backend` — server actions, route handlers, business logic
3. `frontend` + `ui-design` — the counting screen, then the back office
4. `code-reviewer` and `security-reviewer` — read-only, run after changes
5. `devops` — deploy pipeline, once there is something to deploy

**A note on using them:** `backend` and `frontend` both edit files in `app/`. Run them
sequentially, not in parallel, or they will collide. The read-only reviewers are the ones
that parallelise safely.

## Planning workflow

Non-trivial, multi-file, decision-heavy work (schema changes, new endpoints, anything
touching the count-write path) goes through the software-factory 4-gate workflow:
Product → Architecture → Program Design → Vertical Slices, written to
`docs/plans/<slug>/` and gated on explicit user approval at each stage. See
`docs/plans/README.md` for the gate templates and the skip-the-gates rule for trivial
work. Two things are easy to get backwards, so state them explicitly:

- **Authority split.** `STATE.md` / `ROADMAP.md` / `docs/open-items.md` stay
  authoritative for *what* the project is doing and *when* — status, phase
  sequencing, deferred-item triggers. Unchanged by this workflow.
  `docs/plans/<slug>/` is authoritative for *how* one non-trivial feature gets
  built, for that feature's lifetime only. A feature's Gate 1 doc should cite
  the relevant ROADMAP phase or open-item rather than re-deriving it; when the
  feature ships, STATE.md's history log gets its usual one-line entry.
- **Gate 4 vs. the subagent sequence above — they compose, not compete.** Gate 4
  slices are the *unit of work* (tracer bullet → real logic → one capability
  per slice). The `database → backend → frontend/ui-design →
  code-reviewer/security-reviewer → devops` order is *how each slice gets
  built* — schema first, then business logic, then UI (frontend/ui-design
  sequential, never parallel, per the rule above), then the two read-only
  reviewers in parallel, then devops only once ship-ready.

## CodeGraph

This repo is indexed by CodeGraph — a `.codegraph/` directory holds a regenerable
SQLite knowledge graph of every symbol, edge, and file (not source, not checked in).
Reach for it BEFORE grep/find or reading files when you need to understand or locate
code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in
  one call — the relevant symbols' verbatim source plus the call paths between them,
  including dynamic-dispatch hops grep can't follow. Name a file or symbol in the
  query to read its current line-numbered source.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints
  the same output.
