# Database

MariaDB + Drizzle. Schema lives in `db/schema.ts`, migrations in `drizzle/`,
pooled client in `db/index.ts`. Full data model rationale: `docs/spec.md` §8.

**MariaDB, not MySQL — established 2026-07-28.** Hostinger's hPanel labels the
feature "MySQL Databases" and this file, the spec and CLAUDE.md all took that
literally until `SELECT VERSION()` against the real host returned
`11.8.8-MariaDB-log`. The driver (`mysql2`), the drizzle dialect (`"mysql"`)
and the `mysql://` URL scheme are all still correct — MariaDB speaks the MySQL
wire protocol — so nothing in the code changed. What changed is that local
development runs `mariadb:11.8` (`docker-compose.yml`), because a gate that
tests a different engine than production isn't a gate.

The one behavioural difference that matters: **MariaDB has no native JSON
type.** `JSON` is an alias for `longtext` with a validity check.
`partial_fills` still reads back as a parsed array because `mysql2` parses it —
verified on 11.8.8 — but that is a driver guarantee, not a schema one, since
drizzle supplies no `mapFromDriverValue` for MySQL JSON. It needs a test, not
a memory.

## Set up a database

The quickest path is `bun run docker:up`, which starts MariaDB 11.8 configured
correctly by construction. Do it by hand only for production:

1. Create a database (Hostinger hPanel → *Databases → MySQL Databases*, or
   locally — database name `truestock` per spec). **It must be `utf8mb4`:**

   ```sql
   CREATE DATABASE truestock CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
   ```

   Nothing in `db/schema.ts` or the migrations declares a charset, so every
   table inherits whatever the database was created with. This is a liquor
   catalog — Cointreau, Château, Jägermeister, Añejo are ordinary entries —
   and on a non-`utf8mb4` database those names mojibake or fail to insert.
   The pool pins `charset: "utf8mb4"` on the client side (`db/index.ts`), but
   that cannot fix a database created as `latin1`. In hPanel, confirm the
   charset dropdown rather than accepting its default. Schema audit
   2026-07-27, finding F3.

   `utf8mb4_0900_ai_ci` is a MySQL collation name and works on MariaDB 11.x,
   which accepts it as an alias for `utf8mb4_uca1400_ai_ci` — verified on
   11.8.8. It is spelled the MySQL way deliberately, so one name covers this
   file, the schema audit and `docker-compose.yml`.
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
range spec §11 calls for). Hostinger's Cloud Startup plan caps the database at
100 user connections **shared with the restaurant's other website** on the same
plan — a bigger pool here starves that site, not just this one. If a future
change seems to need a bigger pool, that's a signal to question the query
pattern (e.g. N+1s), not to raise the ceiling.

The pool is cached on `globalThis` so Next.js dev's hot-module-reload doesn't
open a fresh pool (and fresh database connections) on every file save.

## Migrations

- Generated with `drizzle-kit generate`, never hand-edited once applied.
  One documented exception so far: `0002_wet_abomination.sql` (see below).
- `0000_elite_nightmare.sql` is the initial migration — creates all 13 MVP
  tables (the 8 in spec §8, plus `organization` (the tenant boundary), minus
  `count_line.client_line_id` which moved
  into the new `count_line_write` table — see "Idempotency ledger" below —
  plus Better Auth's `session`, `account`, `verification`; see the comment
  above `user` in `db/schema.ts`). drizzle-kit doesn't emit a companion
  "down" migration, so reversing it means dropping the tables it created, in
  FK-safe order:

  ```sql
  DROP TABLE count_line_write, count_line, count, session, account, product_par, product_barcode, product, location, vendor, verification, user, organization;
  ```

  (count_line_write references count_line/count/user; count_line references
  count/product/location/user; count references user; session and account
  reference user; product_par and product_barcode reference product;
  product references vendor; everything tenant-scoped references
  organization, so it drops last. Dropping in that order — or running with
  foreign_key_checks briefly disabled — avoids FK errors.) Every future
  migration should state its own reversal the same way if drizzle-kit
  doesn't generate one.
- `0001_strong_daimon_hellstrom.sql` and `0002_wet_abomination.sql` close the
  2026-07-27 schema audit's findings (`docs/reviews/schema-scalability-audit.md`).
  0001 adds composite tenant foreign keys so a client-supplied `vendor_id` /
  `product_id` / `location_id` cannot reference another organization's row
  (finding B1). 0002 widens the count/count_line/count_line_write id chain to
  `BIGINT` (F1), re-keys three indexes as organization-first composites (F2),
  and indexes `session.expires_at` (F4).
- **`0002_wet_abomination.sql` is hand-edited, on purpose.** `drizzle-kit
  generate` emitted its `MODIFY COLUMN ... bigint` statements without first
  dropping the foreign keys spanning those columns, which the server rejects
  (`ERROR 3780 ... are incompatible`). The file now does the
  drop / modify / re-add dance in the right order. `db/schema.ts` is still
  the source of truth and `drizzle/meta/0002_snapshot.json` still describes
  the exact end state — only the statement ordering is ours. If you ever hit
  3780 on a future width change, this is the pattern.
