# Open items

Known gaps, carried deliberately rather than forgotten. Each one says **when** to
pick it up — the trigger matters more than the item, because most of these are
correct to ignore until their trigger fires.

Close an item by striking its heading, adding **— CLOSED &lt;date&gt;**, and
replacing the body with what was actually done and what was learned. (This used
to say "delete the section." Nothing in this file has ever been deleted, because
the close notes turned out to be the most useful part — #9's `next dev` reload
trap and #13's silent CSP break are both things a fresh session would otherwise
rediscover the hard way. The instruction now matches the practice.)

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

**What remains is the UI**, not the domain.

**Largely addressed 2026-08-12.** Four sessions on a real phone drove the
counting screens end to end — camera scan and enrol, tenths, sealed quantities,
valuation, and item 9's offline queue draining on reconnect. What is left is
**scale, not mechanism**: 8 count lines across those four sessions, no timed
pass, no walk covering all five locations.

**Partially addressed 2026-07-28.** The back office has now been driven in a
real browser for the first time — signed in through the actual form, landed on
the new dashboard, navigated the office routes, console clean. That is what
surfaced item 13, which had made every client-side interaction in the app
non-functional while every server-side check passed. ~~The counting screens on a
phone, and the offline queue, remain untouched.~~ **Both driven 2026-08-12 —
see the note above.**

## 1b. Nothing sweeps expired sessions — **HALF CLOSED 2026-08-12, cron still owed**

**The sweep exists and is tested; only the schedule is missing.** `9f81967`
added `sweepExpiredSessions` in `lib/domain/sessions.ts`, runnable as
`bun run sweep-sessions`, with `tests/session-sweep.test.ts` covering it —
including a mutation-checked batch-limit test (removing `.limit(batchSize)`
makes it delete 5 rows where 2 were expected, and that test fails).

**Trigger for the remaining half: the first production deploy.** The cron can
only be created against Hostinger, which is Phase 3, so this is scheduled work
rather than unfinished work — do not read it as an incomplete slice. Create it
with `hosting_createAccountCronJobV1` when the deploy happens, and tick it off
in `docs/go-live.md` rather than here.

The original entry, still accurate about the shape of the problem:

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

**Updated 2026-07-30 — the function is now actually reachable.** It had zero
callers when this item was written, which made the gap theoretical. `FillEntry`
now has a correction mode (docs/mvp-gaps.md finding C), so fill corrections are
a real thing that happens during a real count, and "who changed this bottle's
fill level, and when" is a real question with no answer.

That raises the priority but does not change the trigger, and it is still not a
correctness bug. Every other write path to `count_line` records a
`count_line_write` row. Fill corrections do not, because
`count_line_write.partial_fills_delta` is modelled for additive appends from
the scan path, and a full-array replace has no delta representation in that
shape.

A replace is naturally idempotent, so a replayed fill correction produces the
identical row state — the count is right either way. It is an **audit trail**
gap.

**Half of the work is already done.** `editCountLineFillsSchema` now requires a
`clientLineId` (the offline queue needs an id to store the write under), so
closing this is a change to the domain function alone rather than to the
boundary and every caller of it.

**How to close it:** decide a ledger convention for replaces (a discriminator
column, or storing before/after arrays) and write the entry inside the existing
transaction. Do not invent the convention silently — it changes what the audit
export means.

## ~~3. No user-management action exists~~ — **closed 2026-08-03**

`lib/domain/users.ts` — `listUsers`, `setUserActive`, `setUserRole` — with all
three guards in place: self-deactivation blocked, self-demotion blocked,
last-active-owner lockout blocked. `setUserActive` deletes the user's `session`
rows in the same transaction, so a deactivated account is locked out on its
very next request with no live session remaining.

`app/actions/users.ts` — three owner-only server actions wrapping the domain.
`components/office/office-rail.tsx` exposes the Users link for owner role
(it was `office-nav.tsx` until the rail replaced the top nav on 2026-08-13).
`/office/users` renders the list with role-change selects and active toggles.

Tests: `tests/user-write-path.test.ts` (DB-backed, bun:test) covers all three
guards and the cross-tenant refusal. `tests/rapid-scan.test.ts` covers
idempotent `client_line_id` behaviour on the count write path alongside.

**Status: browser-verified 2026-08-04.** `scripts/verify-browser.mjs` drives
the screen in a real Chromium and asserts on behaviour that only exists if
React attached — 11/11 checks, no CSP violations, no console errors. The one
that matters: changing your own role is refused *and the select snaps back to
the role you actually have*, with the message on screen. A control left
showing a role the user does not hold is the same silent-wrong-value class
CLAUDE.md warns about, moved from counts to authorization.

Two corrections found while verifying, both now fixed:

- The list was fetched in a `useEffect` that called `setState`, which is the
  cascading-render pattern the React lint rule rejects — it was the single
  error in `bun run lint` — and it painted an empty table on first load. It
  now reads on the server and passes rows down, like VendorsList and every
  other office screen. `router.refresh()` after a write re-reads it.
- `refuses to demote the last active owner` asserted a scenario that cannot
  happen: it left two active owners in the org and expected the demotion to
  be refused, but with a second active owner that demotion is legitimately
  allowed. The test was wrong, not `setUserRole`. It is now split into the
  allow case and the refuse case, with the matching deactivation leg that had
  no coverage at all.

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

## ~~9. The offline write queue has never been exercised in a browser~~ — **closed 2026-08-12**

**Exercised on a phone during count 4 and it works.** Airplane mode on, a
quantity submitted, chip read **`1 pending`**; airplane mode off, chip returned
to **`Synced`** with no interaction — so the `online` listener fires and
`flush()` drains. Confirmed in the database afterwards: **one line, one ledger
row, and 8 distinct `client_line_id`s across all four counts.** The queued
write applied exactly once. That is the failure this design exists to prevent
and it did not occur.

