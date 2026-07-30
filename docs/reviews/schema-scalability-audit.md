# Truestock schema — scalability & design audit

Scope: `db/schema.ts`, `drizzle/0000_elite_nightmare.sql`, `db/index.ts`, `db/seed.ts`,
`lib/domain/*`, `lib/authz.ts`, `lib/validation/*`, against `docs/spec.md` §8/§10/§11 and
CLAUDE.md's ten invariants. Never applied to a real database; zero tests. This is a design
review of a schema that is still free to change, not a bug report against a running system.

> **Engine correction, 2026-07-28 — read before the rest.** This audit says "MySQL"
> throughout, and its verification runs were done against MySQL 8.0 and 8.4 in Docker.
> Production is **MariaDB 11.8.8** — Hostinger's hPanel labels the feature "MySQL
> Databases", which is where the assumption came from, and `SELECT VERSION()` against
> the real host settled it.
>
> **No finding in this document changes.** The whole chain plus every probe was re-run
> against `mariadb:11.8` before the local pin was switched: 14 tables, cross-tenant
> foreign keys still reject with 1452, the `product_par` generated column still rejects
> a second overall par with 1062, `DECIMAL(10,4)` round-trips exactly, and `partial_fills`
> still returns a parsed array. The schema is portable; the fixes stand as written.
>
> Two claims made *elsewhere* in this repo on the strength of this audit were wrong and
> have been corrected: that `utf8mb4_0900_ai_ci` is MySQL-only (MariaDB 11.x aliases it
> to `utf8mb4_uca1400_ai_ci`), and that `docker/mariadb/init/00-charset.sql` therefore
> acted as an engine tripwire (it never did).
>
> One genuine engine difference is worth carrying forward: **MariaDB has no native JSON
> type** — `JSON` is an alias for `longtext`. `partial_fills` survives because `mysql2`
> parses it, not because the column type guarantees anything, and drizzle supplies no
> `mapFromDriverValue` here. That makes it a driver guarantee that a test must hold, not
> a schema property.

---

## 0. Resolution status — updated 2026-07-27, after the audit

| Finding | Status | Where |
|---|---|---|
| **B1** cross-tenant `vendor_id` | **FIXED** | `lib/domain/catalog.ts` (`assertVendorOwned`) + composite tenant FKs in `drizzle/0001_strong_daimon_hellstrom.sql` |
| **B2** count-line gap-lock deadlock | **FIXED** | `withLockRetry` in `lib/domain/db-errors.ts`, wrapping the three count-line write transactions |
| **F1** `int` PKs on the write chain | **FIXED** | `BIGINT` on the count chain, `drizzle/0002_wet_abomination.sql` |
| **F2** single-column, non-tenant indexes | **FIXED** | re-keyed organization-first, 0002 |
| **F3** no charset pinned | **FIXED** | `charset: "utf8mb4"` in `db/index.ts`; `CREATE DATABASE` requirement documented in `db/README.md` |
| **F4** no session expiry index | **FIXED** (index) / **deferred** (sweep job) | index in 0002; job tracked as open-items 1b |
| **F5** no pool acquire timeout | **FIXED, differently than recommended** | mysql2 has no `acquireTimeout`; implemented as a bounded `queueLimit` — see the note below |

**Verified against MySQL 8.0, not just typechecked.** The chain `0000 → 0001 → 0002` was
applied to a throwaway container and probed: cross-tenant `vendor_id`, `product_id` and
`location_id` all rejected with FK 1452; NULL foreign ids correctly skip the check; the
generated `location_scope` blocks a second overall par (1062); two tenants can enrol the same
UPC; accented names round-trip. **B2 was reproduced before it was fixed** — two sessions
inserting different products into one count deadlocked with 1213 — and the retry then
recovered the victim on attempt 2 with both lines persisted.

**Two corrections to this audit's own premises**, worth recording because they changed the fix:

1. The audit assumes schema changes are free because `drizzle/` is regenerated in place. It
   isn't — `0000_elite_nightmare.sql` had already landed on `origin/main` via PR #1, so
   migrations were append-only. The fixes ship as new `0001`/`0002`, not a regeneration.
