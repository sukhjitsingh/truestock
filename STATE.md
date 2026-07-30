# Truestock — current state

Where the project actually is. Updated 2026-07-30.

This file answers one question: **what is proven, what is merely built, and what
is next.** The distinction matters more here than the feature list, because this
project has twice shipped something that looked finished and was not.

- `ROADMAP.md` — what comes after this
- `docs/open-items.md` — every deliberate gap, with the trigger that makes it due
- `docs/go-live.md` — the gate before the first deploy, and what to verify after
- `CLAUDE.md` — invariants and conventions
- `docs/spec.md` — scope, data model, rationale

---

## One-line status

**MVP is built and not deployed.** The database and domain layers are verified
against a real MariaDB; the back office has been driven in a browser; **the
counting app — the actual product — has never been used by a human.**

As of 2026-07-30 the Phase 1 *code* gaps are closed (`docs/mvp-gaps.md`): the
reorder list can produce a row, a scanned barcode can attach to an existing
product, a fill reading can be corrected, a refused write no longer leaves a
phantom line, and a submitted count no longer accepts writes. That changes what
is **built**. It does not change the line above, which is the one that matters.

---

## What is verified

Verified means *observed running*, not reviewed or typechecked.

| Area | Evidence |
|---|---|
| **Schema + migrations** | Chain `0000 → 0001 → 0002` applied to MariaDB 11.8 in Docker. Composite tenant FKs reject cross-tenant ids (1452), `product_par` blocks a second overall par (1062), `DECIMAL(10,4)` exact, accented names round-trip |
| **Auth path** | Better Auth under `generateId: "serial"` returns integer ids; sign-in returns a session; the inactive-user re-read gate refuses a *still-valid* session — **with a negative control** |
| **Count write path** | `tests/count-write-path.test.ts` against real MariaDB, wired into CI as a service container |
| **Invariants 1, 2, 3, 8, 9** | Covered by that suite: closed counts refuse writes, cost snapshots survive a price change, three scans make one row, a manager never receives cost fields, cross-tenant ids are refused |
| **Idempotency** | Same `clientLineId` twice increments once; a differing replay leaves the line untouched |
| **Par writes + reorder list** | `tests/catalog-write-path.test.ts` — an overall par is written, updated in place, cleared by null, scoped to the tenant, and produces a reorder row with the right suggested quantity |
| **Barcode linking** | Same file: a linked code resolves to the right product, no duplicate product is created, first-barcode-is-primary is derived, a cross-tenant product id is refused as NotFound, and two tenants can enrol the same UPC |
| **Count freeze + reopen** | A submitted or reviewed count refuses writes with a distinct error; reopen returns it to `in_progress` and writes land again; a **closed** count can never be reopened |
| **Error discrimination** | `tests/db-errors.test.ts` — asserts against the real `DrizzleQueryError` class, not a stand-in, because the shape that broke it came from the library |
| **Back office UI** | Signed in through the real form in Chrome, dashboard and all office routes render, console clean, unauthenticated requests redirect |
| **Role gating is structural** | A manager's HTML contains no unpriced tile at all, and zero dollar-shaped strings anywhere in the response |

**57 tests across 4 files**, all green, as of 2026-07-30.

**The suite is checked for teeth, repeatedly.** Deleting the ledger insert from
`applyIncrement` — the whole idempotency mechanism — fails exactly the four
dependent tests. Stubbing out `upsertProductPar` fails exactly the 13
par/reorder tests. Widening `isCountWritable` to accept `submitted` fails
exactly the 3 write-refusal tests. In each case everything unrelated stays
green. A suite that passes against a broken implementation is worse than none,
so re-do this after any significant change to the write path.

## What is built but unproven

Written, reviewed, typechecked — never observed working.

- **The counting app on a phone.** Scan, tenths, sealed quantities, scan-to-enroll,
  the locked-location leg. This is the product, and it is the biggest unknown.
  The environment around it is now built and largely verified (see below); what
  has never happened is a human counting bottles with it.
- **The camera, on any real device.** The LAN HTTPS path was built precisely so
  the camera can exist at all, and everything testable from a terminal passes —
  certificate SAN, a 200 over TLS, client chunks served, Server Actions
  surviving the proxy's `Host` rewrite, sign-in trusted from the https origin
  and refused from a foreign one. **What is unverified is the last inch:**
  accepting the certificate warning on the handset and `getUserMedia` actually
  opening a lens. No camera has been opened by this project yet, on any device.
