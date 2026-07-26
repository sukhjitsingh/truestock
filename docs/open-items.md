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

## 5. ~~Deployment prerequisites not yet settled~~ — CLOSED 2026-07-26

Resolved by the devops build-out (`docs/deploy.md`):
- Next.js 16.2.11 verified directly against GitHub Security Advisories
  (`api.github.com/repos/vercel/next.js/security-advisories`, not assumed
  from the npm tag) — it already carries every fix in the July 2026 batch.
  See `docs/deploy.md` §6 for the advisory-by-advisory table.
- `poweredByHeader: false` and a `headers()` block (HSTS, `nosniff`,
  `X-Frame-Options`, `Permissions-Policy` with `camera=(self)`, and a
  baseline CSP with `wasm-unsafe-eval` for the barcode-detector WASM
  polyfill) are now in `next.config.ts`.
- `images.unoptimized: true` is unchanged, with its security rationale
  (keeps `sharp`'s libvips CVEs dormant) now documented directly in
  `next.config.ts`'s own comment, not just here.

The dev-only-advisory / recheck-on-bump duty from this item doesn't have a
one-time close — it's now a standing process note in `docs/deploy.md` §5
("Security patching — ongoing, not one-time") instead of a dangling open
item.

## 6. ~~Migrations are regenerated in place — this must stop at launch~~ — CLOSED 2026-07-26

Enforced now, not just documented: `scripts/check-migrations-immutable.sh`
runs in CI (`.github/workflows/ci.yml` and the `verify` job in `deploy.yml`)
and fails the build if any PR modifies, renames, or deletes a `drizzle/*.sql`
file that already existed on `main`. New migration files are unaffected;
`drizzle/meta/_journal.json` and the snapshot files are deliberately not
checked (drizzle-kit owns those, and legitimately appends to them on every
`generate`).

This closes the policy gap, not item #1 below — the check has never yet run
against a PR that touches an already-merged migration, because nothing has
merged to `main` yet.

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

## 9. The offline write queue has never been exercised in a browser

**Trigger: the first real count. Do this deliberately — turn the WiFi off
mid-scan rather than waiting to find out in the walk-in.**

`lib/count-queue.ts` + `flush()` in `components/count/count-leg.tsx` were
written, reviewed, and corrected once already (the queue originally had no
drain path at all), but the whole mechanism has only ever been reasoned
about. What to verify, in one pass:

- Turn WiFi off, count three bottles, confirm the chip reads "3 pending"
  and the rows still appear.
- Turn WiFi back on and confirm the `online` listener fires and drains them.
- Kill the app with writes queued, reopen it, and confirm the mount-time
  flush sends them.
- The one that matters most: confirm a write that reached the server *just
  before* the connection dropped does not apply twice when the queue
  resends it. That is what the `client_line_id` on the queue record is for,
  and it is the failure this whole design exists to prevent.

Walk-ins are metal boxes and routinely kill WiFi (spec §11 says to test
this) — so this is the room where the queue either works or the count is
wrong.

## 10. `scanCountLine` is fully built and unreachable from the UI

**Trigger: when someone times a real count and wants it faster.**

`scanCountLineAction` / `lib/domain/counts.ts`'s `scanCountLine` resolve a
barcode server-side and apply a pack-level-aware +1 in a single call, and
its own doc comment calls it "the primary write path during a live count."
Nothing calls it. The UI implements CLAUDE.md's stated core loop instead —
scan → resolve → tap tenths or type a quantity → next — which needs the
read (`resolveBarcodeAction`) plus `incrementCountLine`, not this.

So this isn't a bug, it's an unused door: a rapid-fire "each scan is one
more of this" mode for sealed backstock, where the quantity is always 1 and
the entry screen is pure overhead. That could be a real speed win on the
60–75% of units that are sealed. **Decide it against a timed count, not in
the abstract** — and if the answer is no, delete the action rather than
leaving a hardened write path that nothing exercises.

## 11. Two location count modes were assigned without the owner

**Trigger: before the first real count — one question, ask it.**

`location.count_mode` is new (`tenths` | `quantity`), because CLAUDE.md says
the input mode is "driven entirely by location" and there was nowhere to put
that. Three assignments come straight from the owner's own notes in
`locations.csv`: Speed Rail and Back Bar are `tenths`, Storeroom is
`quantity`. Two were inferred and need confirming:

- **Wine Rack → `tenths`.** Assumes wine by the glass means open bottles
  with fill levels. If the rack is actually sealed stock, this is wrong.
- **Walk-In → `quantity`.** From its note, "Packaged beer." If open kegs
  live in there, it needs `tenths` instead.

Getting one wrong is not silent — the screen visibly offers the wrong
input — but it is annoying enough mid-count to be worth one question first.
