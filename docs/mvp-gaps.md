# MVP Phase 1 — what does not work

A code audit of what is missing or broken in Phase 1 scope, 2026-07-29, at
commit `68d0f15`. Read alongside `STATE.md`, which covers what is *unproven*;
this file covers what is **absent or wrong in the code as written**, which is a
different list.

Verified this pass:

| Check | Result |
|---|---|
| `bun run typecheck` | passes |
| `bun run build` | passes, 16 routes |
| `bun run lint` | **fails** — 1 error (see F) |
| `bun run test` | not run: no Docker in this environment, suite needs a real MariaDB |

Nothing here was taken from the docs. Every finding below is a claim about a
specific file, and the reasoning states how to check it.

Severity is against one question: **can the first real count at a real bar
produce a trustworthy number?**

---

## A. The reorder list can never produce a single row

**Blocker. Not previously recorded anywhere.**

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

## Suggested order

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