- **Everything added to the counting leg on 2026-07-30.** Four changes, all UI,
  none of them covered by a test and none of them driven on a device: the
  search-first barcode-link screen (which added a step to a path held to a
  20-second budget, so it wants timing specifically), the fill-correction mode,
  the optimistic rollback on a refused write, and the message naming a dropped
  queued write. Listed with how to exercise each as open-item #20.
- **The offline write queue** (`lib/count-queue.ts`). Reasoned about only. It was
  already wrong once — the original had no drain path at all — and 2026-07-30
  changed its rejection behaviour, so a permanently-refused write now leaves the
  queue instead of jamming it. That makes exercising it more worthwhile, not less.
- **The production CSP.** Dev proves the nonce mechanism; production is a
  different, stricter policy that has never run.
- **Concurrency.** The gap-lock deadlock and `withLockRetry` were reproduced by
  hand against MySQL — never against MariaDB, never as a test.
- **Valuation against real costs.** 88 of 97 products are unpriced.
- **The deploy pipeline.** Built, never run against a real host.

## Recent history

- **2026-07-30** — **The Phase 1 code gaps are closed** (`docs/mvp-gaps.md`,
  branch `fix/mvp-gaps-blockers`, nine commits). A, B, C, D1, D2, E, F, G and I
  fixed; H (vendors) and J (`scanCountLine` dead code) deliberately left. The
  three that mattered were all silent: the reorder list could never produce a
  row and said "Nothing is below its reorder point"; scan-to-enroll dead-ended
  on every product already in the catalog, or duplicated it if you typed a
  differing name; and a refused write stayed on screen as counted while later
  scans compounded onto the phantom. Freezing writes on `submitted` needed
  `reopenCount` added alongside it, or a mis-tapped Submit would strand a
  half-counted count behind an immutable close.
  **Also found, and not in the audit:** `isDuplicateKeyError` was blind to
  errors drizzle had wrapped in `DrizzleQueryError`, which made every
  `ConflictError` in the catalog unreachable — they were arriving as "Something
  went wrong" mid-count. That is the third failure here whose defining feature
  is that every gate stayed green, after the CSP and the dev cross-origin 403.
- **2026-07-29** — **The phone can now reach a secure origin.** The camera is
  gated on a secure context, and the `chrome://flags` override that fakes one
  is Chromium-only — it had silently done nothing twice, because the handset's
  preflight showed no native `BarcodeDetector`, which means the browser is not
  Chromium. Replaced with actual HTTPS: `scripts/dev-lan.sh` now mints a
  self-signed certificate naming the LAN IP and runs an nginx TLS proxy
  (compose profile `tls`) on :3443, so scanning works on any browser with no
  per-device flag. Added `/count/preflight`, a device capability screen, and
  `docs/phone-count-test.md`, the run protocol. **Nothing has been counted
  yet — this is setup, and the camera itself is still unproven.**
