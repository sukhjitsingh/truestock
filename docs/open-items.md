# Open items

Known gaps, carried deliberately rather than forgotten. Each one says **when** to
pick it up — the trigger matters more than the item, because most of these are
correct to ignore until their trigger fires.

Close an item by deleting its section and saying so in the commit message.

---

## 1. Nothing has ever run against MySQL

**Trigger: the first time a real database exists. Do this before anything else.**

The entire stack has been typechecked, linted and built, but no query has ever
executed. No migration has been applied. Specifically unverified:

- **The replay rollback in `applyIncrement`** (`lib/domain/counts.ts`) — the crux
  of the double-count fix. The design assumes MySQL/InnoDB leaves a transaction
  continuable after a duplicate-key error and that rolling back undoes the
  increment written earlier in the same transaction. Standard InnoDB behaviour,
  reasoned not exercised.
- `count_line_write` → `count_line` foreign key and cascade behaviour.
- Better Auth's actual SQL under `advanced.database.generateId: "serial"` against
  the int-PK auth tables. If this is misconfigured, every auth write fails.
- The inactive-user session hook end to end (sign in → session refused).
- `scripts/create-user.ts` inserting a working credential account.
- `partial_fills` JSON round-tripping, and mysql2's real `ER_DUP_ENTRY` error
  shape in this Drizzle version — the increment path branches on it.
- `DECIMAL(10,4)` precision round-trip through drizzle's string mode.

**How to close it:** stand up MySQL, `db:migrate`, `db:seed`, create an owner,
then drive one count through draft → closed including a deliberate duplicate
submit and a mistyped-then-corrected sealed quantity.

## 2. `editCountLineFills` writes no ledger entry

**Trigger: when the compliance packet (spec §10, Phase 3) is built. Not before.**

Every other write path to `count_line` records a `count_line_write` row. Fill
corrections do not, because `count_line_write.partial_fills_delta` is modelled
for additive appends from the scan path, and a full-array replace has no
delta representation in that shape.

Not a correctness bug: a replace is naturally idempotent, so a replayed fill
correction produces the identical row state. It is an **audit trail** gap — the
count is right, but "who changed this bottle's fill level, and when" is not
recoverable. That only matters for the audit packet, which is deferred.

**How to close it:** decide a ledger convention for replaces (a discriminator
column, or storing before/after arrays) and write the entry inside the existing
transaction. Do not invent the convention silently — it changes what the audit
export means.

## 3. No user-management action exists

**Trigger: the moment anyone needs to deactivate a user or change a role.**

Today `user.role` and `user.active` are only ever written by
`scripts/create-user.ts` (create-only). Deactivating a bartender means a manual
`UPDATE` against the database.

When the action is built it **must revoke the user's `session` rows in the same
transaction** as flipping `active`. Authorization re-reads `active` from the
database on every server action, so a deactivated user is already locked out of
all app data on their very next request — but their Better Auth session row
stays valid until natural expiry, and an account that is off should not leave a
live session behind. `auth.api.revokeUserSessions` or a direct delete of the
user's `session` rows, inside the same transaction.

Also note: there is no owner-facing "add user" screen. Accounts are created by
CLI only, deliberately — no public signup path can hand out a role. A back-office
user screen is a reasonable later addition; a public one is not.

## 4. Costs are not entered, so valuation is untested in anger

**Trigger: when the owner enters real costs from supplier invoices.**

97 products are seeded; only the 9 draft kegs carry a real cost (from the
workbook's Draft Economics tab). Every other product has `current_unit_cost`
NULL, and no product has a `case_size`.

**Corrected 2026-07-26:** the missing `case_size` is a far smaller job than the
missing costs, and mostly is not a gap at all. `case_size` applies to **bottled
beer only** — 16 products. Liquor is counted as bottles, kegs are counted in
tenths, and for both a NULL case size is correct, not missing. `computeLineUnits`
only treats NULL as indeterminate when `sealed_case_qty > 0`, so it never
excludes a line counted purely as eaches or partials. So: 16 case sizes to enter,
88 unit costs to enter, and the costs are the real work.

The code handles this correctly — `unit_cost_at_count` and `case_size_at_count`
are nullable, NULL means "unpriced at count time", unpriced lines are excluded
from totals and reported as a separate count rather than valued at zero. But
that path has never been exercised against real data, and a count taken today
would be almost entirely unpriced.

Related, from the workbook itself: the 5 wines are varietals (`Merlot`,
`Chardonnay`) rather than specific bottles. They need a producer before they can
be costed or scanned.

## 5. Deployment prerequisites not yet settled

**Trigger: before the first deploy to Hostinger.**

- Confirm Next.js 16.2.11 carries the July 2026 advisory fixes (spec §11:
  middleware/proxy bypass, SSRF via rewrites and Server Actions, image
  optimization). It is on npm's `latest` tag, but this was never verified
  against GitHub Security Advisories — no network access to them from the audit
  environment.
- `poweredByHeader: false` and a `headers()` block (HSTS, `nosniff`,
  frame-ancestors, a baseline CSP) are not set. Cheap, worth doing once there
  are real pages.
- `sharp`'s libvips CVEs are dormant **only because** `images.unoptimized` is
  true. That setting now has a security reason behind it, not just a hosting
  one. Do not flip it without re-auditing.
- Dev-only advisories (`brace-expansion`, `esbuild` via drizzle-kit/tsx) and a
  `postcss` copy vendored inside Next itself — none reach production, recheck on
  each Next bump.

## 6. Migrations are regenerated in place — this must stop at launch

**Trigger: the moment any migration is applied to a database that matters.**

`drizzle/` currently holds a single initial migration that has been deleted and
regenerated three times as the schema changed, because nothing has ever been
applied anywhere. That is the right call pre-launch and the wrong one after.

Once a real database exists, migrations are append-only forever: new file, never
an edit to an applied one.

## 7. Open questions from CLAUDE.md still unanswered

Not blocking, but they shape work that is coming:

- **Par scope** — per product or per location? `ProductPar.location_id` is
  nullable so this can stay open; the MVP writes NULL rows only.
- **Open vs sealed split** — how many of the 97 units are open bottles versus
  sealed backstock is still unknown, and it drives the counting-speed estimate
  the whole design is justified by.
- **Count cadence** — weekly gives usable variance, monthly barely does.
- **Shelf life** — resolved for now: `product.shelf_life_days` and
  `count_line.opened_at` exist, unused, with no UI. If shelf life turns out to
  be load-bearing (opened vermouth, cream liqueurs), the columns are already
  there.

## 8. New reads are written but still unexercised against MySQL

**Trigger: folded into item 1 — verify when a real database first exists.**

The read-side gaps this section used to list are closed (see the commit that
removed them). What replaces the item is narrower: the four reads added to
close them have been typechecked but, like everything else, never run.

- `listCounts` aliases `user` twice in one query (`opened_by`, `closed_by`)
  and LEFT-joins both. Worth eyeballing the generated SQL once.
- `previousCountComparison` filters on `lt(count.closedAt, ...)` against a
  **nullable** column. NULL comparisons are never true in SQL, which is the
  behaviour wanted here — a count that was never closed must not be a
  comparison candidate — but it is worth confirming rather than assuming, as
  a silently empty "vs. previous" reads exactly like a first count.
- `getCountTotals` runs `computeCountTotals` against the pool while
  `closeCount` runs the same function inside its `FOR UPDATE` transaction.
  Confirm the two agree on a count with unpriced lines.
