# MVP Phase 1 — what does not work

A code audit of what is missing or broken in Phase 1 scope, 2026-07-29, at
commit `68d0f15`. Read alongside `STATE.md`, which covers what is *unproven*;
this file covers what is **absent or wrong in the code as written**, which is a
different list.

**Status 2026-07-31: A, B, C, D1, D2, E, F, G, H and I are fixed.** J is still
open and keeps its section below. Each fixed section keeps its original
text — the reasoning is why the fix looks as it does — with a **FIXED** note
saying what changed. Nothing is deleted, because the failure *shapes* here are
the reusable part.

Verified after the fixes:

| Check | Result |
|---|---|
| `bun run typecheck` | passes |
| `bun run lint` | passes (was 1 error — finding F) |
| `bun run build` | passes, 16 routes |
| `bun run test:docker` | **94 tests / 381 assertions**, 0 fail, across 7 files, against MariaDB 11.8 |

The suite was checked for teeth rather than assumed to have them: breaking
`upsertProductPar` fails exactly the 8 par/reorder tests, and widening
`isCountWritable` to accept `submitted` fails exactly the 3 write-refusal
tests, with every unrelated test still green.

Nothing here was taken from the docs. Every finding below is a claim about a
specific file, and the reasoning states how to check it.

Severity is against one question: **can the first real count at a real bar
produce a trustworthy number?**

---

## A. The reorder list can never produce a single row

**Blocker. Not previously recorded anywhere.**

**FIXED 2026-07-30.** `parLevel`/`reorderPoint` are on `productUpdateSchema`,
`upsertProductPar` writes the `location_id IS NULL` row (and a null par level
deletes it), the product form has a Reordering section, and `needs_par` is
attached in `attachStock` so the catalog says which products still have none.
`reorderList` now also returns `productsWithPar`, because "nothing is short"
and "no par exists anywhere" produced an identical empty array and the screens
said the reassuring thing about both. Covered by 13 tests.

Open question 2 (par per product or per location) is deliberately still open —
the MVP writes overall rows only, which is what keeps it open.

`product_par` is read in two places and **written in none.**

- `lib/domain/reports.ts:339` and `lib/domain/catalog.ts:246` select from it.
- No server action writes it. `productCreateSchema` and `productUpdateSchema`
  (`lib/validation/catalog.ts`) have no `parLevel` or `reorderPoint` field at
  all, so `updateProduct` could not persist one even if a form sent it.
- `db/seed.ts`'s own header says it "Does NOT seed: User, **Vendor,
  ProductPar**, ProductBarcode" — deliberately, because the source columns are
  blank.

So `reorderList` returns at `lib/domain/reports.ts:349`:

```ts
if (parRows.length === 0) {
  return { asOfCountId, items: [] };
}
```

That branch is unconditional in practice. The consequences run the whole way
out to the UI, and every one of them is silent:

- `/office/reorder` renders **"Nothing is below its reorder point"** — which
  reads as good news. The truth is that no par level exists and nothing in the
  app can create one.
- The dashboard's *Reorder pressure* tile reads "0 products at or below par".
- The catalog table's stock bar (`components/office/catalog-table.tsx:188`)
  is gated on `stock.parLevel && stock.parLevel > 0`, so it never draws.
- `incompleteReasons` (`lib/domain/catalog.ts:92`) knows only
  `needs_producer | needs_cost | needs_case_size`. There is no `needs_par`, so
  *Catalog health* — the tile whose whole job is flagging catalog decay — is
  also silent about it.

The reorder list is named in Phase 1 scope in CLAUDE.md, `ROADMAP.md` and
`docs/spec.md` §9.3. As built it is a screen that always says everything is
fine.

**What it needs:** `parLevel`/`reorderPoint` on `productUpdateSchema`, an
`upsertProductPar` domain function writing `location_id IS NULL` rows (the MVP
convention, per spec §8 and the `product_par` generated column that enforces one
overall par), a field in `components/office/product-edit-form.tsx`, and a
`needs_par` reason so the catalog says which products still have none.

Worth settling at the same time: **open question 2 in CLAUDE.md** — par per
product or per location — is still open. `ProductPar.location_id` is nullable
precisely so this could be deferred, and writing null rows keeps it deferred.

---

## B. Scan-to-enroll dead-ends on every product already in the catalog

**Blocker for the first count. Logged as open-item #16, but that entry
describes the wrong failure.**