- **2026-07-28** — **First attempt at a real count on a phone.** It got as far
  as the first save and threw: `crypto.randomUUID` is a secure-context-only
  API, and the only way to reach the counting screens is a phone on a plain-http
  LAN origin. So the entire write path was unreachable on the one device that
  matters, and nothing server-side could see it — the 17 write-path tests, the
  typecheck and the server render all passed. Fixed with an RFC 4122 v4
  fallback built on `crypto.getRandomValues` (not secure-context gated, and a
  CSPRNG — `Math.random()` would silently drop scans, since the ledger treats a
  colliding `client_line_id` as a replay). Covered by 5 new tests, mutation-checked.
  Also found and fixed: Next's dev cross-origin guard was returning 403 for every
  client chunk on `127.0.0.1`, so that origin rendered and never hydrated
  (open-items #17). Added `/count/preflight` and `docs/phone-count-test.md`.
- **2026-07-28** — Dashboard added at `/office`; counts table moved to
  `/office/counts`. **Found and fixed a CSP that blocked every inline script**, so
  nothing in the app hydrated while every server-side check passed; it also caused
  the login form to leak a plaintext password into the URL. Both fixed and
  verified in a browser.
- **2026-07-28** — Engine correction: the database is **MariaDB 11.8**, not MySQL.
  hPanel's label had been taken at face value everywhere. Driver, dialect and URL
  scheme are all still correct.
- **2026-07-28** — Auth and write paths closed against a real database.
- **2026-07-27** — Multi-tenancy landed before the first migration ran. Schema
  audit fixed an unchecked `vendor_id` and a reproducible count-line deadlock.
- **2026-07-27** — Renamed Handlebar → Truestock.

## The current risk, stated plainly

**Everything verified so far is below the UI.** The domain layer is in good shape
and well covered. But the app's entire reason to exist is being faster than a
clipboard in a dim bar, one-handed, and no part of that claim has been tested.

The CSP incident is the cautionary tale: the failure was total — no interactive
element anywhere in the app — and it passed CI, `next build`, the `/ship` gate,
and every status-code assertion. **Server-side confidence does not transfer to
the client.**

**This got sharper on 2026-07-30, not weaker.** The gap audit found nine real
defects by reading code, and then a tenth surfaced only because a new test
exercised the real library — `isDuplicateKeyError` had been silently blind to
wrapped errors, disabling every `ConflictError` in the catalog. Three of this
project's worst bugs now share one signature: **every gate stayed green.**
Typecheck, build, lint, status codes, and the tests that existed. When something
here looks like it cannot fail, that is the claim worth executing against the
actual library, the actual database, or the actual browser.

## Picking this up cold — the phone count

Everything needed to run it is built and committed. Nothing has been run.

```bash
bun run docker:up:lan     # LAN bind + self-signed cert + TLS proxy; prints both URLs
bun run docker:migrate    # only on a fresh volume
bun run docker:seed       # only on a fresh volume
```

Then on the phone, open **`https://<lan-ip>:3443/count/preflight`**, accept the
certificate warning once (*Advanced → Proceed*), and confirm **Secure context:
Yes** before anything else. Full protocol: `docs/phone-count-test.md`.

Three things to know before starting, each of which will otherwise waste an
hour:

1. **The https URL is the one that matters.** Plain http on :3000 works for
   quantity and search-picker counting but the camera cannot exist there. If
   preflight says *Secure context: No*, you are on the wrong URL.
2. **A first pass enrols, it does not count.** All 97 seeded products ship with
   no barcode, so every scan opens the enroll screen. That measures the enroll
   flow's **20-second** budget, not the 20-minute one.
   **Changed 2026-07-30 — the old warning here is no longer true.** That screen
   used to only *create*, so a first pass produced duplicate products and the
   advice was to `docker:reset` between runs. It now opens on search and links
   the barcode to the product the catalog already has, which is the whole point
   of a first pass. Resetting between runs is now optional, and the thing to
   watch is the clock, not the duplicates.
3. **Accounts do not survive `docker:reset`.** Recreate with `bun run
   create-user`. There is no public signup, deliberately.

Local database state as of this commit: draft count #1 open, 5 locations, 98
products, 0 barcodes, **0 par levels** — so the reorder list is now *able* to
produce rows but still won't until a par is set on something. Two throwaway
owner accounts exist for browser checks, `tester@truestock.local` and
`browsercheck@truestock.local` — delete them or reset the volume.

## Next three things

Unchanged by the 2026-07-30 work, and that is the point: closing the code gaps
removed the reasons a phone test would have dead-ended, it did not substitute
for one. Protocol for 1 and 2: **`docs/phone-count-test.md`**. Start at
`/count/preflight` on the phone.

1. **Drive a real count on a phone.** Time it against the sub-20-minute target the
   whole design is justified by. A *first* pass enrols rather than counts — every
   barcode is unknown — so it measures the enroll flow's 20-second budget, not
   the 20-minute one. Fold in open-item #20's four checks while you are in there;
   they exercise the same screens.
2. **Exercise the offline queue for real** — turn the WiFi off mid-scan, and go
   into the walk-in.
3. **Verify the production CSP** with `next build && next start` before any deploy.

After those, the shortest path to a genuinely useful reorder list is
**open-item #19 (vendors have no write path)** plus real costs and pars —
the list now produces rows, but every one of them lands in a single "No vendor
set" group.

## Scope reminders

**In the MVP:** catalog, locations, barcode scan, tenths, quantities, count
sessions, valuation, reorder, three roles, multi-tenancy.

**Deliberately out:** AI fill estimation, bottle photos, invoice OCR, Toast PMIX
import, variance reporting, compliance packet. **The MVP contains no AI and no
file storage** — if a task seems to need either, it is probably scope creep.

**Multi-tenant, but not multi-tenant yet:** `organization` is the tenant boundary
and every query is scoped to it. Not built: users in more than one org, an org
switcher, billing, signup, per-tenant subdomains. All additive.
