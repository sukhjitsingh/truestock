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
  The environment around it is now built and largely verified (see below); what
  has never happened is a human counting bottles with it.
- **The camera, on any real device.** The LAN HTTPS path was built precisely so
  the camera can exist at all, and everything testable from a terminal passes —
  certificate SAN, a 200 over TLS, client chunks served, Server Actions
  surviving the proxy's `Host` rewrite, sign-in trusted from the https origin
  and refused from a foreign one. **What is unverified is the last inch:**
  accepting the certificate warning on the handset and `getUserMedia` actually
  opening a lens. No camera has been opened by this project yet, on any device.
- **The offline write queue** (`lib/count-queue.ts`). Reasoned about only. It was
  already wrong once — the original had no drain path at all.
- **The production CSP.** Dev proves the nonce mechanism; production is a
  different, stricter policy that has never run.
- **Concurrency.** The gap-lock deadlock and `withLockRetry` were reproduced by
  hand against MySQL — never against MariaDB, never as a test.
- **Valuation against real costs.** 88 of 97 products are unpriced.
- **The deploy pipeline.** Built, never run against a real host.

## Recent history

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
   no barcode, so every scan opens the enroll form. That measures the enroll
   form's **20-second** budget, not the 20-minute one. And per open-item #16 it
   creates duplicate products rather than filling in `upc` — harmless locally,
   so `bun run docker:reset` between runs.
3. **Accounts do not survive `docker:reset`.** Recreate with `bun run
   create-user`. There is no public signup, deliberately.

Local database state as of this commit: draft count #1 open, 5 locations, 97
products, 0 barcodes. There is also a throwaway `tester@truestock.local` owner
account created for browser-verifying the preflight screen — delete it or reset
the volume.

## Next three things

Protocol for 1 and 2: **`docs/phone-count-test.md`**. Start at
`/count/preflight` on the phone.

1. **Drive a real count on a phone.** Time it against the sub-20-minute target the
   whole design is justified by. Note that a *first* pass enrols rather than
   counts — every barcode is unknown — so it measures the enroll form's
   20-second budget, not the 20-minute one.
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