**The test could not be run at all until the runtime changed, and that is the
part worth remembering.** Under `next dev` the page reloads itself out from
under you: Next 16's HMR client reconnects a dead websocket 12 times and then
calls `window.location.reload()` (`next/dist/client/dev/hot-reloader/app/
web-socket.js` — its own comment says "it indicates the dev server is no longer
running"). There is no service worker, so that reload lands on the browser's
offline error page and the app is gone, along with the queue's only UI. It
reads exactly like a Truestock bug. `scripts/prod-lan.sh` exists because of
this — production mode has no HMR, and the offline test is only meaningful
there.

**Found while fixing this, and bigger than the item itself:** seven server
action calls on the counting path were awaited with **no try/catch**, while
`runWrite` beside them had always been guarded. Offline, the fetch threw out of
an async handler, so no error was set, no phase changed, and `busy`/`pending`
were never cleared — you scanned, the scanner closed, and nothing happened at
all. Two of the seven were *writes* in the enroll form
(`linkBarcodeToProductAction`, `createProductAction`) that do not go through
the queue, so the form sat disabled and silent with the typed details
unrecoverable. All seven now wrapped, with the flag cleared in a `finally` and
messages that say "not saved, try again in range" rather than implying a queue
that does not cover them. The offline message was confirmed on the phone in the
same pass.

**Still not exercised**, and neither is urgent enough to hold this item open:
killing the app outright with writes queued to prove the *mount-time* flush
(only the `online` path was observed), and a queue holding more than one write
at a time.

## ~~10. `scanCountLine` is fully built and unreachable from the UI~~ — **closed 2026-08-04**

**The trigger was "decide it against a timed count, not in the abstract."
The owner asked for it directly, which settles the question this item was
holding open.** The action is now wired rather than deleted.

`scanCountLineAction` / `lib/domain/counts.ts`'s `scanCountLine` resolve a
barcode server-side and apply a pack-level-aware +1 in a single call. The
normal loop does not need that — it reads with `resolveBarcodeAction` and
writes with `incrementCountLine` — but rapid mode does, and that is the
reason to use it here: the barcode is re-resolved on the SERVER, so the pack
level deciding case-vs-each is never taken from the client. Invariant 4
holds without the client having an opinion.

**Rapid mode is offered only on quantity locations** (Walk-In, Storeroom).
A tenths leg needs a fill reading per open bottle, and a blind +1 there would
record a whole sealed bottle for a part-full one — the count reads high with
nothing on screen looking wrong. The toggle is hidden rather than disabled,
because the location chip already states the input mode; a greyed-out control
would be asking a question the screen has answered.

Three things this needed that were not visible from the item:

1. **The scanner stopped after one hit** (`return; // parent closes us`).
   Correct for one-shot use, inert in rapid mode where nothing closes it: the
   camera would sit live and dead after the first bottle. It takes a
   `continuous` prop now.
2. **The frame guard is its own module**, `lib/rescan-guard.ts`, because a
   detector reports a barcode on every frame it is visible and the rule that
   decides which frames count is the part that can miscount an inventory. It
   keys on frame *continuity*, not on the barcode value — "ignore a repeated
   value" would be wrong on any shelf holding two of the same thing. Writing
   its tests found two real bugs: a cooldown sized to bottle spacing rather
   than detector flicker (which silently refused scans during a fast sweep),
   and a `lastHitAt` of 0 that was indistinguishable from a real hit at t=0
   (which silently ate the first bottle of every session).
3. **Rapid writes are serialized through a ref.** `runWrite`'s rollback
   captures a line's pre-write value and is only exact while writes do not
   overlap; `busy` used to guarantee that because every entry screen gated its
   submit on it. Rapid mode has no submit button, so the guarantee had to be
   restored explicitly.

A refusal has nowhere to land when the scanner never closes, so results —
failures included — are shown over the camera. Unknown barcodes still drop
into scan-to-enroll rather than being skipped, and the mode does not survive
a leg change.

Tests: `tests/rescan-guard.test.ts` (11 cases, covering both directions of
failure since either is silent) and `tests/rapid-scan.test.ts`, which now
also pins that mixed case/each scans land on ONE line as 2 cases + 3 eaches
(invariants 3 and 4) and that another tenant's barcode is refused rather than
resolved (invariant 9).

**Still unproven: nobody has counted a real shelf with it.** The guard is
tested against modelled frame sequences, not against an actual camera, an
actual detector, or glossy labels in a dim bar. The numbers that matter —
whether the sweep cadence and the 250ms flicker floor hold up in the hand —
need the timed count this item originally asked for.

## 11. One location count mode was assigned without the owner — CONFIRMED 2026-07-31

**Confirmed 2026-07-31.** The owner answered the one question this item asked:
Walk-In holds sealed packaged beer only, no open kegs. `count_mode` stays
`quantity`, as seeded. **No code change** — the inferred value was correct,
and what this item was waiting on was the confirmation, not the value.

`location.count_mode` (`tenths` | `quantity`) exists because CLAUDE.md says
the input mode is "driven entirely by location" and there was nowhere to put
that. Speed Rail, Back Bar and Storeroom came straight from the owner's own
notes in `locations.csv`. Walk-In was the one inferred — from its note,
"Packaged beer." — rather than confirmed, and is now both.

**Wine Rack was already settled without asking: `tenths`.** `tenths` is the
superset mode — it offers the fill pad *and* sealed quantities, where
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

**CLOSED 2026-08-12: the production CSP is verified.** Run via
`bun run docker:up:prod` and opened in a real browser. Served policy:
`script-src 'self' 'nonce-…' 'wasm-unsafe-eval'` (no `'unsafe-eval'`),
`connect-src 'self'` (no `ws:`). All 16 scripts carried the nonce, React
hydrated, the console was clean of violations, and the barcode scanner
decoded a real UPC under it — which is precisely what `'wasm-unsafe-eval'`
is in the policy for.

**Two things this turned up that matter more than the pass itself.**

1. **`docs/go-live.md`'s own check for this was wrong**, and would have caused
   a false rollback. It said to confirm `typeof self.__next_r !== 'undefined'`.
   `self.__next_r` is set **only by `next dev`** — it is the request id the HMR
   client keys its websocket on, and
   `next/dist/client/dev/hot-reloader/app/web-socket.js` throws the very
   `InvariantError` that item told you to watch for when it is absent. In a
   production build it is correctly undefined. Observed directly: production
   had `self.__next_r === undefined` with React fully hydrated. Corrected there
   to check the sign-in button's hydration gate instead.
2. **Hydration is slower in production than dev**, enough that an immediate
   probe reads as a failure. First check showed the submit disabled and no
   React fiber; three seconds later both had flipped. Anything automating this
   must wait, or it will report the exact failure it is looking for.

**Still unproven:** this ran under `next start`, which printed
`"next start" does not work with "output: standalone" configuration`. It is not
byte-for-byte the runtime Hostinger uses (`node .next/standalone/server.js`).
The CSP and hydration are settled; the standalone entrypoint is not, and stays
on the go-live list.

## ~~14. The dashboard's stat tiles are computed from capped queries~~ — **CLOSED 2026-08-12**

**Closed by `3d8a347`, and verified in a browser against a hand-run SQL count:
the tile reads 99, `SELECT COUNT(*) FROM product WHERE active = 1` returns 99.**

`getCatalogHealth` and `getLastClosedCount` in `lib/domain/catalog.ts` do
dedicated aggregate reads. What matters more is the **removal**: three capped
reads — `searchProductsAction`, `listCountsAction`, `countSummaryAction` —
came out of `app/(office)/office/page.tsx` entirely. Adding uncapped queries
while leaving the capped ones in place would have left the bug in the page;
the tile said 100 *because* it counted `products.length` off a truncated array.

Two things worth keeping from how this was closed:

- **The test had to fail first.** `tests/catalog-health.test.ts` inserts 101
  active products and asserts the capped `searchProducts({ limit: 100 })` read
  returns exactly 100 in the *same* test that asserts `getCatalogHealth`
  returns 101 — so the bug and the fix are both visible in one passing run,
  rather than the fix being asserted against nothing.
- **An "incomplete products" aggregate was designed and then dropped.** Gate 2
  specified one; Gate 3 pointed out the dashboard has four tiles and none of
  them is "incomplete". Its hand-written SQL predicate would have duplicated
  `incompleteReasons` and drifted from it silently. Deleting it removed the
  drift risk by construction instead of by test. See
  `docs/plans/phase-1-to-1.5/02-architecture.md`, Amendment 1.

`unpricedCount` is `null` for non-owners and the query is **skipped**, not
computed and then withheld — invariant 8.

What it looked like before, for the record: "N active products" and the
unpriced count came from `searchProductsAction({ activeOnly: true, limit: 100 })`,
and the last-closed-count tile searched inside `listCountsAction({ limit: 50 })`
— so with 50 non-closed counts ahead of it, it would have reported "no count has
been closed yet" against a database full of them. Both were correct against the
97-product seed and would have stayed *plausible* while becoming wrong.

## 15. The dashboard's owner-only value branch has never rendered

**Trigger: the first time a count is actually closed.**

The "last closed count" tile's `Money` value and its vs-previous `valueDelta`
have never executed — no closed count exists yet, so that branch has only ever
taken its empty path. The "count in progress" branch *has* now rendered with
real data (a draft count, with its Resume action).

Cheap to close: close one count and look at the tile.

## 16. ~~A scanned barcode cannot be attached to an existing product~~ — CLOSED 2026-07-30

Kept rather than deleted because the *shape* is the lesson: the failure had two
modes and the milder-looking one was the dangerous one.

`linkBarcodeToProduct` now inserts a `product_barcode` row against an existing
product, after an ownership check on the client-supplied product id (invariant
9 — a foreign key proves the row exists, not whose it is). `EnrollForm` opens
on **search** rather than on the new-product form, because during the first
count "already in the catalog, just never scanned" is the common case and a
genuinely new product is the rare one.

`pack_level` was the real design question, as this item said. Answered as:
`each` by default with no extra tap, and an each/case choice shown only for
products counted both ways — `isCountedByCase` in `lib/pack-level.ts`, shared
with `incompleteReasons` so there is one definition of what a case is. That is
zero extra taps for 81 of the 97 seeded products and an explicit choice for the
16 where guessing wrong silently miscounts by the case size.

**The two failure modes, for the record.** This item and `STATE.md` both said
the symptom was "a second copy of all 97 products". That was the *second*-worst
case, and it needed the counter to type a name differing from the catalog's.
Typing the catalog's own name — the natural thing to do — hit
`product_name_size_ml_unique` and was a hard stop with no way forward,
mid-count, on the interaction CLAUDE.md holds to a 20-second budget. The
create-only path made the honest action fail and the careless one corrupt the
catalog.

Covered by 7 tests in `tests/catalog-write-path.test.ts`, including that two
tenants can enrol the same UPC against their own products.

## 17. `127.0.0.1` was blocked by Next's dev cross-origin guard — CLOSED 2026-07-28

Recorded because the *shape* is worth remembering, not because it is still
open. Next 16 blocks `/_next/*` for any host outside `localhost`/`*.localhost`
plus `allowedDevOrigins`. `127.0.0.1` is not `localhost` to that check, so the
dev server returned **403 for every client chunk** while the document itself
returned 200 — the page rendered and never hydrated. Meanwhile `lib/auth.ts`
explicitly trusted `http://127.0.0.1:3000` and `docker-compose.yml` published
on it, so two files said the origin was supported and a third silently
disagreed.

Fixed by listing `127.0.0.1` in `allowedDevOrigins` (`next.config.ts`).
Confirmed by request rather than inspection: the same chunk returned 403 for an
`Origin` of `127.0.0.1:3000` and 200 for `localhost:3000`, and afterwards 200
for both.

**The reusable lesson: "renders but does not hydrate" now has two known
causes** — a CSP without a nonce (#13) and this. The cheap check for both is
the same, and it is in `docs/phone-count-test.md`: load `/login` and look at
whether the submit button is still disabled a second later.

## 18. `isDuplicateKeyError` was blind to wrapped errors — CLOSED 2026-07-30

Recorded rather than deleted, because this is the third instance of one pattern
and the pattern is the point.

`lib/domain/db-errors.ts` read `err.code` directly. Drizzle wraps query
failures in `DrizzleQueryError`, which carries `query`, `params` and `cause`
and **no `code` of its own** — so the check returned false for every wrapped
error, and both predicates in that file silently stopped discriminating.

Every `ConflictError` in `lib/domain/catalog.ts` was therefore unreachable.
"A product named X already exists" and "Barcode Y is already assigned to Z"
arrived as *"Something went wrong"* — mid-count, on the highest-risk
interaction, with the actionable half of the message thrown away.

**Why it looked fine.** The paths that had coverage happened to receive
unwrapped errors, so the replay-rollback tests passed and the idempotency
mechanism looked proven. A mocked error object would have passed forever: the
shape that broke it came from the library, not from us.

**Fixed** by walking the `cause` chain (bounded against a self-referential
cause) and matching `errno` as well as `code`. `tests/db-errors.test.ts`
asserts both predicates against the real `DrizzleQueryError` class.

**The pattern, now three deep:** #13 (static CSP), #17 (dev cross-origin 403),
and this. In all three every gate stayed green — typecheck, build, lint, status
codes, and the existing tests — and the bug was found only by exercising the
real thing. When something here "cannot fail", that is the claim worth testing
against the actual library or the actual browser.

## 19. ~~Vendors still have no write path anywhere~~ — CLOSED 2026-07-31

Split out of `docs/mvp-gaps.md` finding H, because finding A being fixed had
changed its status from hypothetical to visible. Closed by `createVendor`,
`updateVendor` and `assignVendorToProducts` (50e2512), and the
`/office/vendors` screen plus bulk catalog assignment that make them reachable
(87a8d63).

Three role-gated server actions (owner/manager, matching `updateProduct` —
vendors and reordering are a manager's job per spec §4), zod schemas, an
idempotent `seedVendors` keyed on `(organization_id, name)` so a re-seed never
duplicates a vendor someone edited in the app, and a screen that lists,
creates and edits — no delete, matching the schema's own deliberate absence of
one. `assignVendorToProducts` is the widest invariant-9 surface in the
catalog: ids are deduplicated first, ownership is checked for every id in one
org-scoped query rather than N, and a list mixing a foreign id with the
actor's own **refuses the whole call** rather than assigning the valid
subset — partial success on a tenancy failure is how a prober learns which ids
are real.

**The domain layer is genuinely verified** — 12 DB-backed tests including
cross-tenant refusal, bulk-assign atomicity with a re-read proving no partial
apply, and reorder grouping end to end. Mutation-checked: disabling the
ownership guard fails exactly one test.

**The screens were driven in real Chrome with database verification** —
create, edit, bulk assign, bulk clear, the stale-selection blocker, the sticky
bar, the consequence strings. Four defects were found doing that, all fixed
the same day (87a8d63's message has the full detail): a stale selection
surviving a search — a blocker, it wrote to off-screen products, and the
header checkbox rendered checked against a selection matching nothing
visible; vendors creatable but not editable (the form existed, nothing wired
it — the build agent reported the capability and only a DOM read caught it);
the bulk bar rendering below 98 rows, off-screen; and the clear-vendor label
reading "Set vendor" when "No vendor" was chosen explicitly.

**The final `router.refresh()` fix in `components/office/vendors-list.tsx` was
the one line here never opened in a browser — CONFIRMED 2026-07-31.** Creating
a vendor from the empty state and editing its name both showed on the list with
no manual reload; the database held exactly one row after the edit (so it
updated rather than inserted); and a real navigation reloaded to the same state,
ruling out a screen that self-updates but disagrees with a reload — which would
have been worse than the staleness it replaced. The dev-only Fast Refresh
empty-state flash seen in an earlier session did not reproduce.

Worth keeping for the shape: the regression existed because `VendorEditForm`
calls `router.refresh()` only on the branch where no `onSuccess` prop is passed,
and `VendorsList` always passes one — so the refresh lived in dead code while
the write succeeded and the screen showed the old name. A save that looks like
it silently failed invites retyping it. **Two overlapping mechanisms are what
produce a dead one;** the refresh now lives with whoever owns the stale data.

Two defects were also found while verifying this, by running things rather
than reading them, and both are recorded as new items below: `vendors.csv`'s
own documentation comment silently broke the entire seed (fixed in `parseCsv`
itself), and `db/seed.ts` ran `main()` at module scope, so importing it to
test the parser fired the real seed against the live database (fixed by
guarding `main()` and moving the parser to `db/csv.ts` — see item 23 for the
sibling script with the identical shape, and CLAUDE.md's migrations/seed
convention).

The other two halves of finding H stay as they were: users are CLI-only (item
3), and locations are seed-only but recoverable by editing
`docs/catalog/locations.csv` and re-seeding.

## 20. The count-leg UI changes have not been driven on a phone

**Trigger: the first phone test — fold into `docs/phone-count-test.md` rather
than doing separately.**

**Widened 2026-08-14 by Phase 2.** This item was written about six changes made
on 2026-07-30. The UI redesign then rebuilt the whole counting surface —
`app/(count)/count/page.tsx`, `count-leg.tsx`, `count-line-card.tsx`,
`fill-entry.tsx`, `quantity-entry.tsx`, `barcode-scanner.tsx`,
`catalog-search.tsx`, `tab-bar.tsx` — so the item's scope is now *every*
counting screen, not six changes on it. What is genuinely new and needs
watching first:

- **The floating bottom bar** (search · scan · finish section), which replaced
  the single *Finish section* button. It exists because scan and search live at
  the top of a screen that grows to several viewports during a leg, so reaching
  them meant scrolling back with the hand not holding a bottle. **It has only
  ever been looked at in a desktop browser window narrowed to 400 px.** That
  proves the layout and nothing about the thumb. Three things to check in the
  hand: that Scan is reachable one-handed without a grip change, that the icon-
  only Search button is discoverable at all (it is a 44 px icon beside a wide
  accent button — if counters never find it, the fallback path for damaged
  labels is effectively gone), and that *Finish section* is hard enough to hit
  by accident that a leg does not end mid-count.
- **Search from the bar focuses the field at the top rather than opening its
  own input**, deliberately, so there is exactly one search box on the screen.
  Confirm the scroll-and-focus actually lands and the keyboard opens — this is
  the kind of thing that works in a desktop browser and fails on a phone
  keyboard.
- **The four bets Phase 2 wrote down** are §6 of `docs/phone-count-test.md` and
  overlap this item heavily. Do them in the same sitting.

The 2026-07-30 material below is still owed and still accurate about *what* to
exercise; just be aware the screens it names have been rebuilt since it was
written, so a described control may have moved.

Six of the 2026-07-30 changes are UI on the counting leg, and every one of them
is backed by domain tests plus a browser hydration check, not by anyone actually
scanning a bottle. Nothing in this repo's test suite imports a React component,
so all six are client state that has never executed:

- **The barcode-link screen** (finding B). Search-first, and the each/case
  choice for beer. Worth timing against the 20-second budget specifically —
  it added a search step to a path that previously went straight to a form.
- **Fill correction** (finding C). The "Correct these" affordance and its
  live `was … · −0.8 units` line.
- **Optimistic rollback** (D1). Needs a deliberately-refused write to see —
  the easiest is to submit a count in one tab and keep scanning in another,
  which is now refused (finding E).
- **The dropped-write message** (D2). Same trick: force a rejection while
  offline and confirm the chip returns to "Synced" and names the write.
- **The size dropdown on the enroll form** (added later the same day). The thing
  to watch is the *reactivity*, not the list: with 750 ml selected, change
  Category to Beer and confirm the size select re-points to the beer list and
  shows 355 rather than rendering **blank** — a `<select>` whose value matches
  no option shows empty on a required field, and the whole re-default exists to
  stop that. Do the same with Unit → Keg, which must jump to the keg volumes
  regardless of category. Then the one that actually costs time: pick a bottle
  whose real size is *not* on its list and confirm what a counter does next,
  because there is no "Other…" here on purpose (`lib/bottle-sizes.ts`). If that
  turns out to be common rather than rare, the asymmetry is the thing to revisit
  — not by adding free text, but by lengthening a list.
  While there, confirm the keg default: enrolling any keg should now preselect
  **19533 ml (sixtel)**, not the half barrel it used to open on — 7 of the 9
  seeded kegs are sixtels, and the default was moved to match (finding 2 in
  item 22, fixed 2026-07-30). If a keg enroll opens on anything else, the fix
  did not make it to the screen the phone is looking at.
- **The eaches-only quantity screen.** With the Cases stepper gone for spirits,
  the layout is one column and the ADD/SET tabs sit above a single box.
  **Confirm a SET still visibly announces a loss** — put a spirit on 12 eaches,
  switch to SET, type 3, and check the button reads `SET TO 3 EA / was 12 ea ·
  −9` before it is tapped. That live consequence line is the only guard on this
  control (CLAUDE.md is explicit that a modal here would be worse than none), and
  it now has to do its job in a layout nobody has looked at. On a bottled beer,
  do the mirror: cases 0 / eaches 12, SET 1 case / 0 eaches, and read what the
  button claims — it should now say `SET TO 1 CASE, 0 EA / was 0 cases, 12 ea`,
  naming the 12 bottles it is about to wipe rather than showing `+12` as if
  nothing were lost (item 22, finding 3, fixed 2026-07-30 but never rendered
  on a device).

Item 9's offline-queue pass covers the same screens and should be done in the
same sitting.

## 21. Case entry for spirits is deferred — DECIDED 2026-07-30

**Trigger: Phase 2.0, or never. Not a bug, and not to be re-opened as one.**

Owner's call: only bottled beer gets a case input. `QuantityEntry` and the
back-office product form both render the case field on `isCountedByCase`
(`lib/pack-level.ts`) and on nothing else. This is a scope decision in the shape
of item 12's wine deferral.

Why it went this way rather than staying a field with a hint, so a future
session does not "restore" it:

- **The old hint invited the wrong thing.** A spirit rendered a Cases stepper
  reading *"No case size on file"*. CLAUDE.md is explicit that a blank
  `case_size` on a spirit is correct rather than missing data, but a box with a
  note about what it lacks reads as a prompt to fill it.
- **The failure it invited is silent.** A case count against a NULL `case_size`
  is the single input `computeLineUnits` cannot resolve, so that line is dropped
  from valuation and reported as excluded rather than being visibly wrong. The
  count total just comes out low.
- **It is not a hard block on anything.** A spirit bought by the case is still
  countable today — as eaches, which is how the bar counts it anyway (62 spirits,
  2 liqueurs, 5 wines and 3 NA all carry NULL `case_size` deliberately).

If it is ever built, the work is not the input box. It is deciding what a case
means for a product the catalog has no pack level for, and that is a catalog
question first: a spirits case size has to be entered, per product, before an
input for it means anything. The back-office field is already gated on the live
category select, so recategorising reveals it in the same edit — that is the
mechanism a future version would extend, not replace.

**Existing case data is preserved, not cleared.** `product-edit-form.tsx`
submits `caseSize` whether or not the field is on screen, deliberately: hiding a
field must not destroy a real value in a save the person thought was about the
name. A spirit can therefore carry an invisible case size, which is inert
(nothing reads it without a case count) and is the cheaper of the two mistakes.

## 22. Three review findings from 2026-07-30 — fixed same day, unproven on a device

**Trigger: the first phone test (item 20). Re-open only if the phone test shows
one of the three not behaving as traced below — nothing since the fix has
executed any of this code.**

All three were found by a correctness review after the size/case work landed,
fixed the same day, and confirmed by a second, adversarial confirm pass tracing
real before/after values through each change. None were blockers. Recorded here
rather than left in a session log, because all three are the
plausible-and-wrong shape this project treats as its worst failure mode, and
two of them still have zero runtime evidence — no test in this repo executes a
React component, so "fixed" below means traced by hand, not observed running.

1. **FIXED — changing a product's category no longer rewrites its stored
   `size_ml`** (`components/office/product-edit-form.tsx`). Previously, when
   the old size was absent from the new category's list, `changeCategory`
   re-defaulted it — re-filing a 355 ml hard seltzer from Beer to Spirits
   silently moved it to 750. Now `changeCategory` sets `sizeMode` to
   `"other"` instead: the field flips to the free-text box already showing the
   true stored number, and `sizeMl` itself is never touched. Traced against
   Beer/355→Spirits, the mirror Spirits/750→Beer, a product already in "Other…"
   mode (the function returns before touching it), and a size valid in two
   lists at once (375 ml, both a spirits half and a wine half — stays on the
   dropdown, correctly). The unused `defaultSizeMlFor` import was dropped from
   this file; `enroll-form.tsx` deliberately keeps re-defaulting, because it is
   creating a product and has no stored value to protect.
   **Not fully closed:** a product that entered "Other…" mode never flips back
   to the dropdown even if a later category change makes its typed value a
   valid preset of the new list — cosmetic only (the correct value still saves,
   and the user can manually re-select a preset), left as-is rather than fixed.
2. **FIXED — the keg default is now the keg this bar actually taps**
   (`lib/bottle-sizes.ts`). `KEG.defaultMl` changed from 58674 (half barrel) to
   19533 (sixtel); the seed catalog is 7 sixtels, 1 quarter barrel, 1 half
   barrel. The pinned `58674` test assertion was replaced with one that reads
   `docs/catalog/products.csv`, computes the modal keg size, asserts it is a
   strict majority, and asserts the default equals it — a guard that tracks the
   catalog rather than a literal restating the constant, and the only one of
   the three fixes an executed test actually covers (16th test in
   `tests/bottle-sizes.test.ts`, up from 15).
3. **FIXED — `describeAfter` now guards eaches falling to zero, not just
   cases** (`components/count/quantity-entry.tsx`). Each axis now has its own
   zero guard — `(c > 0 || currentCases > 0)` and `(e > 0 || currentEaches > 0
   || parts.length === 0)` — so a SET that wipes either cases or eaches says
   "0 cases" / "0 ea" out loud instead of dropping the term. Traced against
   currentEaches=12→SET 1 case/0 eaches (now says "0 ea"), the mirror
   currentCases=2→SET 0 cases/5 eaches (now says "0 cases"), and both-to-zero
   (now says both). ADD-mode's label and the "was …" half of the SET line both
   still call the original `describe()`, confirmed unchanged.

Finding 3 is on the counting leg and is covered by open item 20's phone pass —
folded in there rather than repeated as separate work. Finding 1 is the
back-office product form, driven at a desk in a browser rather than on the
phone; it has not had that click-through since the fix, but it is not blocked
on item 20's trigger.

## ~~23. `scripts/create-user.ts` has the same unguarded-`main()` shape `db/seed.ts` just had~~ — **CLOSED 2026-08-12**

**Closed by `9f81967`, guarded the same way `db/seed.ts` is:
`import.meta.url === pathToFileURL(process.argv[1]).href`.** Verified by
importing the module and confirming no password prompt opens and no row is
written. Like `db/seed.ts`'s guard, this has no automated test — neither entry
point is importable from the test suite without reintroducing the exact side
effect being guarded against, which is the point.

The original entry follows, because its explanation of *why* an unguarded
`main()` is so hard to notice is the durable part:

**Trigger: the first time anything imports this script rather than running it
as a CLI — a test, a future admin action, a wrapper script.**

Noted while closing item 19 (50e2512), not fixed. `db/seed.ts` ran `main()` at
module scope until that same commit; importing it to unit-test the pure CSV
parser executed the real seed against the active `DATABASE_URL`, racing the
test suite's truncation and leaving `process.exitCode = 1` behind it — `bun
test` printed all-pass and `test:docker` still exited 1. See item 19's close
note and CLAUDE.md's migrations/seed convention for how that one was fixed:
guard `main()`, and move anything worth unit-testing out of the entry-point
module.

`scripts/create-user.ts` has the identical shape — nothing calls it except the
CLI today, but nothing stops a later import either — and its side effect is
worse than a seed race: it opens an interactive password prompt.

**How to close it:** guard `main()` the same way `db/seed.ts` now is —
`import.meta.url === pathToFileURL(process.argv[1]).href` — before anything
ever has a reason to import this file.

## ~~24. A plain `docker:up` silently reverts a live LAN session~~ — **CLOSED 2026-08-12**

**Closed by `9f81967`: `bun run docker:up` now refuses when a LAN session looks
live, and names `bun run docker:down` as the fix.**

The check reads the **running container** (`docker inspect` exposes `Env`, so
the effective `DEV_LAN_ORIGIN` and `APP_BIND` are both readable, and the `tls`
profile proxy's presence is directly observable). A gitignored state file was
designed for this and then dropped: its only failure mode is going stale, and
the guard has to reconcile against real container state regardless, so the file
was pure redundancy with a way to be wrong. See
`docs/plans/phase-1-to-1.5/02-architecture.md`, Amendment 3.

**It surfaced a separate, pre-existing bug — see item 25.** `docker:down` does
not fully tear down a LAN session, so the guard can keep refusing after what
looks like a clean teardown.

The original entry follows; its root-cause walkthrough is the durable part,
because the symptom ("the page just refreshes on submit") points nowhere near
the cause:

**Trigger: before this project is handed to anyone who doesn't already know
this by heart, or the next time an agent is told to "just try `docker:up`" as
a generic troubleshooting step while a phone is mid-session on the LAN URL.**

Confirmed 2026-07-31. The owner could not sign in on his phone over the LAN
https URL — the login page just refreshed on submit. Root cause:
`DEV_LAN_ORIGIN` was empty in the app container, so `next.config.ts`'s
`devOrigins` resolved to `["127.0.0.1"]` only. Next 16 blocks `/_next/*` for
any host outside `localhost`/`*.localhost` plus `allowedDevOrigins` — item
#17's mechanism, tripped on a new host — so every client chunk 403'd for the
phone's origin while the document itself returned a clean 200. No chunks
means no hydration, no hydration means the login form's `onSubmit` never
attached, and the browser fell back to a native form POST — which presents as
"the page refreshes," not as "JavaScript is broken."

How it got that way: the app had been brought up with plain `bun run
docker:up` instead of `bun run docker:up:lan`. `docker:down && docker:up` is
documented as the deliberate way to restore the loopback-only bind — that part
is fine. What is not written down anywhere is that an *incidental*
`docker:up` — from `docker:reset`, from a script, from an agent told to "try
`docker:up` once if the database looks down" — silently reverts a live LAN
session with no warning and no error. The container comes back up healthy.
`curl` against the LAN URL still returns 200. Nothing announces that the phone
just lost its allowlisted origin.

**This is not "we forgot to run the right command."** The fragility is that
two commands with adjacent names (`docker:up`, `docker:up:lan`) leave the
stack in observably identical states — healthy container, 200 on every
route — while one of them silently strips the one thing the phone depends on.
Anything that ever runs `docker:up` for an unrelated reason (chasing a
database connection, a reset script, a future CI step) is a footgun aimed at
whoever is mid-count on a phone at the time.

**What was actually built, 2026-07-31: detection, not prevention.**
`components/count/preflight-origin-check.tsx` reads the `Host` header
server-side and fails loudly — naming the fix — if it is not in the
allowlist; it is placed first in `/count/preflight`, ahead of the camera and
decoder checks, so it is checked before anything else is trusted. A hydration
beacon was added alongside it (`components/count/preflight.tsx`) so a
blocked-chunks failure shows red instead of silently rendering. Both catch
the symptom fast, on the device, before anyone starts counting — but **neither
stops the revert from happening.** `docs/phone-count-test.md`'s triage table
now also carries the symptom → cause → fix entry for this specific failure,
plus a note that the phone can have cached the broken, non-hydrating page and
a plain reload won't show the fix.

**What would actually fix it, not just catch it faster:**
- Make the LAN state sticky — persist `DEV_LAN_ORIGIN` (and the TLS profile
  choice) somewhere `docker:up` reads and preserves by default, so leaving LAN
  mode requires saying so, rather than being the silent side effect of any
  bare `up`.
- Or have `docker:up` itself detect that a LAN session is live (the cert
  exists, the `tls` compose profile is running, `DEV_LAN_ORIGIN` was
  previously set) and refuse or warn before tearing it down — the way a
  destructive migration would ask first.

Neither is built. The preflight row is the cheap fix that ships today; the
sticky-state fix is the one that would have prevented the incident rather
than shortened it.

This is also the fifth instance of the pattern item #18 named: the server was
fine and returned 200 (`curl https://192.168.12.33:3443/login`, the whole
time it was broken) while the app was completely unusable on the device it
was built for. See `STATE.md`'s "every gate stayed green" paragraph.

## ~~25. `docker:down` does not stop the TLS proxy, so a LAN session never fully ends~~ — **CLOSED 2026-08-12**

**Closed by making both teardowns profile-aware:** `docker:down` is now
`docker compose --profile tls down`, and `docker:reset`'s leading `down -v`
likewise. Compose accepts `--profile` on `down` (verified on v2.23.0).

**Verified by reproducing it, both directions**, rather than by reading the
flag's documentation. `docker compose --profile tls create tls` (create, not
up, so no port is bound), then plain `docker compose down` — `truestock-tls`
survives, which is the bug. Then `docker compose --profile tls down` — removed.

Nothing else needed changing: `dev-lan.sh`, `prod-lan.sh`, `README.md`,
`docs/phone-count-test.md` and item 24's guard message all already document the
teardown as `bun run docker:down && bun run docker:up`. That instruction was
simply not true before, and now is.

The finding, for the record:

Found 2026-08-12 while proving item 24's new `docker:up` guard, on Docker
Compose v2.23.0.

`bun run docker:up:lan` / `docker:up:prod` start the TLS proxy through
`--profile tls`. `bun run docker:down` is a plain `docker compose down` with no
profile flag, and **Compose will not stop a container belonging to a profile it
was not told about.** Reproduced twice: after `bun run docker:down`,
`docker ps -a` still shows `truestock-tls  Up`, and Compose prints its own tell
— `Network truestock_default  Removing / Resource is still in use`.

The consequence is a confusing loop rather than a broken app: item 24's guard
sees the `tls` container still running, correctly concludes a LAN session is
live, and refuses `docker:up` — right after the user ran the exact command the
guard told them to run. Clearing it today needs `docker compose --profile tls
down`.

**How to close it:** make `docker:down` profile-aware —
`docker compose --profile tls down` — so one teardown command actually tears
everything down. Worth checking `dev-lan.sh` and `prod-lan.sh` for the same
assumption while in there.

This is a documentation-versus-reality gap as much as a script bug: the
teardown sequence is documented in several places as `docker:down &&
docker:up`, and that sequence has never fully worked for a LAN session.

## ~~26. The preflight origin banner cries wolf on plain `localhost`~~ — **CLOSED 2026-08-12**

**Closed by fixing the predicate, not by moving the check client-side.**
`lib/dev-origins.ts` gained `isDevOriginAllowed(hostname)`, which knows what
`parseDevOriginHosts()` cannot: Next allows `localhost` and `*.localhost` on its
own, and no configuration file expresses that. `PreflightOriginCheck` now calls
it instead of testing membership in the configured list.

**The close note in this item originally proposed having the banner confirm a
real `/_next/*` fetch. That idea was wrong and was dropped.** The component's
own docblock already explains why: in the failure case being detected, no client
JavaScript runs at all, so there is nothing left to do the observing. The
verdict has to be derivable on the server. Strictly more accurate and strictly
useless.

Covered by `tests/dev-origins.test.ts` — 10 pure tests, no database, no browser
— and **mutation-checked**: deleting the `localhost` allowance makes exactly two
of them fail (`localhost is allowed…` and `a .localhost subdomain is allowed…`)
and leaves the other eight green. `notlocalhost` is asserted NOT to match, since
a `.endsWith("localhost")` implementation would wrongly allow it. There is also
a browser check in `verify:browser` asserting the rendered banner reads *Yes*
and does not contain "no JavaScript runs", because what a human reads is the
thing that was wrong.

The finding, for the record:

Found 2026-08-12 in a real browser on `http://localhost:3000/login`, brought up
with a plain `bun run docker:up`.

`components/count/preflight-origin-check.tsx` renders **"Origin allowed: NO"**
and states that "client chunks return 403 — so no JavaScript runs. The form
appears but never responds to taps." All of that was false at the time it was
displayed: React had demonstrably attached (`__reactFiber$` on the form), HMR
was connected, and the page was fully interactive. The banner's premise —
`localhost:3000` not being in `allowedDevOrigins` — does not imply blocked
chunks, because Next permits same-origin `/_next/*` requests regardless;
`allowedDevOrigins` governs *cross*-origin dev requests, which is what item 17
and item 24 were actually about.

So the check is right about the config value and wrong about the consequence,
in the one configuration a developer hits most often.

**How to close it:** make the banner's verdict depend on the *observed*
outcome rather than the config value — it already runs client-side, so it can
simply confirm a `/_next/*` fetch succeeds — and treat `localhost` and
`127.0.0.1` as allowed by construction. The LAN case it was built for (item 24)
is the one where the warning is real and must stay.

## ~~27. `/office/vendors` still has the row-click edit affordance that was just removed from locations~~ — **CLOSED 2026-08-12**

**Closed the same day it was filed, with the same three changes as `957bfeb`:**
an explicit `Edit` button in a new Actions column, the `<tr>`'s `onClick` and
`cursor-pointer` removed, and `vendor-edit-form.tsx`'s heading changed to
`Edit ${vendor.name}` so the form names its subject.

**Both halves are now covered by `bun run verify:browser`** — the vendor edit
form must be editing the row whose Edit was clicked, and its heading must
contain that vendor's name. Neither check could have passed before the fix:
there was no button to click, and the heading was the constant `"Edit vendor"`.
The suite went 28 → 30 checks. When no vendor exists — the default state of the
dev database — both are reported SKIPPED rather than passing vacuously.

The finding, for the record:

Found 2026-08-12 while fixing the locations screen (`957bfeb`). All three legs
of that finding are still present here:

- `components/office/vendors-list.tsx:148-149` — the `<tr>` carries
  `onClick={() => handleEditClick(vendor.id)}` plus
  `cursor-pointer hover:bg-muted`, with no `role`, no `tabIndex` and no visible
  Edit control. Keyboard and screen-reader users cannot edit a vendor at all.
- `components/office/vendor-edit-form.tsx:99` — the heading is the generic
  `"Edit vendor"` and never names the vendor being edited.

Why it matters even though a vendor is less dangerous than a location: on the
locations screen this combination put a click on **Speed Rail** when another row
was aimed at, one confirm away from renaming a real location and flipping its
`count_mode`. The mechanism is the row reflowing as the inline form opens, and
it is identical here. A mis-renamed vendor is quieter — it silently regroups the
reorder list, which nobody notices until an order goes to the wrong rep.

**How to close it:** the same three changes `957bfeb` made — an explicit `Edit`
`<Button variant="outline" size="tap">` in the actions cell, the `<tr>`'s
`onClick` and `cursor-pointer` removed so the hazard is gone by construction,
and the vendor's name in the form heading so the form states its own subject.
`components/office/locations-table.tsx` is now the reference implementation.

`users-list.tsx` and `catalog-table.tsx` were checked and do **not** have this
pattern — both use explicit controls.

---

## 28. The `--chart-2..5` series palette is owed, not chosen

**Trigger: the first chart drawn — Phase 4. Not before, and drawing one before
filling these in is the failure this item exists to prevent.**

Opened 2026-08-14 at the close of Phase 2. `--chart-1` is real (the brand blue,
already contrast-computed, no collision with any status token). `--chart-2`
through `--chart-5` are **deliberately empty** in both themes:

```css
--chart-2: /* owed */ ;
```

Empty rather than a placeholder hex, on purpose — an accidental consumer breaks
visibly instead of silently rendering a looks-fine-but-wrong colour. That choice
is the whole point, so do not "tidy" these into provisional values.

**What they used to be is the reason this is an item at all.** They were
byte-identical to `--success` / `--warning` / `--negative`. A categorical series
in those hues puts a green wedge and a red wedge on a stock dashboard where
green and red already carry meaning — a chart that reads as a health signal
while actually encoding nothing but series order. That is a plausible-but-wrong
default in a place nobody would think to check, which is the class of defect
`AGENTS.md` opens with.

**How to close it**, per `docs/design-system.md` §2 and
`docs/plans/phase-2-ui-redesign/ui-spec-web.md` §8 — all four conditions, not a
subset:

1. WCAG relative-luminance contrast computed (not eyeballed) against **both**
   `--background` and `--card`, in **both** themes.
2. A colour-vision-deficiency simulator pass over the full series together, not
   swatch by swatch.
3. No hue that reads as adjacent to `--success`, `--warning` or `--negative`.
4. Values written into `app/globals.css` in both the `:root` and `.dark` blocks,
   then `prototypes/tokens.css` regenerated via
   `prototypes/generate-tokens.mjs` so the prototypes cannot drift from the app
   again (the audit's P2.7 finding).

Phase 2 satisfied Gate 1 by marking these owed and drawing **no chart at all** —
`library-comparison.md` names visx for Phase 4, against a catalog that by then
should actually have costs, pars and vendors in it. A chart built today against
9-of-99-costed data and 0 par rows would render empty and prove nothing.

**The check that this is still safe:** `grep -rn "chart-[2-5]" app components`
should return hits in `app/globals.css` — the two token blocks and their `@theme`
aliases — plus exactly one line of `components/ui/meter.tsx`, a comment
explaining why the meter does not reach for these. Anything else is a component
consuming an empty custom property. Verified 2026-08-14.

---

## 29. The accessibility floor is asserted on one screen out of about a dozen

**Trigger: the next time any office screen is opened for another reason — and
before Phase 3 go-live for the counting screens.**

Opened 2026-08-14 at the close of Phase 2, as the honest half of a Gate 1
criterion that read "every screen, checked in a real browser".
`scripts/verify-browser.mjs` has three real assertions for this —
`assertFocusVisible`, `assertNoHeadingSkips`, and the icon-button-accessible-name
check — and each is invoked exactly once, for `/office/catalog`. The other office
routes were opened in a browser and looked at; they were not walked for tab
stops, heading order, or unlabelled icon controls. `/count` is driven only far
enough to confirm it loads.

**Why this is worth an item rather than a shrug.** The one screen that was walked
is the screen where a bare `focus:outline-none` was found — and it was found only
after the harness itself was fixed, because `assertFocusVisible` had been
resuming its tab walk from wherever the previous assertion's click left focus,
deep inside the table, and reported "25 tab stops, none bare" having never
visited the bare control sitting above its starting point. The evidence says:
run this check on a screen and it finds something. It has been run on one screen.

**How to close it:** `assertFocusVisible(path, mustReach)` already takes a path
and a must-reach pattern, so extending it over `/office`, `/office/counts`,
`/office/vendors`, `/office/locations`, `/office/users` and `/office/reorder` is
a loop, not new machinery. Always pass `mustReach` — a coverage count with no
named element is the exact shape of the false pass above. The counting screens
need a phone and belong with item #20.

---

## 30. Three of seven table surfaces never moved onto the shared primitives

**Trigger: the next time `vendors-list.tsx`, `locations-table.tsx` or
`users-list.tsx` is opened for any reason. Not worth a dedicated pass.**

Opened 2026-08-14 at the close of Phase 2. `catalog-table.tsx`,
`reorder-vendor-block.tsx` and both `counts` pages use `components/ui/table.tsx`;
the other three still hand-roll `<table>`. Concretely:

- **`users-list.tsx` has no `scope="col"` on any header and no `<caption>`** —
  0 and 0. This is the one with real consequence: a screen reader gets no column
  association at all on the user-management table.
- `vendors-list.tsx` and `locations-table.tsx` have `scope="col"` (5 each) but no
  caption.
- `vendors-list.tsx:166,169,172` renders three ad-hoc `"—"` strings for null
  contact, order method and lead time instead of `<NullValue>`. That is the same
  null-value drift removed from counts-list in `dd9fda4`, surviving on a screen
  that commit did not touch — and the distinction `NullValue` exists to carry is
  real here: a vendor with no lead time recorded is `not-entered`, not
  `not-applicable`.

None of this is a hazard, and none of it is a data-correctness risk — it is a
migration that reached four of seven surfaces. Recorded so it is not mistaken for
a decision. The whole-row-click hazard, which *was* a hazard, is gone everywhere:
no `<tr>` in the codebase carries an `onClick` (item #27, closed 2026-08-12).
