# Database

MySQL + Drizzle. Schema lives in `db/schema.ts`, migrations in `drizzle/`,
pooled client in `db/index.ts`. Full data model rationale: `docs/spec.md` §8.

## Set up a database

1. Create a MySQL database (locally, or from Hostinger hPanel in production —
   database name `truestock` per spec).
2. Copy `.env.example` to `.env.local` and fill in `DATABASE_URL`.
3. Generate/apply migrations and seed:

```bash
bun run db:generate   # diffs db/schema.ts against drizzle/, writes new SQL
bun run db:migrate    # applies pending migrations (needs a live DATABASE_URL)
bun run db:seed       # idempotent catalog seed from docs/catalog/*.csv
```

`db:generate` never touches a live database — it only needs `DATABASE_URL` to
be *set* for the config to load, not reachable. `db:migrate` and `db:seed` do
need a real connection.

## Connection pool — do not change without re-reading spec §11

`db/index.ts` sets `connectionLimit: 10` explicitly (upper bound of the 5–10
range spec §11 calls for). Hostinger's Cloud Startup plan caps MySQL at 100
user connections **shared with the restaurant's other website** on the same
plan — a bigger pool here starves that site, not just this one. If a future
change seems to need a bigger pool, that's a signal to question the query
pattern (e.g. N+1s), not to raise the ceiling.

The pool is cached on `globalThis` so Next.js dev's hot-module-reload doesn't
open a fresh pool (and fresh MySQL connections) on every file save.

## Migrations

- Generated with `drizzle-kit generate`, never hand-edited once applied.
- `0000_majestic_whiplash.sql` is the initial migration — creates all 12 MVP
  tables (the 8 in spec §8, minus `count_line.client_line_id` which moved
  into the new `count_line_write` table — see "Idempotency ledger" below —
  plus Better Auth's `session`, `account`, `verification`; see the comment
  above `user` in `db/schema.ts`). drizzle-kit doesn't emit a companion
  "down" migration, so reversing it means dropping the tables it created, in
  FK-safe order:

  ```sql
  DROP TABLE count_line_write, count_line, count, session, account, product_par, product_barcode, product, location, vendor, verification, user;
  ```

  (count_line_write references count_line/count/user; count_line references
  count/product/location/user; count references user; session and account
  reference user; product_par and product_barcode reference product;
  product references vendor. Dropping in that order — or running MySQL with
  foreign_key_checks briefly disabled — avoids FK errors.) Every future
  migration should state its own reversal the same way if drizzle-kit
  doesn't generate one.
- As of 2026-07-24, nothing has ever been applied to a real database in this
  project (no MySQL server exists in the dev environment yet), so the
  initial migration has been regenerated in place more than once as review
  feedback landed, rather than stacked as 0001/0002/etc. Once a migration
  has actually been applied anywhere, stop doing that — from that point on,
  schema changes are new migrations, never edits to `0000_*.sql`.

## Seeding

