# Handlebar

Beverage inventory for a single bar/restaurant in Arizona. Get a handle on your bar.

**Read `docs/spec.md` before any non-trivial work.** It is the source of truth for scope,
data model, and rationale. This file is the short version.

**Read `docs/open-items.md` too.** It lists what is deliberately unfinished and, more
importantly, the trigger that says when each item becomes due. Most are correct to
ignore until then.

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
| Database | MySQL (included with the plan) |
| ORM | Drizzle + drizzle-kit |
| Auth | Better Auth (NOT NextAuth — it is in maintenance mode) |
| UI | Tailwind + shadcn/ui |
| Barcode | Native `BarcodeDetector` + `barcode-detector` WASM polyfill |
| Forms / data | React Hook Form + Zod, TanStack Query, TanStack Table |
| Package manager | `bun install` is fine; run the app on Node |

**Config that must not drift:**
- `output: 'standalone'` in `next.config.ts`
- `images: { unoptimized: true }`
- MySQL connection pool of 5–10 (the plan allows 100 connections, shared with the website)

---

## MVP scope — do not exceed without asking

**In:** catalog, locations, barcode scan, fill level in tenths, quantity input,
count sessions, valuation, reorder list, auth with three roles.

**Out (deferred, do not build):** AI fill estimation, bottle photos, invoice OCR,
Toast PMIX import, variance reporting, compliance packet.

**The MVP contains no AI and no file storage.** If a task seems to need either,
stop and confirm — it is probably scope creep.

---

## Non-negotiable invariants

These are correctness rules, not preferences. Violating them produces numbers that look
plausible and are wrong, which is the worst failure mode this app has.

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
7. **Authorization is checked in every server action and route handler**, not only in
   middleware. Several Next.js CVEs are middleware bypasses; defence in depth makes them
   non-events.
8. **Cost and margin data is gated by role.** Staff never see it.
9. **Draft depletion is grossed up by the waste factor.** A 16 oz pour draws
   `16 / (1 - waste_factor)` ≈ 17.8 oz from the keg. Theoretical usage that ignores this
   makes every keg look ~10% short and turns the variance report into false positives.
   Applies to *theoretical depletion only* — never to counted inventory, which is measured
   as it actually is.

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

`docs/handlebar-catalog.xlsx` is the seed, built from the owner's two prior spreadsheets.
**97 products:** 62 spirits, 16 bottled beers, 9 draft kegs, 5 wines, 2 liqueurs, 3 NA.

Things to know about it:

- **Costs are not filled in yet.** They come from supplier invoices. Nothing that depends
  on valuation can be tested until they are.
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
- **Dim-bar UI.** High contrast, large tap targets, dark mode, one-handed operation.
  The other hand is holding a bottle.
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