**FIXED 2026-07-30.** `linkBarcodeToProduct` inserts a `product_barcode` row
against an existing product after an ownership check on the product id
(invariant 9), and `EnrollForm` now **opens on search** rather than on the
new-product form — during the first count "already in the catalog, just never
scanned" is the common case and creating is the rare one. The name-collision
error also now offers a way through to the link screen instead of dead-ending.

`pack_level` was the real question and is answered without a universal extra
tap: `each` by default, with an each/case choice shown only for products
counted both ways (`isCountedByCase`, lib/pack-level.ts — the same predicate
`incompleteReasons` uses, shared rather than duplicated). `isPrimary` is
derived server-side, never taken from the client.

All 97 seeded products ship with no barcode, so during the first count *every*
scan is unresolved and routes to `EnrollForm` (`count-leg.tsx:270`). The
counter types the product's real name — "Tito's Handmade Vodka", 750ml — and
`createProduct` hits `product_name_size_ml_unique`
(`lib/domain/catalog.ts:447`):

```
A product named "Tito's Handmade Vodka" at 750ml already exists.
```

`EnrollForm` renders that string and offers **no way forward** — no "link this
barcode to the existing product", because no action exists to insert a
`product_barcode` row against a product that already exists. The only escape is
to cancel, or to invent a name the catalog does not already have.

Open-item #16 and `STATE.md` both say this "produces a second copy of all 97
products". That is the *second-worst* case and only happens if the counter
types a differing name. Type the catalog's own name — the natural thing to do —
and it is a hard stop, mid-count, on the interaction CLAUDE.md calls the
highest-risk in the MVP and holds to a 20-second budget.