2. F5 asked for an acquire *timeout*. mysql2 does not expose one (checked against the
   installed typings — only `waitForConnections`, `connectionLimit`, `maxIdle`, `idleTimeout`,
   `queueLimit`). A bounded queue gets the same property — fast, named failure at a known
   load level instead of an unbounded queue — and is what shipped.

Also of note: `drizzle-kit generate` produced an **unrunnable** migration for F1, emitting
`MODIFY COLUMN ... bigint` without dropping the foreign keys spanning those columns
(`ERROR 3780`). `0002` is hand-edited to do the drop/modify/re-add in order; see
`db/README.md`.

---

## 1. Verdict

**Yes, with two live gaps that should close before this is sold to a second tenant, and one
locking pattern that will misbehave under completely ordinary multi-staff concurrency —
neither expensive to fix today.** The tenancy model is the strongest part of this schema:
composite tenant foreign keys, `Actor.organizationId` re-read from the database on every
call, and a documented, largely-followed discipline of "existence isn't ownership" are all
real, non-obvious engineering, not cargo-culted multi-tenancy. The append-only idempotency
ledger is a genuinely good design that correctly fixes a real bug class (the single-column
`client_line_id` it replaced). Where the schema falls short is consistency: the ownership
discipline invariant 9 demands was applied rigorously to `count_line` (the highest-invariant
table) and then not carried to `product.vendor_id`, which is a live, exploitable-today
cross-tenant gap, not a hypothetical one. Separately, the write path's actual locking
behavior (`SELECT ... FOR UPDATE` + conditional insert under default REPEATABLE READ)
diverges from what the schema's own comments describe (`INSERT ... ON DUPLICATE KEY
UPDATE`) and will deadlock under the ordinary case of two staff scanning different new
products into the same count at once — not a high-scale problem, a day-one one. Everything
this audit was asked to stress-test about *volume* (row counts, `int` ceilings, JSON
aggregation, connection pooling) checks out: at the row counts spec §11 itself models, none
of it binds for years, and most of the "looks worrying" indexing questions resolve to "fine,
because a single tenant's catalog and count history both stay small" rather than "fine
because it was engineered for scale." That distinction matters for the recommendations below
— several of them are about making indexes *correctly tenant-scoped* now, while the fix is a
type change in an unapplied migration, rather than waiting until a tenant list makes the
current definitions actively wrong.

---

## 2. Findings

### Blocker

**B1 — `product.vendor_id` is not ownership-checked; it is exploitable today, not just at scale.**
`lib/domain/catalog.ts:390` (`createProduct`) and `lib/domain/catalog.ts:461-472`
(`updateProduct`, via `const { productId, currentUnitCost, wasteFactor, ...rest } = input`
then `patch = { ...rest }`) write a client-supplied `vendorId` straight onto `product` with
**no check that the vendor belongs to `actor.organizationId`.** `lib/validation/catalog.ts:66,86`
only checks that it's a positive integer. The FK (`product_vendor_id_vendor_id_fk`,
`db/schema.ts:351-353`) only proves the vendor row *exists*, not whose it is — exactly the
distinction invariant 9 exists to enforce, and exactly the bug class CLAUDE.md names as a
real prior finding on `count_line.location_id` (fixed in `lib/domain/counts.ts:340-361`,
2026-07-27). That fix was never generalized. Concretely: any authenticated owner/manager in
Tenant A can set their own product's `vendor_id` to Tenant B's vendor row — ids are sequential
autoincrement ints, trivially guessable — and it succeeds silently. Nothing in the current
read paths renders another tenant's vendor by an unscoped lookup (`reorderList` in
`lib/domain/reports.ts:367-371` builds `vendorById` only from the caller's own
organization-scoped vendor list, so a foreign `vendor_id` today just resolves to
`vendorName: null`), so there is no live data leak *yet* — but the row now permanently
references a foreign tenant's vendor, and the next feature that fetches a vendor by id
directly (a "vendor detail" screen, an invoice-vendor join) will leak that vendor's contact
info and lead time across tenants exactly as the location bug did. This doesn't require
concurrency or scale — one request, one guessed id.

The same structural gap exists, currently dormant, on `product_barcode.product_id`
(`db/schema.ts:405-407`, plain FK) and `product_par.product_id` / `product_par.location_id`
(`db/schema.ts:449-454`, plain FKs) — none of these has the composite tenant FK that
`count_line`/`count_line_write` got. They are safe *today* only because nothing in the
codebase currently writes them with a caller-supplied id from outside a same-transaction
creation flow (`product_barcode` is always created with `productId: inserted.id` from the
row just inserted in the same transaction, `lib/domain/catalog.ts:406-413`; nothing in this
codebase writes `product_par` at all yet — no create/update function exists for it). That
safety is incidental, not designed, and will stop holding the moment a par-management screen
or an "attach another barcode to an existing product" feature ships (both are named as
future work in `docs/open-items.md`).

**Fix, cheap now:** extend the composite-FK pattern already proven on `count_line` to these
three relationships — add a `vendor_organization_id_id_unique` index on `vendor` (mirroring
`count_organization_id_id_unique`), then a composite FK on `product(organization_id,
vendor_id)` → `vendor(organization_id, id)`; likewise `product_par(organization_id,
product_id)` → `product(organization_id, id)` and, if a location-scoped par ever writes, a
composite FK on `location_id` too; and `product_barcode(organization_id, product_id)` →
`product(organization_id, id)`. This is a schema-level close, not an app-code patch — it
makes the guarantee structural rather than depending on every future write path
remembering to re-derive the check that `upsertCountLineRow` had to have added in review.
The app-layer fix for the already-live `vendor_id` gap (an explicit ownership check in
`createProduct`/`updateProduct`, matching the pattern at `counts.ts:326-338`) is outside this
audit's write scope (application code) but should happen regardless of whether the schema fix
lands, since the schema fix alone won't produce a friendly error — it'll surface as a raw FK
violation.

**B2 — The count-line upsert will deadlock under ordinary (not high) concurrency, and the schema's own documented mitigation isn't what's implemented.**
`db/schema.ts:667-689` documents `INSERT ... ON DUPLICATE KEY UPDATE` against the invariant-1
unique key as "the natural fit" for the count-line upsert. `lib/domain/counts.ts:285-430`
(`upsertCountLineRow`) instead does an app-level `SELECT ... FOR UPDATE` on
`(count_id, product_id, location_id)` (`counts.ts:289-299`), then conditionally `INSERT`s or
`UPDATE`s, with a separate catch for `ER_DUP_ENTRY` on the insert to recover from a genuine
concurrent-insert race (`counts.ts:387-429`). That duplicate-key race is handled correctly.
What isn't handled: under MySQL's default REPEATABLE READ isolation (nothing in
`db/index.ts` or anywhere else overrides it), a `SELECT ... FOR UPDATE` that finds no matching
row takes a **gap lock** on the unique index to prevent a phantom insert. Two concurrent
transactions each inserting a *different* new `(product_id, location_id)` pair into the
*same* `count_id` — i.e., two staff members scanning two different first-time bottles into
the same open count at the same moment, which is not an edge case, it is the exact scenario
spec §11 and CLAUDE.md's "dim-bar UI" section describe as normal — can take overlapping gap
locks and deadlock (MySQL error 1213, `ER_LOCK_DEADLOCK`). `lib/domain/db-errors.ts:9-16`
(`isDuplicateKeyError`) only recognizes code 1062; a 1213 (or a 1205 lock-wait-timeout)
propagates as a raw, unretried error out of `applyIncrement`/`setCountLineQuantities`.
Because the whole transaction rolls back on any error, this cannot corrupt data — the
idempotency design stays safe even when this fires — but it **will** surface as a failed
save on an ordinary two-person count, requiring a manual rescan, with no server-side retry
and no guarantee the client treats a transaction failure (as opposed to a dropped
connection) as retryable. This is a day-one concurrency finding, not a growth one: it needs
two people counting at once, nothing more.

**Fix, cheap now (application-layer, flagged here because the schema's own comment
prescribes the fix and the implementation diverged from it):** either move to the
`INSERT ... ON DUPLICATE KEY UPDATE` pattern the schema already documents (a single atomic
statement has a materially smaller deadlock surface than a two-statement
select-then-branch), or, at minimum, wrap the transaction in a standard deadlock-retry loop
(catch 1213/1205, retry the whole transaction with backoff) the same way 1062 is already
special-cased. Neither is a schema change, but both are directly downstream of a locking
behavior this audit was asked to reason about, and the schema's comment already names the
right answer.

### Fix now while it's free

**F1 — `int` primary keys on the append-only write chain have real, if distant, headroom limits; converting now costs nothing, converting later costs an ALTER on a huge live table.**
Modeling spec §11's own numbers (~10,000 `count_line` rows/year for one bar) against a
plausible multi-tenant future: `count_line_write` runs at roughly 2-3× that (every scan is a
write; a line is scanned/corrected more than once), so figure ~20-30k rows/tenant/year. At
500 tenants over 5 years that's ~50-75M rows — nowhere near the `int` ceiling
(2,147,483,647). At 5,000-10,000 tenants (a genuinely large SaaS outcome) sustained over a
decade, the ledger crosses into the billions and the 32-bit ceiling becomes real. The
asymmetry is what matters: today, widening `count.id`, `count_line.id`,
`count_line.count_id`, `count_line_write.id`, `count_line_write.count_line_id`, and
`count_line_write.count_id` to `bigint` is a one-line type change per column in an unapplied
migration. Once this ledger holds hundreds of millions of rows, the same change is an
online-DDL table rebuild on a table you cannot take offline (it's the audit trail spec §10
requires). `organization`, `user`, `vendor`, `location`, `product`, `product_barcode`,
`product_par` don't need this — they scale with tenant/catalog count, not scan volume, and
never realistically approach the ceiling (10,000 tenants × 100 products = 1M rows). Scope the
fix to the count/count_line/count_line_write chain only.

**F2 — `product_active_idx`, `product_category_idx`, `count_status_idx` are single-column and not tenant-scoped; MySQL is unlikely to ever pick them for the queries that exist, and the fix is free.**
Checked against the real call sites: `searchProducts` (`lib/domain/catalog.ts:204-229`) always
filters `organization_id` together with `active`/`category`; `getActiveCount`
(`counts.ts:1182-1201`) always filters `organization_id` together with `status`. For all
three, the optimizer's best plan is the leftmost-prefix equality on `organization_id` from an
existing composite index (`product_organization_name_size_ml_unique`,
`count_organization_id_id_unique`), then an in-memory filter on the second predicate — which
works today *only* because a tenant's catalog stays in the hundreds of rows and its count
history in the low thousands (spec's own scale numbers). The three bare single-column
indexes, as defined, are not what gets chosen for a tenant-scoped read (a boolean or a
handful of category values has terrible standalone selectivity across *all* tenants combined)
and are close to dead weight — index-maintenance cost on every write, without ever being the
access path for the query they were presumably added for. Contrast with
`vendor_organization_id_idx` (`schema.ts:292`) and `product_barcode_organization_barcode_unique`
(`schema.ts:431-434`), which get this exactly right — organization-first, so the same index
serves both the tenant filter and the actual lookup. **Fix:** re-key as
`(organization_id, active)`, `(organization_id, category)`, `(organization_id, status)`. Free
today (unapplied migration); a normal secondary-index change (not a rebuild) even after data
exists, but no reason to defer it.

**F3 — No charset/collation is pinned anywhere; correctness currently depends on an unverified hPanel default.**
Neither `db/schema.ts`, `drizzle.config.ts`, nor the generated
`drizzle/0000_elite_nightmare.sql` declares an explicit `CHARACTER SET`/`COLLATE` at database,
table, or column level (confirmed by reading the full migration — every `CREATE TABLE`
statement is bare). Every table therefore inherits whatever charset the target MySQL database
had at `CREATE DATABASE` time in Hostinger's hPanel — a step this repo documents
(`db/README.md:6-9`) but does not pin. If that database is anything other than `utf8mb4`
(older hPanel defaults, or an operator who leaves the dropdown on its default), product/vendor
names with real characters this catalog will contain — Cointreau, Château, Jägermeister,
Añejo — silently mojibake or get rejected on insert. This is not a hypothetical: it's a
liquor catalog, these names are not edge cases. Collation itself is fine wherever it lands:
MySQL 8's default (`utf8mb4_0900_ai_ci`) or MariaDB's (`utf8mb4_general_ci`/`unicode_ci`) are
both case-insensitive, and case-insensitive is the *correct* behavior for all three unique
indexes that matter — `user.email` (case-insensitive sign-in is what you want),
`organization.slug` (prevents case-variant URL collisions), and `product_barcode.barcode`
(moot; barcodes are digit strings). The gap is charset, not collation. **Fix:** add
`?charset=utf8mb4` to the connection string / pass `charset: "utf8mb4"` to `mysql2`'s pool
config in `db/index.ts`, and state the `CREATE DATABASE ... CHARACTER SET utf8mb4` requirement
explicitly in `db/README.md`'s setup steps rather than leaving it to hPanel's default. Free
today; a real, quiet data-corruption bug later if the assumption is ever wrong and goes
unnoticed until a bottle named with an accent gets counted.

**F4 — `session` has no expiry-sweep index and no cleanup job.**
`session.expires_at` (`schema.ts:213-234`) is unindexed. Not a query-performance problem
today (nothing scans by expiry), but it means there is no cheap way to sweep expired sessions
later without a full table scan, and nothing sweeps them at all currently — the table grows
by one row per login, forever, across every tenant, with no floor on it. Add the index now
(free on an empty table) and note a periodic delete-expired-sessions job as an ops TODO before
this matters operationally (it doesn't yet, at 3-5 users per tenant).

**F5 — Pool exhaustion has no timeout, so overload degrades as creeping latency rather than a fast, legible error.**
`db/index.ts:46-63` sets `waitForConnections: true, queueLimit: 0` — an *unbounded* queue, no
acquire timeout. Under sustained load past the 10-connection ceiling, requests queue
indefinitely rather than failing fast. At today's traffic this never engages. Cheap to add a
sane timeout now (fail with a clear 503-equivalent past N seconds) so a future overload is
visible and debuggable instead of manifesting as vaguely slow server actions across every
tenant sharing the pool.

### Accept and document

**A1 — The two composite tenant FKs (`count_line_organization_count_fk`,
`count_line_write_organization_line_fk`) and their supporting unique indexes
(`count_organization_id_id_unique`, `count_line_organization_id_id_unique`) are worth their
cost, and the cost is genuinely small.** Each extra unique index costs one B-tree insert per
row created (`count`, `count_line`) — at the F1 volume model (tens of millions of rows over
the schema's life), that's on the order of a few hundred MB of extra index storage against a
100 GB allocation, and microseconds of extra work per insert against a transaction that's
already doing FK checks and a real row write. In exchange it makes cross-tenant drift on the
single highest-invariant-density table in the schema **structurally impossible** rather than
a matter of every future query remembering to join correctly — which is precisely the
property that failed for `product.vendor_id` (B1). This is the schema's best idea, and the
fact that it wasn't extended everywhere it should have been is the schema's clearest gap —
those two findings should be read together.

**A2 — TIMESTAMP for audit columns / `count.started_at`/`closed_at`, DATETIME for
`session.expires_at`/OAuth token expiries, DATE-as-string for `count_line.opened_at` — all
three hold up.** TIMESTAMP's UTC-normalize-on-write, convert-on-read behavior is exactly
correct for "this moment, whatever the server's timezone is" fields, which matters concretely
here since the deployment target (Arizona, per spec §10) is non-UTC. DATETIME's lack of
timezone conversion is exactly correct for an app-computed future instant that must not drift
if the server's timezone setting ever changes. The one thing worth writing down rather than
re-litigating: TIMESTAMP's year-2038 ceiling is real (4-byte Unix time), and every
`auditColumns` pair plus `count.started_at`/`closed_at` uses it. Twelve years out, and the
timezone-correctness benefit is needed *now* — not worth trading away today, but worth a
standing note so nobody has to rediscover the ceiling under pressure.

**A3 — `ON DELETE RESTRICT` on every organization-referencing FK makes a tenant
undeletable by construction, and that's correct for now, but there's no offboarding path
documented anywhere.** This matches invariant 6 (never hard-delete) and spec §10's retention
requirement, and building deletion/export tooling speculatively before a single customer has
churned would be waste. But "an organization cannot be deleted" and "we have a documented
process for what happens when a customer cancels" are different facts, and only the first one
exists right now. Write down the intended lifecycle (deactivate via `organization.active =
false`, indefinite retention by default, a manual/legal-request-only path for an actual
delete) before the first cancellation, not before the first migration.

**A4 — Noisy-neighbor risk on the shared `count_line_write` ledger and the shared Hostinger
buffer pool is real in principle and correctly not engineered around yet.** One disproportionately
large tenant (a multi-location chain, say) could generate enough write volume to meaningfully
compress the working set available to every other tenant in a 3 GB RAM instance shared with an
unrelated website. At the row volumes modeled in F1, this doesn't bind for a long time — spec
§11's own framing ("~10,000 rows/year... four orders of magnitude below where architecture
decisions start to matter") is still basically true per-tenant. Document the trigger (a
tenant whose write volume is an order of magnitude above the median) rather than
pre-building partitioning or a per-tenant resource governor now.

**A5 — `partial_fills` as an unconstrained JSON array, validated only at the Zod boundary,
is correctly enforced end to end.** Verified: `lib/validation/counts.ts:42-52`
(`fillFractionSchema`, `[0,1]` bounds) and `MAX_QTY_PER_WRITE` gate every write path that
touches `partial_fills` or the sealed quantity columns — `incrementCountLineSchema`,
`scanCountLineSchema`, `editCountLineFillsSchema`, `setCountLineQuantitiesSchema` all route
through it, and there is no code path in `lib/domain/counts.ts` that writes these columns
without having gone through the corresponding Zod schema first. The DB genuinely cannot
enforce "each array entry in [0,1]" (no CHECK-on-JSON-contents in MySQL), and the
alternative — a child table, one row per fill reading — would work against the exact use
case the comment defends (correcting one bottle's reading without touching the rest of the
line). Correct trade, correctly implemented.

**A6 — ENUM usage is scoped to genuinely small, closed, business-meaning sets, and the
schema already shows it knows the tradeoff.** `role`, `count.status`, `count.type`,
`unit_type`, `pack_level`, `count_mode` are all small and unlikely to need frequent growth;
`product.category`/`subcategory` are deliberately `varchar`, not `ENUM` — the schema comment
at `schema.ts:338-343` explicitly reasons about exactly this tradeoff and gets it right. Worth
noting for when a value *is* added: in MySQL 8.0.12+ (and modern MariaDB), appending a new
value at the *end* of an ENUM's list is an instant, metadata-only ALTER — the "ENUM growth
means a table rewrite" worry is smaller than commonly assumed, as long as new values are
appended rather than inserted mid-list or reordered.

**A7 — The connection pool (10, shared with an unrelated website) was reasoned about for one
tenant, and that reasoning hasn't been revisited for the multi-tenant resale ambition — but
the actual workload shape means the pool likely isn't the first thing to break.** Spec §11's
pool sizing was explicitly justified against a single bar's own traffic. CLAUDE.md's
multi-tenant pivot doesn't revisit it. Back-of-envelope: each count-line write is a short,
indexed, few-statement transaction (tens of milliseconds at most), and the input is
human-paced (spec: one bottle every 3-6 seconds per counter) — even a few hundred
concurrently-active counters across many tenants at once would generate on the order of tens
of writes/second, comfortably inside what 10 connections can serve. The pool ceiling is
unlikely to be the binding constraint before the single shared Node process / Hostinger Cloud
Startup plan itself is — which is a platform decision, not a schema one, but worth flagging
since CLAUDE.md assigns pool sizing to this agent's guardianship. Revisit when concurrent
active count sessions across all tenants combined regularly approaches the pool size, not
before.

### Non-issue

**N1 — `requireSession`'s per-call `user` ⋈ `organization` join (`lib/authz.ts:83-121`).**
Both sides resolve by primary key; the join cost is negligible, and re-reading role/org fresh
on every call (rather than trusting a cached session claim) is exactly what invariant 9
requires — a role change must take effect on the next request, not the next sign-in. This is
correct, not an avoidable cost.

**N2 — `int` PKs on `organization`/`user`/`vendor`/`location`/`product`/`product_barcode`/
`product_par`.** These scale with tenant and catalog size, not scan volume; even 10,000
tenants at 100 SKUs each is 1M rows, nowhere near the ceiling. Contrast with F1, which is
about the write-volume tables specifically.

**N3 — JSON aggregation cost in valuation (`lib/domain/valuation.ts`,
`computeCountTotals` in `lib/domain/counts.ts:867-882`).** Always scoped to one count
(bounded at ~100-1000 lines per spec's own numbers), read once and summed in Node — there is
no SQL-side `SUM()` over the JSON array anywhere, and none is needed at this per-count size.
Not a scaling concern at any realistic multi-tenant volume, since it never aggregates across
tenants or across a tenant's full history in one query.

**N4 — The barcode-scan hot path is exactly as advertised.**
`resolveBarcodeForCount` (`lib/domain/catalog.ts:325-340`) is a single lookup on
`product_barcode_organization_barcode_unique` (organization-first, matching every tenant-scoped
read) with **no join to `product` at all** on this path — the join to fetch the cost/case-size
snapshot happens once, inside `upsertCountLineRow`, keyed by `product.id`'s primary key. This
is the single most latency-sensitive read in the app and it's built correctly.

**N5 — No missing index for reorder-list grouping or valuation aggregation.**
Both `reorderList` (`lib/domain/reports.ts:319-410`) and count valuation compute their
grouping/summing in application code over an already-small, already-indexed result set (a
tenant's par rows, a tenant's count lines for one count) — there is no SQL `GROUP BY` these
would benefit from adding, and no missing index behind either read given the row counts
involved. Checked explicitly against the audit's prompt on this point; it resolves to fine.

**N6 — The deferred-tables claim holds.** Designed `Invoice`/`InvoiceLine`/`Depletion`/
`RecipeComponent` (spec §8's sketch) against the current schema: all four attach cleanly via
plain-int FKs to `vendor.id`/`product.id`/`count.id`, no existing column or constraint
obstructs them. The one thing a future `Invoice` table would want — the same composite tenant
FK protection `count_line` has against `vendor` — requires adding a
`vendor_organization_id_id_unique` index first (vendor doesn't have one today), which is a
purely additive change, not a migration to anything that already exists. Confirms the
comment at `schema.ts:9-15`.

**N7 (housekeeping, not fixed here) — `db/README.md:38-39` names the wrong migration file
(`0000_majestic_whiplash.sql`; the actual file is `drizzle/0000_elite_nightmare.sql`) and says
"12 MVP tables" where 13 now exist (the count includes `organization`, added after that
paragraph was written). Two files under `.claude/agent-memory/database/` reportedly carry
other stale migration filenames per the task brief. Cosmetic, but worth a pass before this
doc is someone's first read of the project.**

---

## 3. What is genuinely well done

- **The composite tenant FK on `count_line`/`count_line_write` (A1).** Turns "organization_id
  must never drift from its parent's" into something InnoDB enforces, not something every
  future query has to remember. The clearest example of "enforce in the schema, not just in
  application code" in this codebase, and the standard the rest of the schema should have been
  held to (see B1).
- **The `count_line_write` append-only ledger.** Genuinely fixes the bug it replaced (a single
  mutable `client_line_id` column that could only remember the most recent write). The design
  — idempotency via a unique-index violation on insert, delta-shaped rows so "sum the deltas"
  reconstructs a line's history including corrections — is correct and well-documented, and the
  `applyIncrement`/`setCountLineQuantities` implementations actually follow the invariant the
  comment prescribes (rollback-then-reread-then-return-success, never surface a replay as an
  error to the caller).
- **`ProductPar.location_scope` generated column** (`schema.ts:466-469`). A real, minimal
  solution to "NULL isn't distinct from NULL in a unique index" — collapsing NULL to a
  sentinel that no real row can ever have, rather than reaching for an application-level
  uniqueness check that a race could slip through.
- **Nullable `unit_cost_at_count`/`case_size_at_count`**, with the exclusion-not-zero
  discipline actually carried through `lib/domain/valuation.ts` end to end — `computeLineUnits`
  correctly distinguishes "zero cases of an unknown size" (unambiguously zero) from "some
  cases of an unknown size" (indeterminate), which is the one subtlety this design was at real
  risk of getting wrong.
- **Cost-gating in the query, not the response shape** (`lib/domain/catalog.ts:150-184`,
  `lib/domain/counts.ts:207-229`). `selectProducts` doesn't fetch `current_unit_cost` at all
  for a non-owner caller — there's no code path where it could leak downstream by accident, a
  materially stronger guarantee than filtering it out of a response object after the fact.
- **The count-then-count_line lock ordering discipline** (`counts.ts:722-730`'s comment,
  followed consistently by `applyIncrement`, `setCountLineQuantities`, `editCountLineFills`).
  Correctly reasoned and correctly applied — it prevents deadlocks *between* these different
  write-path types. (It does not, and isn't meant to, prevent the separate gap-lock deadlock in
  B2, which is between two instances of the *same* write path on different keys.)

---

## 4. Recommendations, in order

1. **Fix B1 at the schema layer now** — add `vendor_organization_id_id_unique` on `vendor`
   and a composite FK from `product(organization_id, vendor_id)`, plus composite FKs for
   `product_par` and `product_barcode` against `product(organization_id, id)`. Cheap now
   (unapplied migration); flag the accompanying app-layer ownership check in
   `createProduct`/`updateProduct` as a required follow-up outside this audit's write scope.
2. **Fix B2** — either switch `upsertCountLineRow` to the `INSERT ... ON DUPLICATE KEY UPDATE`
   pattern `schema.ts` already documents, or add a deadlock-retry wrapper around the
   transaction. Not a schema change, but blocks correctly under the exact concurrency this
   schema was built for; do this before the first count with two simultaneous counters.
3. **F1 — widen `count`/`count_line`/`count_line_write`'s id chain to `bigint` now**, while it's
   a type-change in an unapplied migration. Free today; a live-table rebuild once the ledger is
   large.
4. **F2 — re-key `product_active_idx`, `product_category_idx`, `count_status_idx` as
   `(organization_id, ...)` composites.** Free today; matches the pattern already used
   correctly elsewhere in the same file.
5. **F3 — pin `utf8mb4` explicitly** (connection charset + `db/README.md`'s setup
   instructions) rather than depending on hPanel's database-creation default. Cheap; protects
   against a real, quiet data-corruption mode for a liquor catalog with accented names.
6. **F4/F5 — add the `session.expires_at` index and a pool acquire timeout.** Both free,
   neither urgent; do them opportunistically rather than waiting for a dedicated pass.
7. **A3 — write down the tenant-offboarding story** (deactivate-not-delete, retention default,
   manual export/delete path) before the first customer cancellation, not before any schema
   change.
8. **N7 — fix the stale filenames/table count in `db/README.md`** whenever it's next touched;
   not worth a dedicated pass on its own.
