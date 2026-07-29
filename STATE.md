# Truestock — current state

Where the project actually is. Updated 2026-07-28.

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

---

## What is verified

Verified means *observed running*, not reviewed or typechecked.

| Area | Evidence |
|---|---|
| **Schema + migrations** | Chain `0000 → 0001 → 0002` applied to MariaDB 11.8 in Docker. Composite tenant FKs reject cross-tenant ids (1452), `product_par` blocks a second overall par (1062), `DECIMAL(10,4)` exact, accented names round-trip |
| **Auth path** | Better Auth under `generateId: "serial"` returns integer ids; sign-in returns a session; the inactive-user re-read gate refuses a *still-valid* session — **with a negative control** |
| **Count write path** | `tests/count-write-path.test.ts` — 17 tests against real MariaDB, wired into CI as a service container |
| **Invariants 1, 2, 3, 8, 9** | Covered by that suite: closed counts refuse writes, cost snapshots survive a price change, three scans make one row, a manager never receives cost fields, cross-tenant ids are refused |
| **Idempotency** | Same `clientLineId` twice increments once; a differing replay leaves the line untouched |
| **Back office UI** | Signed in through the real form in Chrome, dashboard and all office routes render, console clean, unauthenticated requests redirect |
| **Role gating is structural** | A manager's HTML contains no unpriced tile at all, and zero dollar-shaped strings anywhere in the response |

**The test suite was checked for teeth.** Deleting the ledger insert from
`applyIncrement` — the whole idempotency mechanism — fails exactly the four
dependent tests and leaves the rest green. A suite that passes against a broken
implementation is worse than none, so re-do that check after any significant
change to the write path.

## What is built but unproven

Written, reviewed, typechecked — never observed working.

- **The counting app on a phone.** Scan, tenths, sealed quantities, scan-to-enroll,
  the locked-location leg. This is the product, and it is the biggest unknown.
- **The offline write queue** (`lib/count-queue.ts`). Reasoned about only. It was
  already wrong once — the original had no drain path at all.
- **The production CSP.** Dev proves the nonce mechanism; production is a
  different, stricter policy that has never run.
- **Concurrency.** The gap-lock deadlock and `withLockRetry` were reproduced by
  hand against MySQL — never against MariaDB, never as a test.
- **Valuation against real costs.** 88 of 97 products are unpriced.
- **The deploy pipeline.** Built, never run against a real host.

## Recent history

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

## Next three things

1. **Drive a real count on a phone.** Time it against the sub-20-minute target the
   whole design is justified by.
2. **Exercise the offline queue for real** — turn the WiFi off mid-scan, and go
   into the walk-in.
3. **Verify the production CSP** with `next build && next start` before any deploy.

## Scope reminders

**In the MVP:** catalog, locations, barcode scan, tenths, quantities, count
sessions, valuation, reorder, three roles, multi-tenancy.

**Deliberately out:** AI fill estimation, bottle photos, invoice OCR, Toast PMIX
import, variance reporting, compliance packet. **The MVP contains no AI and no
file storage** — if a task seems to need either, it is probably scope creep.

**Multi-tenant, but not multi-tenant yet:** `organization` is the tenant boundary
and every query is scoped to it. Not built: users in more than one org, an org
switcher, billing, signup, per-tenant subdomains. All additive.