`db/seed.ts` reads the three CSVs in `docs/catalog/` (deterministic extracts
of `docs/truestock-catalog.xlsx` — never parse the `.xlsx` directly) and
upserts by natural key (`location.name`, `product.(name, size_ml)` — a
750ml and a 1.75L "handle" of the same brand are different SKUs, so `name`
alone isn't enough; see `product_name_size_ml_unique` in the schema). It is
safe to re-run: rows that already exist have only their descriptive fields
refreshed, never their cost, case size, vendor, or par data — a re-seed must
not silently erase real data entered later through the app.

What it seeds:
- 5 locations with sort order and notes
- 97 products (name, category, subcategory, unit_type, size_ml, active)
- `waste_factor` = 0.100 for the 9 keg products, 0.000 for everything else
- real wholesale cost for the 9 draft kegs, from `draft-economics.csv`

What it deliberately does **not** seed — the source spreadsheet has no data
for these columns yet, so they stay `NULL` rather than being invented:
cost/case_size/vendor/par for non-keg products, all barcodes, all vendors,
all pars. **Valuation and reorder-list math cannot be meaningfully tested
until real costs and par levels exist** — either enter them through the
back office once it's built, or extend the CSVs and re-run the seed.

Users are never seeded here — that's the backend agent's responsibility
(Better Auth owns user creation).

## Auth tables — `user`, `session`, `account`, `verification`

These are Better Auth's tables, defined in `db/schema.ts` alongside
everything else (one schema file, one migration history — no separate auth
schema or drizzle config). Field shapes are taken directly from
`getAuthTables()` in the installed `@better-auth/core@1.6.25`
(`node_modules/@better-auth/core/dist/db/get-tables.mjs`), so the Drizzle
adapter can be pointed at this schema with zero field-name remapping.
`user.role` and `user.active` are Truestock's own additions on top of
Better Auth's core fields. Credential password hashes live on
`account.password` (provider `"credential"`) — there is no `password_hash`
column on `user`.

**Required companion config, not set here — the backend agent must pass it
when constructing the Better Auth instance:**

```ts
advanced: { database: { generateId: "serial" } }
```

Every id in these four tables is a plain `int AUTO_INCREMENT` primary key
(matching spec §8's "everything else uses integer primary keys," and
meaning `count.opened_by`, `count.closed_by`, and `count_line.counted_by`
stay ordinary int FKs into `user.id` with no repointing). Better Auth
defaults to generating its own string ids client-side; `generateId: "serial"`
is what tells it to let MySQL's `AUTO_INCREMENT` generate the id instead,
and the Drizzle adapter then reads it back via `LAST_INSERT_ID()`. Without
this setting, inserts through Better Auth will either fail against these int
columns or fall back to the adapter's unreliable best-effort row matching —
this is not optional.

## Idempotency ledger — `count_line_write`

`count_line.client_line_id` (a single mutable column, overwritten on every
increment) was removed 2026-07-25 after code review found it insufficient:
it could only ever remember the *most recent* write to a line, so a retried
write that wasn't the latest one would fail the equality check and
re-apply — a silent second increment of `partial_fills`. `count_line` is
incremented many times over a count's life (every scan of the same
product+location adds to the existing row, per the composite unique
constraint), so "remember the last write" was never enough.

`count_line_write` replaces it: one permanent row per write, keyed by that
write's `client_line_id`, UNIQUE. A duplicate-key violation on insert into
this table *is* the "already applied" signal — enforced by the database,
not a column that can only hold one value.

**Required write order, inside one transaction** (see the full comment
above `countLineWrite` in `db/schema.ts` for the complete reasoning):
1. Insert-or-increment `count_line` first (`INSERT ... ON DUPLICATE KEY
   UPDATE` against the invariant-1 composite unique key). This resolves
   `count_line.id`, whether the row is brand new or already existed —
   `count_line_write.count_line_id` can't be populated before this runs.
2. Insert the `count_line_write` row second, referencing the `count_line.id`
   from step 1.

If step 2 hits the unique constraint (a replay), the transaction rolls
back — undoing step 1's increment along with it. Net effect of a replayed
write: zero. `count_line_write` is append-only by design: nothing updates
or deletes a row in it, ever.

## `count_line.unit_cost_at_count` / `case_size_at_count` are nullable

Invariant 2 (CLAUDE.md, agent brief) requires these to be *snapshotted at
count time*, not that the snapshot be non-null. As of the current seed, 88 of
97 products have no `current_unit_cost` and all 97 have no `case_size` — a
NOT NULL constraint here would make counting nearly any product impossible
without inventing a sentinel value, and a silent `0.0000` cost is precisely
the plausible-but-wrong failure mode CLAUDE.md warns is this app's worst
failure mode. NULL means "this product had no cost / case size recorded at
the moment it was counted" — a true statement about the count, not a zero.

Anything that reads these columns (valuation, reports — the database does
not and cannot enforce this, it's an application rule):
- **Never coerce NULL to 0.** A line with `unit_cost_at_count IS NULL` is
  excluded from `Count.total_value`, not summed as $0.
- **Surface unpriced lines separately.** Count/valuation screens should show
  a distinct "N lines counted but unpriced" figure alongside the total, so a
  missing price is visible, not silently absorbed into the total.
- **Never retroactively price a closed count.** Once a product's cost is
  entered later, existing count lines that were NULL at count time stay
  NULL. Re-pricing them would re-value a historical count from current
  product data — exactly what invariant 2 exists to prevent.