**What it needs** (from #16, still accurate): a "link to an existing product"
branch beside "new product", backed by an action that ownership-checks the
product id before inserting the barcode (invariant 9 — a foreign key proves the
row exists, not whose it is). The real design question is `pack_level`, not the
plumbing: a bottle and its case carry different codes, and guessing wrong
silently miscounts beer.

---

## C. An open-bottle fill reading cannot be corrected. At all.

**High.**

**FIXED 2026-07-30**, with one half deliberately left open. `FillEntry` has a
correction mode reached from "Correct these": it seeds a draft from the
existing readings, chips remove them, the pad adds them back, and the button
states the consequence live (`was 2.3 · −0.8 units`) in the same way the
quantity SET does. It writes through the queue as a new `fills` write kind, so
a correction made with the WiFi down survives.

`clientLineId` is now required by `editCountLineFillsSchema` — the queue needs
an id to store the write under, and requiring it now means closing the ledger
gap is a change to the domain function alone rather than to this boundary and
every caller.

**Still open: the ledger entry (open item 2).** That was a deliberate call:
a replace is naturally idempotent, so this is an audit-trail gap rather than a
correctness one, and inventing a delta convention for replaces silently would
change what the audit export means.

`editCountLineFillsAction` has **zero callers** — verified by grepping every
`.ts`/`.tsx` outside `app/actions/`. It is the only path that can rewrite
`partial_fills`, and nothing invokes it.

`FillEntry` is append-only by construction. Each tap pushes onto a local array;
submit calls `runWrite("increment", { newPartialFills })`, which appends
server-side. Once submitted, the reading is permanent. Tap **80%** when you
meant **30%** and the line carries an extra 0.5 units forever.

Sealed quantities have an answer for exactly this — `SET`, wired through
`setCountLineQuantitiesAction` with a live before/after on the button. Open
bottles have nothing. This is the asymmetric half of the count: sealed
backstock is a number anyone can re-derive by looking at the shelf; a fill
level is a judgement call recorded once.

`FillEntry`'s own doc comment claims the opposite:

> `partial_fills` is an array of individual observations (`[0.3, 0.8]`), never
> a rolled-up total — **so one bottle can later be corrected without recounting
> the shelf.**

The schema supports that. No code does it.

Two further defects in the same path, which matter the moment it *is* wired up:

- **`editCountLineFillsSchema` has no `clientLineId`** (`lib/validation/counts.ts:107`)
  — despite that file's own header saying a fresh UUID is required for "every
  scan, every typed quantity submission, **every fill correction**, every
  absolute-set correction". The correction path is not idempotent.
- **It writes no `count_line_write` ledger entry** (open-item #2). Every other
  write to `count_line` does. "Who changed this bottle's fill level, and when"
  is unrecoverable.

Open-item #2 files the ledger gap under the deferred compliance packet, which
is right on its own terms. It is a different matter once the correction is the
only way to fix a mistyped fill during a live count.

---

## D. A rejected write stays on screen as counted, and jams the queue forever

**High. Two distinct defects in `count-leg.tsx`'s `runWrite`, neither recorded.**

**FIXED 2026-07-30, both halves.**

**D1** — `runWrite` captures the affected line's prior value on the way past
(inside the state updater, so it is exact rather than a render behind) and
restores it when the server refuses, deleting the row if it did not exist
before. One line rather than the whole map: a blanket snapshot would also
revert anything that landed in between. Nothing can today, because `busy`
serializes writes, but a rollback that silently depends on that gate is a trap
for whoever removes it.

**D2** — a server *rejection* now `dequeue`s instead of `markAttempt`ing. The
server has already decided, so a replay gets the same answer; keeping it made
`pendingFor` return it forever and pinned the chip at "1 pending", which is
exactly the signal spec §11 wants trustworthy. Dropping it silently would be
its own bug, so `QueuedWrite` gained a `label` and the error names the write
("Tito's Handmade Vodka · Back Bar was refused… Re-count that one to be sure").

**D1 — the optimistic row is never rolled back.** `setLines(optimistic)` runs at
line 184, before the network call. On failure (line 244) the handler calls
`markAttempt` and `setError` and *leaves the optimistic line in place*. So a
write the server refused still shows in "Just counted" with its units included.
Worse, subsequent increments to the same product compound onto the phantom,
because `applyIncrement` reads the local row as its base.

This is the precise failure mode the whole codebase is written against: the
screen says the bottle is counted, the database disagrees, and nothing looks
broken.

**D2 — permanently-failed writes never leave the queue.** `sendQueued`
distinguishes a network failure from a server rejection, and for a rejection
does:

```ts
await markAttempt(write.id, result.error.message);
return true;   // "reachable" — keep draining
```

`markAttempt` (`lib/count-queue.ts:110`) increments `attempts` and **keeps the
record**. Only `dequeue` removes one, and it is called only on success. So:

- `pendingFor` returns that write forever.
- `flush()` runs on every mount and every `online` event, resends it, gets the
  same rejection, and re-marks it.
- `SyncIndicator` reads `pendingWrites > 0` and shows **"1 pending"**
  permanently. It never returns to "Synced".

There is no attempt cap, no dead-letter state, and no UI to inspect or clear a
failed write. The sync badge is the app's only connectivity signal — spec §11
argues for it on the grounds that "a dropped access point should be visible
rather than silent" — and one validation failure makes it permanently
untrustworthy. After that, a genuinely lost write in the walk-in is
indistinguishable from the stuck one.

Open-item #9 records that the queue has never been exercised in a browser.
These two are separate: they are readable in the source without running
anything.

---

## E. A submitted or reviewed count still accepts writes

**Medium. Possibly deliberate, but nothing says so, and the UI implies otherwise.**

**FIXED 2026-07-30 — decided the first way: submission freezes writes.**
`assertCountWritable` refuses anything `isCountWritable` rejects, the scan page
redirects on `submitted`/`reviewed` as well as `closed`, and the Resume/Continue
buttons become Review. The predicate lives in `lib/count-status.ts` because the
disagreement between four layers *was* the finding.

The freeze needed an escape hatch to be safe, so **`reopenCount` was added**
(submitted|reviewed → in_progress, owner/manager). Without it a mis-tapped
Submit with sections still uncounted would be unrecoverable: the count takes no
more lines and the only forward move is a close that invariant 1 makes
permanent. `closed` is not in its `from` list and never should be.

`assertCountWritable` (`lib/domain/counts.ts:172`) rejects one status:

```ts
if (row.status === "closed") throw new ClosedCountError();
```

The scan page mirrors it — `app/(count)/count/[countId]/scan/page.tsx` redirects
only when `status === "closed"`. So `submitted` and `reviewed` counts remain
fully writable.

Invariant 1 covers `closed` only, so this is a defensible reading. What makes it
a finding is the disagreement between layers:

- `SessionActions` removes "Keep counting" once a count is submitted, so the UI
  presents submission as a freeze.
- `/count/<id>/scan` typed directly still opens the leg, and every write lands.
- `getActiveCount` filters on `ne(count.status, "closed")`, so a submitted count
  still surfaces as the count in flight on both the dashboard and `/count`, with
  a **Resume** button.

A reviewer who marks a count reviewed while someone is still scanning gets a
count whose reviewed state describes numbers that changed afterwards. Either
`assertCountWritable` should reject `submitted`/`reviewed`, or the decision to
allow late writes should be written down.

---

## F. `bun run lint` fails — CI is red on this commit

**Medium, and cheap.**

**FIXED 2026-07-30.** Disabled with the reason at `login-form.tsx:20`, as this
section recommended, rather than rewritten — whether React has attached is not
derivable during render, so the effect *is* the signal. `bun run lint` passes.

```
components/login-form.tsx
  20:19  error  react-hooks/set-state-in-effect
         Avoid calling setState() directly within an effect
```

`.github/workflows/ci.yml` runs `bun run lint` between typecheck and test, so
the gate fails before the DB-backed suite ever starts. Typecheck and build both
pass; lint is the only red.

The same rule fires on `count-leg.tsx:157`, where it carries a deliberate
`eslint-disable-next-line` and a comment justifying it as external-system
synchronization. `login-form.tsx:20` is the hydration flag —
`useEffect(() => setHydrated(true), [])` — which is the standard has-hydrated
idiom and genuinely is a render-phase concern the rule cannot see. It needs the
same treatment: a disable with the reason, not a rewrite.

---

## G. The scanner's secure-context error sends people to a fix that does nothing

**Low severity, high nuisance — it is the first thing the phone test hits.**

**FIXED 2026-07-30.** The message now names the working URL, built from the
current host (`https://<host>:3443<path>`), explains the self-signed warning is
about identity rather than encryption, and points at `/count/preflight`. The
chrome://flags suggestion is gone, with a comment recording that it silently
did nothing twice because the handset was not Chromium.

`components/count/barcode-scanner.tsx:56` tells the user:

> …or, for LAN testing, allow this origin in
> `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

`STATE.md` records (2026-07-29) that this flag "had silently done nothing
twice, because the handset's preflight showed no native `BarcodeDetector`,
which means the browser is not Chromium" — and that it was replaced by the
nginx TLS proxy on **:3443**. The message should name the https URL and point
at `/count/preflight`. As written it costs an hour to whoever reads it.

---

## H. No write path for vendors, users, or (in-app) locations

**Medium. Partly deliberate; the vendor half is not.**

**FIXED 2026-07-31 — the vendor half.** `createVendor`, `updateVendor` and
`assignVendorToProducts` (50e2512), plus the `/office/vendors` screen and bulk
catalog assignment that make them reachable (87a8d63), give vendors a write
path end to end. `listVendorsAction` now returns real rows, the product form's
vendor `<select>` populates, and `/office/reorder` groups by vendor instead of
dumping every row under "No vendor set". Closed as open item #19 — see that
entry for the domain-layer test count (12 DB-backed tests, mutation-checked),
the four screen defects found and fixed the same week, and the one thing left
unverified: the final `router.refresh()` fix in
`components/office/vendors-list.tsx`, typechecked and built but not confirmed
in a browser before the session that wrote it ended.

The users half (open item #3) and the locations half stay exactly as
described below — neither has moved.

**Vendors — nothing writes them anywhere.** Not a server action, not the seed
(`db/seed.ts` header: "Does NOT seed: User, **Vendor**…"). `listVendorsAction`
therefore always returns `[]`. Three consequences, all silent:

- The vendor `<select>` in `product-edit-form.tsx` is permanently empty.
- Every product's `vendor_id` stays NULL forever.
- `reorderList` groups by vendor per spec §9.3, and `/office/reorder` renders
  every group under **"No vendor set"** — the grouping is structurally dead
  even after finding A is fixed.

**Users — a CLI script only.** `scripts/create-user.ts` creates accounts; no
action changes a role or deactivates anyone (open-item #3). Note the constraint
recorded there: deactivating must revoke `session` rows in the same transaction
as flipping `active`, or a deactivated user keeps working for up to 12 hours.

**Locations — seed-only, but recoverable.** `lib/domain/catalog.ts:590` states
this as a decision: "read-only list (no CRUD surface in the MVP build list)".
The seed *does* refresh `sortOrder`, `countMode` and `notes` on re-run
(`db/seed.ts:195`), so editing `docs/catalog/locations.csv` and re-seeding is a
real path — no DB surgery needed. Lower severity than it first looks, but worth
knowing before open-item #11 gets answered: **Walk-In's `count_mode` is the
inferred one**, and if open kegs live in there it needs `tenths`, which today
means editing a CSV rather than tapping a setting.

---

## I. Two forms are missing `method="post"`

**Low.**

**FIXED 2026-07-30.** Added to `enroll-form.tsx` and `product-edit-form.tsx`.
`catalog-table.tsx`'s search box stays GET, which this section already called
the honest verb for it.

CLAUDE.md's working agreement, written after the login form serialized a
plaintext password into the query string:

> **Any form whose submit is handled in JavaScript carries `method="post"`.**

- `components/login-form.tsx:65` — has it. Correct.
- `components/count/enroll-form.tsx:94` — missing.
- `components/office/product-edit-form.tsx:82` — missing.
- `components/office/catalog-table.tsx:56` — missing, but this one is a search
  box that navigates. GET is the honest verb; leave it.

Materially milder than the login case: neither form's inputs carry `name`
attributes, so a pre-hydration submit navigates without serializing anything.
It is still off-agreement, and the agreement exists because the reasoning is
easy to re-lose.

---

## J. `scanCountLine` is dead code — confirmed

**Informational. Open-item #10, already logged with a decision trigger.**

Confirmed by inspection rather than assumed: `runWrite` is called in exactly
three places (`count-leg.tsx:365`, `:398`, `:407`) and never with `"scan"`.
The `"scan"` branches in both `runWrite` and `sendQueued` are unreachable, and
a `QueuedWrite` of kind `"scan"` can never be enqueued.

The import of `scanCountLineAction` in `count-leg.tsx` is what makes a
callers-grep look satisfied. It is used in a branch nothing selects.

#10's guidance stands: decide it against a timed count, and if the answer is
no, delete the action rather than leaving a hardened write path nothing
exercises.

---

## K. `isDuplicateKeyError` never fired for a wrapped error

**Found 2026-07-30 while testing finding B. Not in the original audit — no
amount of reading would have shown it, which is the point.**

`lib/domain/db-errors.ts` read `err.code` directly. Drizzle wraps query
failures in `DrizzleQueryError`, which carries `query`, `params` and `cause`
and **no `code` of its own**, so the check returned false for every wrapped
error and both predicates in that file silently stopped discriminating.

What it cost: every `ConflictError` in `lib/domain/catalog.ts` was unreachable.
"A product named X already exists" and "Barcode Y is already assigned to Z"
fell through to the generic handler and arrived as *"Something went wrong"* —
mid-count, on the app's highest-risk interaction, with the entire actionable
half of the message discarded.

Why it survived: the paths that *had* coverage happened to receive unwrapped
errors, so the replay-rollback tests passed and the mechanism looked proven. A
mocked error object would have kept passing forever, because the shape that
broke it came from the library, not from us.

**Fixed** by walking the `cause` chain (bounded, so a self-referential cause
cannot spin), matching on `errno` as well as `code`, and testing both
predicates directly against the real `DrizzleQueryError` class —
`tests/db-errors.test.ts`.

The reusable lesson: this is the third failure in this project whose defining
feature is that **every gate stayed green** — after the static CSP (#13) and
the dev cross-origin 403 (#17). All three were invisible to status codes and to
the tests that existed, and each was found only by exercising the real thing.

---

## Still open

**J — `scanCountLine` is dead code.** Untouched, and still correct to leave
until someone times a real count (open item 10). Note it now has one more
unreachable sibling: `QueuedWriteKind` gained `"fills"`, which IS reachable, so
`"scan"` is the only dead branch left in `runWrite`/`sendQueued`.

**H is closed 2026-07-31** — see finding H above and open item #19. The vendor
half was the one that mattered; users (item #3) and locations stay as they
were.

---

## What is still unproven

Fixing these closed the *code* gaps. It did not close `STATE.md`'s question,
and the distinction is the whole reason these are two files:

- **The counting screens have still never run on a phone.** Everything in B, C
  and D is UI on the count leg, verified by domain tests and a browser
  hydration check — not by anyone scanning a bottle.
- **The offline queue is still unexercised in a browser** (open item 9). D2
  changed its rejection behaviour, which makes that test more worth doing, not
  less.
- **The reorder list has never rendered a real row**, because no product has a
  real par yet and costs are still unentered (open item 4).

---

## Suggested order — original, kept for the record

This was the ordering the audit proposed. 1-6 and 7 are done; what remains is
J, which is why it sits at the bottom of it.

Ordered by what blocks the first trustworthy count, not by effort.

1. **B** — otherwise the first count cannot be completed at all.
2. **D1** — a phantom counted line is the worst failure this app has.
3. **C** — the open-bottle half of the count has no undo.
4. **A** — one of Phase 1's named deliverables returns nothing.
5. **F** — CI is red; minutes.
6. **G** — before the phone test, not after.
7. **D2, E, H, I** — real, and none of them block a count.
8. **J** — decide, then wire or delete.

**A, C and H(vendors) are the three that make a finished-looking screen report
a confident wrong answer**, which is the failure mode CLAUDE.md's invariants
exist to prevent. None of them error, and none of them are visible from a
status code.
