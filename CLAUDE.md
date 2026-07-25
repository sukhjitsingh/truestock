# Handlebar

Beverage inventory for a single bar/restaurant in Arizona. Get a handle on your bar.

**Read `docs/spec.md` before any non-trivial work.** It is the source of truth for scope,
data model, and rationale. This file is the short version.

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

---

## Working agreements

- **The catalog is the foundation.** Scan-to-enroll: an unknown barcode opens a fast
  new-product form. That form must stay under 20 seconds to complete. If it gets slow,
  the catalog decays and the whole system dies. This is the highest-risk interaction.
- **Always offer a search picker beside the scan button** — damaged labels, house
  infusions, and some wine have no usable barcode.
- **Count-line writes are optimistic.** UI updates immediately, saves in the background,
  pending writes queue in IndexedDB. The server stays authoritative.
- **Dim-bar UI.** High contrast, large tap targets, dark mode, one-handed operation.
  The other hand is holding a bottle.
- Migrations go through drizzle-kit. No hand-edited schema drift.
- Conventional commits. Small, reviewable changes.

---

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