- **Migrations are append-only from 2026-07-27.** `0000` landed on `main` in
  PR #1, so it is now a record of what will run against a database that
  matters. `scripts/check-migrations-immutable.sh` enforces this in CI.
  (Before that date, `0000` was regenerated in place several times as review
  feedback landed — that era is over.)
- Nothing has yet been applied to a *production* database. The full chain
  `0000 → 0001 → 0002` was verified end-to-end in Docker — first against
  MySQL 8.0 on 2026-07-27, then re-verified against **MariaDB 11.8.8** on
  2026-07-28 once the production engine was established. Both runs included
  probe queries proving the composite tenant FKs reject cross-tenant ids
  (1452), the `product_par` generated column rejects a second overall par
  (1062), `DECIMAL(10,4)` round-trips exactly, and accented product names
  survive. The schema is portable across both engines; no migration needed
  changing.
- `0004_numerous_diamondback.sql` (Phase 2.5, Slice 1) creates `invoice` and
  `extraction_job`. `0005_bitter_captain_marvel.sql` (Phase 2.5, Slice 2)
  creates `invoice_line`, adds `invoice.rejection_reason`, and adds eight
  provenance/cost-tracking columns to `extraction_job` (`provider`,
  `model_id`, `prompt_version`, `raw_response`, `input_tokens`,
  `output_tokens`, `cost_usd`, `error_code`) — see that table's comment in
  `db/schema.ts` for why they're added to the existing job table rather than
  a second one. Purely additive; drizzle-kit again emits no down migration,
  so reversal is:

  ```sql
  ALTER TABLE invoice DROP COLUMN rejection_reason;
  ALTER TABLE extraction_job
    DROP COLUMN error_code, DROP COLUMN cost_usd, DROP COLUMN output_tokens,
    DROP COLUMN input_tokens, DROP COLUMN raw_response,
    DROP COLUMN prompt_version, DROP COLUMN model_id, DROP COLUMN provider;
  DROP TABLE invoice_line;
  ```

  Verified end-to-end against MariaDB 11.8 in a throwaway database: applying
  `0005` then running the reversal above leaves `extraction_job` and
  `invoice` byte-identical (via `SHOW CREATE TABLE`) to their state right
  after `0004`, and `invoice_line` gone.
- `0006_colorful_pretty_boy.sql` (Phase 2.5, Slice 3) creates `vendor_alias`
  and adds `invoice_line.matched_vendor_alias_id`. `vendor_alias` carries a
  composite tenant foreign key on `(organization_id, vendor_id)` — the
  specific gap the 2026-08-14 adversarial review's second pass named: "the
  `vendor_alias` had no tenant foreign key at all... it is the one table
  whose bad rows persist and re-apply to every future invoice from that
  vendor." Verified against MariaDB 11.8.8 in the dev database: a
  cross-tenant `vendor_id` insert is rejected (1452,
  `vendor_alias_organization_vendor_fk`), a same-tenant insert succeeds, and
  a duplicate `(organization_id, vendor_id, vendor_item_code)` is rejected
  (1062, `vendor_alias_organization_vendor_item_code_unique`) — the exact
  upsert key `lib/domain/matching.ts:upsertAlias` (not yet built) will rely
  on. `invoice_line.matched_vendor_alias_id` is a bare FK (`ON DELETE SET
  NULL`), not composite — see that column's comment in `db/schema.ts` for
  why: it's set by an internal domain function that already has a
  tenant-scoped `vendorId`, never taken from a raw client payload the way
  `matched_product_id` is. Purely additive; reversal is:

  ```sql
  ALTER TABLE invoice_line DROP FOREIGN KEY invoice_line_matched_vendor_alias_id_vendor_alias_id_fk;
  ALTER TABLE invoice_line DROP INDEX invoice_line_organization_matched_vendor_alias_idx;
  ALTER TABLE invoice_line DROP COLUMN matched_vendor_alias_id;
  DROP TABLE vendor_alias;
  ```

  The `DROP INDEX` line is required, not optional cleanup: MariaDB does not
  drop a composite index when only one of its columns is dropped, it just
  narrows the index to whichever columns remain — so
  `DROP COLUMN matched_vendor_alias_id` alone silently leaves a stray
  single-column `(organization_id)` index behind instead of removing
  `invoice_line_organization_matched_vendor_alias_idx` entirely. Verified
  end-to-end against MariaDB 11.8.8 in a throwaway database: applying `0006`
  then the corrected reversal above leaves `invoice_line` byte-identical
  (via `SHOW CREATE TABLE`) to its state right after `0005`, and
  `vendor_alias` gone — the first attempt, without the `DROP INDEX` line,
  was caught by exactly that diff.

  Also verified: the full chain `0000` → `0006` applies clean from empty
  (`tests/helpers/test-db.ts:migrateTestDatabase()` against a fresh
  `truestock_test` database on MariaDB 11.8.8).
