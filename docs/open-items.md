# Open items

Known gaps, carried deliberately rather than forgotten. Each one says **when** to
pick it up — the trigger matters more than the item, because most of these are
correct to ignore until their trigger fires.

Close an item by deleting its section and saying so in the commit message.

---

## 1. Most of the stack has still never run against a real database

**Trigger: the first time a real database exists. Do this before anything else.**

**Engine correction, 2026-07-28.** Production is **MariaDB 11.8.8**, not MySQL —
hPanel's "MySQL Databases" label had been taken at face value everywhere.
The whole chain plus the seed was re-verified against `mariadb:11.8`, and the
schema proved portable: same 14 tables, same 1452 on a cross-tenant id, same
1062 on a second overall par, `DECIMAL(10,4)` exact, `partial_fills` still a
parsed array. No migration needed changing. Local development now runs MariaDB
via `docker-compose.yml`, so everything below is exercised against the engine
production actually runs.

The `partial_fills` result deserves one flag: MariaDB stores `JSON` as a
`longtext` alias, so the parsed array comes from `mysql2`, not from the column
type. That belongs in the test suite — a driver bump could change it silently.

**Partially closed 2026-07-27.** The schema half is now verified: the full
migration chain `0000 → 0001 → 0002` was applied to MySQL 8.0 in Docker, and
probe queries confirmed the composite tenant foreign keys reject cross-tenant
`vendor_id` / `product_id` / `location_id` (FK 1452), that a NULL foreign id
correctly skips the check, that `product_par`'s generated `location_scope`
collapses NULL to 0 and blocks a second "overall" par (1062), that two tenants
can enrol the same UPC, and that accented product names round-trip. The
`count_line` gap-lock deadlock was also reproduced (1213) and the
`withLockRetry` fix verified end to end.

**Auth is closed, 2026-07-28.** The first application-level queries have now run
against a real database — the whole auth path, against MariaDB 11.8.8 in Docker.
Three bullets below moved from "unverified" to verified:

- **Better Auth under `generateId: "serial"` works.**
  `bun run create-user -- --email owner@truestock.local --name "Local Owner"
  --role owner --org truestock` returned **user id `1`** — an integer, not a
  nanoid string. This was the "if this is misconfigured, every auth write
  fails" item; it is configured correctly.
- **`scripts/create-user.ts` produces a usable credential account.**
  `POST /api/auth/sign-in/email` with that account returns 200, a session
  token, and a cookie. `internalAdapter.linkAccount` and the password hash
  round-trip correctly through the int-PK `account` table.
- **The inactive-user check works, and the control proves it.** With the
  session cookie: `/office`, `/office/catalog`, `/office/reorder` and `/count`
  all return 200. Without it, all four 307 to `/login`. Then, holding a
  *still-valid* Better Auth session and setting `user.active = 0` directly in
  the database, `/office` 307s to `/login` — and returns to 200 when `active`
  goes back to 1. That is `requireSession()`'s defence-in-depth re-read doing
  exactly its job: Better Auth's own session was never invalidated, and the
  request was refused anyway.

  The control row is the point. Without the unauthenticated 307s, four 200s
  would prove the pages render, not that anything is gated.

**The write path is closed, 2026-07-28**, by `tests/count-write-path.test.ts` —
17 tests against MariaDB 11.8 in Docker, wired into CI as a service container so
this stays true rather than being a thing that was once true. Every item below
now has a test rather than an argument:

- ~~**The replay rollback in `applyIncrement`**~~ — **verified.** The same
  `clientLineId` applied twice increments exactly once, leaves one ledger row,
  and — sent a second time with a *different* payload — leaves the original
  line completely untouched. InnoDB does roll the whole transaction back on the
  ledger's duplicate-key violation, on MariaDB, as designed.
- ~~`count_line_write` → `count_line` foreign key~~ — **verified**, an insert
  against a non-existent line is rejected.
- ~~Better Auth's SQL under `generateId: "serial"`~~ — **verified**, see above.
- ~~The inactive-user session hook~~ — **verified**, with negative control.
- ~~`scripts/create-user.ts`~~ — **verified**, sign-in returns a session.
- ~~`partial_fills` JSON round-tripping~~ — **verified through drizzle**, not
  just through raw mysql2: `[0.3, 0.8]` reads back as a real `number[]` off the
  actual `count_line` row, and a second write appends rather than replaces.
