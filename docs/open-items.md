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

## 8. Read-side gaps found while designing the UI

**Trigger: when the React implementation of these screens starts. Before, not during.**

Designing against the real server actions surfaced reads that do not exist yet. None is a
bug in what was built; each is a hole the UI will otherwise paper over.

- **No live progress totals for an in-progress count. DECIDED 2026-07-26: extract
  `getCountTotals` before building the count-session screen.** `totalUnits`,
  `pricedLineCount`, `excludedLineCount` and `totalValue` are computed only inside
  `closeCount`, so nothing can ask for them mid-count.
  To be precise about the risk: `getCountAction` already returns per-line `units` and
  `extendedValue`, so a client would be re-implementing the *summing*, not the valuation
  rules — a smaller duplication than it first appears. It still matters, because the
  prototype prints the total on the CLOSE COUNT button itself. If the displayed figure and
  the figure `closeCount` computes a second later ever disagree, the user saw one number
  and the immutable record holds another, with no edit path to reconcile them.
  Extract the `summarizeValuation` call into a read-only `getCountTotals(countId)` that
  both `closeCount` and the live screen use, so they cannot drift. Gate `totalValue` to
  owners exactly as `closeCount` does. This also lets the session screen disclose
  `excludedLineCount` continuously — which matters because **no product has a `case_size`
  yet**, so `missing_case_size` (units genuinely indeterminate, not zero) will fire
  constantly on the first real count.
- **`ProductSummary` carries no on-hand quantity.** The catalog's stock cell (units + a
  par-relative bar) needs on-hand from the latest closed count joined against `ProductPar` —
  the same computation `reorderList()` already performs. Decide whether the catalog read owns
  that join or the stock cell is dropped from the catalog table.
- **No `listCountsAction`.** The counts-list screen needs `count` joined against `user` twice
  (`opened_by`, `closed_by`). Nothing reads the count table as a list today.
- **`countSummary` has no aggregation.** No category/location rollup and no previous-count
  comparison, both of which §9 of the spec calls for in the Count Summary report. The
  prototype derives them client-side; the real version should not, and any value aggregate
  needs the same owner-only gate as the per-line figures.

## 9. Wine varietals have no "needs a producer" representation

**Trigger: when the owner enters real costs, alongside item 4.**

The 5 seeded wines are varietals (`Merlot`, `Chardonnay`), not specific bottles, and cannot
be costed or scanned until they name a producer. The catalog prototype surfaces this as a
"Needs producer" pill and a "Needs attention" saved view, but **there is no column backing
it** — the prototype infers the state from category plus a null brand.

Decide before building the catalog screen: is "incomplete product" a derived predicate
(brand IS NULL AND category = 'Wine'), or does it deserve real state? A derived predicate is
probably right and costs nothing; the point is to decide rather than let each screen invent
its own definition of incomplete.