- `0007_yielding_gideon.sql` (Phase 2.5, Slice 4) creates `product_cost_history`
  and adds `invoice_line_organization_id_id_unique` — `invoice_line` had no
  `(organization_id, id)` composite unique index until now because nothing
  needed to reference an `invoice_line` row by id from another table; this
  slice's `source_invoice_line_id` composite tenant FK is the first thing
  that does. `product_cost_history` carries THREE composite tenant foreign
  keys — `(organization_id, product_id)` → `product`,
  `(organization_id, source_invoice_id)` → `invoice`, and
  `(organization_id, source_invoice_line_id)` → `invoice_line` — plus a
  plain (not tenant-scoped) `UNIQUE(source_invoice_line_id)`, the idempotency
  backstop named in `docs/plans/phase-2.5-invoice-automation/04-slices.md`
  Slice 4 [AR-4]: the primary idempotency mechanism is the CAS on
  `invoice.status` in `approveInvoiceAction`, which skips the cost-writing
  loop entirely on a replay, so this constraint only ever fires if that CAS
  logic has a bug. Verified against MariaDB 11.8.8 in a throwaway database:
  a cross-tenant `product_id` insert is rejected (1452,
  `product_cost_history_organization_product_fk`), a same-tenant insert
  succeeds, and a duplicate `source_invoice_line_id` is rejected (1062,
  `product_cost_history_source_invoice_line_id_unique`). Purely additive;
  reversal is:

  ```sql
  DROP TABLE product_cost_history;
  ALTER TABLE invoice_line DROP INDEX invoice_line_organization_id_id_unique;
  ```

  Order matters: `product_cost_history`'s FK on `source_invoice_line_id`
  references that index, so it must be dropped first — MariaDB refuses to
  drop an index a live foreign key still depends on (1553). No `DROP COLUMN`
  is involved this time (the addition to `invoice_line` is an index only,
  not a column), so the `mariadb-composite-index-survives-column-drop`
  gotcha from `0006`'s entry above does not apply here, but the same
  "verify with `SHOW CREATE TABLE`, don't assume" discipline does: verified
  end-to-end against MariaDB 11.8.8 in a throwaway database — applying
  `0007` then the reversal above leaves `invoice_line` byte-identical (via
  `SHOW CREATE TABLE`, modulo `AUTO_INCREMENT`/collation, which differ only
  because the comparison database was created separately) to its state
  right after `0006`, and `product_cost_history` gone.

  Also verified: the full chain `0000` → `0007` applies clean from empty in
  a throwaway database (`bun run db:migrate` against a fresh scratch
  database on MariaDB 11.8.8) — the same proof `schema_matches_live_columns`
  (Slice 4's own adversarial test, backend stage) makes independently
  against `truestock_test` via `migrateTestDatabase()`.
- `0008_lyrical_romulus.sql` (open-items.md #2, schema half) adds three
  columns to `count_line_write`: `write_type` (new `countLineWriteTypeEnum`
  in `db/enums.ts` — `'scan' | 'fill_correction'`, NOT NULL DEFAULT `'scan'`)
  and `partial_fills_before` / `partial_fills_after` (nullable JSON —
  `longtext` on MariaDB, same as every other JSON column in this file).
  `editCountLineFills` (`lib/domain/counts.ts`) replaces the whole
  `partial_fills` array rather than appending to it, so it has no
  representation in `partial_fills_delta`'s additive shape (that column is
  modelled so summing every row's delta reconstructs a line's current state
  — see the comment above `countLineWrite` in `db/schema.ts`); the two new
  columns instead carry the full before/after state transition on the
  correction row itself, so "who changed this fill level, and when" is
  answerable from one ledger row without replaying prior writes. The
  domain-function change that actually writes these rows — inserting into
  `count_line_write` inside `editCountLineFills`'s existing transaction — is
  backend work and is NOT part of this migration; this slice is schema only.
  The `DEFAULT 'scan'` needs no separate data migration: every row that
  existed before this column was added genuinely was a scan/increment/
  quantity-correction write, since `editCountLineFills` wrote no ledger row
  at all until this change. Purely additive; reversal is:

  ```sql
  ALTER TABLE count_line_write DROP COLUMN write_type;
  ALTER TABLE count_line_write DROP COLUMN partial_fills_before;
  ALTER TABLE count_line_write DROP COLUMN partial_fills_after;
  ```

  No `DROP INDEX` needed — unlike `0006`'s `matched_vendor_alias_id`, none
  of these three columns participate in any index on this table, so the
  `mariadb-composite-index-survives-column-drop` gotcha does not apply here.
  Verified against MariaDB 11.8.8 in an isolated throwaway database
  (`docker-compose.worktree-test.yml`, project `truestock-openitem2-test`,
  db published on host port 3309): the full chain `0000` → `0008` applies
  clean from empty, `DESCRIBE count_line_write` shows all three new columns
  with the expected type/null/default, and applying the reversal above then
  re-adding the same three `ALTER TABLE ... ADD` statements leaves
  `count_line_write` byte-identical (via `SHOW CREATE TABLE`) both to its
  state right after `0007` (reversal) and to its freshly-migrated `0008`
  state (re-add).

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
is what tells it to let the database's `AUTO_INCREMENT` generate the id instead,
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