- ~~`DECIMAL(10,4)` through drizzle's string mode~~ — **verified**, asserted as
  the exact string `"24.5000"` rather than with a float tolerance, because a
  tolerance would pass even if string mode broke.

**These tests have teeth, and that was checked rather than assumed.** Deleting
the ledger insert from `applyIncrement` — the entire idempotency mechanism —
makes exactly the four dependent tests fail and leaves the unrelated ones
passing. A suite that goes green against a broken implementation is worse than
no suite, so this is worth re-doing after any significant change to the write
path.

Also covered while the harness existed, all previously untested: closed counts
refuse writes (invariant 1), the cost snapshot survives a later change to the
product's price (invariant 2), three scans of one product in one location make
one row (invariant 3), a manager never receives cost fields even though the
database row carries them (invariant 8), and a cross-tenant `locationId` or
`countId` is refused rather than silently accepted (invariant 9).

Still untested on the write path:

- **Concurrency.** The gap-lock deadlock and `withLockRetry` were reproduced
  manually against MySQL, never against MariaDB, and never as a test — bun's
  test runner needs two genuinely parallel connections to force it.
- **`editCountLineFills`**, which by design writes no ledger row (item 2).
- **The `scanCountLine` barcode path**, which nothing calls yet (item 10).

**How to close it.** The first four steps are done and reproducible from a cold
clone:

```bash
bun run docker:up          # MariaDB 11.8 + Node 22 app
bun run docker:migrate
bun run docker:seed
docker compose exec -T app bun run create-user -- \
  --email owner@truestock.local --name "Local Owner" \
  --role owner --org truestock --password '<12+ chars>'
```

(`--password` only because `exec -T` has no TTY for the hidden prompt. Never do
that against production — use the prompt, which is why it exists.)

Then run the suite, which needs no manual setup of its own:

```bash
bun run test:docker    # 17 tests, against truestock_test on the same container
```

**What remains is the UI**, not the domain. The write path is proven at the
domain layer; nobody has yet driven a count through the actual screens on a
phone, and item 9's offline queue is still entirely unexercised in a browser.
Those are now the shortest path to a genuinely trustworthy first count.

**Partially addressed 2026-07-28.** The back office has now been driven in a
real browser for the first time — signed in through the actual form, landed on
the new dashboard, navigated the office routes, console clean. That is what
surfaced item 13, which had made every client-side interaction in the app
non-functional while every server-side check passed. The counting screens on a
phone, and the offline queue, remain untouched.

## 1b. Nothing sweeps expired sessions

**Trigger: first production deploy, or the first time `session` row count is
noticed growing. Not urgent — at 3–5 users per tenant this is years away from
mattering.**

`session` gains a row per login and nothing ever deletes one. The index needed
to sweep them cheaply now exists (`session_expires_at_idx`, added by migration
0002 for exactly this reason), so the remaining work is only the job itself:

```sql
DELETE FROM session WHERE expires_at < NOW() LIMIT 1000;
```

Hostinger cron is already available (`hosting_createAccountCronJobV1` via the
Hostinger MCP), so this is a scheduled task, not a feature. Batch the delete —
an unbounded one on a large table locks longer than a nightly job should.

Schema audit 2026-07-27, finding F4. The index half is done; this is the half
that was deliberately deferred.

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
  `X-Frame-Options`, `Permissions-Policy` with `camera=(self)`) are in
  `next.config.ts`.
- **Corrected 2026-07-28: the CSP is no longer one of them.** It shipped
  here as a static header and broke the entire client bundle — see item 13.
  It now lives in `middleware.ts` with a per-request nonce and must stay
  there.
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

## 8. New reads are written but still unexercised against a real database

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

## 11. One location count mode was assigned without the owner

**Trigger: before the first real count — one question, ask it.**

`location.count_mode` is new (`tenths` | `quantity`), because CLAUDE.md says
the input mode is "driven entirely by location" and there was nowhere to put
that. Speed Rail, Back Bar and Storeroom come straight from the owner's own
notes in `locations.csv`. One is still inferred:

- **Walk-In → `quantity`.** From its note, "Packaged beer." If open kegs
  live in there, it needs `tenths` instead.

Getting it wrong is not silent — the screen visibly offers the wrong input —
but it is annoying enough mid-count to be worth one question first.

**Wine Rack is settled: `tenths`, and it does not need confirming.** `tenths`
is the superset mode — it offers the fill pad *and* sealed quantities, where
`quantity` offers only quantities. So a tenths location can record anything a
quantity location can. It is the safe default wherever the answer is
uncertain or low-stakes, which is exactly the wine situation (item 12).

## 12. Wine features are deferred — DECIDED 2026-07-26

**Trigger: if wine ever becomes a meaningful share of sales. Not before.**

Owner's call: wine volume is limited enough that wine-specific work is not
worth doing. This is a scope decision, not a gap.

What that means concretely, so a future session doesn't "fix" it:

- **The 5 seeded wines stay varietals** (`Merlot`, `Chardonnay`) with no
  producer. They cannot be scanned — no barcode maps to a varietal — so in
  practice they get counted via the search picker, which works fine.
- **`needs_producer` stays** in `lib/domain/catalog.ts`'s incompleteness
  predicate and keeps showing its pill in the catalog's "needs attention"
  view. It is three lines, already written, and describes something true.
  Deferring wine means *nobody has to act on it*, not that the app should
  stop reporting it. Leave it alone rather than spending a change to hide
  a fact.
- **Nothing is blocked by it.** Unpriced and unscannable wine lines are
  excluded from valuation and reported as excluded, which is the same path
  the other 88 uncosted products already take (item 4). Wine is not a
  special case in any code.
- Vintage tracking was already a non-goal (spec §16 Q5) and stays one.

## 13. ~~A static CSP blocked every inline script — nothing hydrated~~ — CLOSED 2026-07-28

Recorded rather than deleted, because the *shape* of this failure is the
lesson, and the production half is not yet verified.

`next.config.ts` served a static `script-src 'self' 'wasm-unsafe-eval'`. Next's
App Router ships the request id (`self.__next_r`) and the streamed RSC payload
(`self.__next_f.push`) as **inline** `<script>` tags; a static header cannot
carry a nonce, so both were blocked and the client bundle threw during
bootstrap:

```
InvariantError: Expected a request ID to be defined for the document
via self.__next_r.   at createDebugChannel   at appBootstrap
```

Nothing on any page hydrated. Proven at runtime rather than inferred — the
`<script>` tag was present in the DOM carrying the assignment while
`self.__next_r` was `undefined`.

**Why it survived every gate.** The server rendered correctly and returned 200,
so `curl`, `next build`, the `/ship` gate and every status-code assertion
passed against an app in which no button worked. It also caused a credential
leak: with no hydration the login form's `onSubmit` never attached, so submits
fell back to a native GET and put the plaintext password in the query string
and the server access log.

**Fixed** by moving the CSP to `middleware.ts` with a per-request nonce
(development additionally gets `'unsafe-eval'` and `ws:` for Turbopack HMR,
scoped by `NODE_ENV`), and removing it from `next.config.ts` — two CSP headers
are intersected by the browser, so leaving both would have kept blocking.
The login form now carries `method="post"` and a hydrated-gated submit.

**Still open: the production CSP is unverified.** Development proves the nonce
mechanism works (`'unsafe-eval'` does not permit inline `<script>`, and
`'unsafe-inline'` is absent, so the nonce is what made it run). Production
drops `'unsafe-eval'` and `ws:`. **Trigger: before the first deploy.** Run
`next build && next start` and load a page in a real browser — a 200 is not
evidence, which is the entire point of this item.

## 14. The dashboard's stat tiles are computed from capped queries

**Trigger: when the catalog passes ~100 products, or counts pass ~50. Sooner
if either number starts being quoted to anyone.**

`app/(office)/office/page.tsx` derives two figures from list reads that take a
`limit`:

- "N active products" and the unpriced count come from
  `searchProductsAction({ activeOnly: true, limit: 100 })`. At 101 products the
  tile silently understates.
- The last-closed-count tile finds its count inside
  `listCountsAction({ limit: 50 })`. With 50 non-closed counts ahead of it, it
  would report "no count has been closed yet" against a database full of them.

Both are correct against today's 97-product seed and would stay plausible
while becoming wrong — the failure mode CLAUDE.md names as this app's worst.
Reusing the existing actions was the right call for a first cut (no new
unscoped reads, tenancy enforced in one place), but the fix is a dedicated
aggregate read in `lib/domain/`, not a bigger `limit`.

## 15. The dashboard's owner-only value branch has never rendered

**Trigger: the first time a count is actually closed.**

The "last closed count" tile's `Money` value and its vs-previous `valueDelta`
have never executed — no closed count exists yet, so that branch has only ever
taken its empty path. The "count in progress" branch *has* now rendered with
real data (a draft count, with its Resume action).

Cheap to close: close one count and look at the tile.
