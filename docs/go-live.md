# Truestock — go-live gate

What must be true before the first production deploy, and what must be verified
**after** it. `docs/deploy.md` is the runbook — the mechanics of how a deploy
happens. This is the decision: whether it should.

**This is Phase 3, re-sequenced 2026-08-12.** Deploy used to follow the MVP
immediately; it now sits behind Phase 1 (locations screen, bulk cost entry),
Phase 1.5 (survive-daily-use items), Phase 1.9 (the deferred field
measurements), Phase 2 (UI redesign) and Phase 2.5 (OCR invoice automation).
See `ROADMAP.md`. Nothing in this file changed because of that — a gate is a
gate whenever it is reached — but two things follow from the new position:

- **Phase 1.9 should close the standalone-entrypoint item below** before this
  gate is ever opened, which removes the last deploy-day unknown.
- **Part 2.4's counting checks are no longer entirely unobserved.** Most of
  them now have a local result to compare against, which makes them stronger
  rather than redundant — a check that has passed once locally and fails here
  is telling you something specific about production.

Two rules govern this document.

**A 200 is not evidence.** This project has already shipped a change where every
page rendered, every status code was correct, CI passed, `next build` passed, and
no button on the site worked (open-items #13). Server-side checks prove the
server ran. Everything a user touches lives on the other side of hydration, and
nothing in the pipeline looks there. So every post-release check below that can
be done in a browser, is.

**Verify against production, not against a copy of it.** The whole point of the
post-release list is that production differs from local: a stricter CSP, real
TLS, a different database, a real phone on real bar WiFi. Re-running the local
suite against production tells you nothing new.

---

## Part 1 — Pre-launch gate

Blocking items. Each one is either done or the deploy waits.

### 1.1 Blocking — must be true before deploying

- [x] **The production CSP is verified in a browser.** Open-items #13.
      **Done 2026-08-12.** Production mode was run on the LAN
      (`bun run docker:up:prod`) and the login page opened in a real browser:
      the served policy is `script-src 'self' 'nonce-…' 'wasm-unsafe-eval'`
      with no `'unsafe-eval'` and `connect-src 'self'` with no `ws:`, all 16
      scripts carry the nonce, React hydrates, and the console is clean of
      violations. The barcode scanner also decoded a real UPC under it, which
      is what `'wasm-unsafe-eval'` is there for.
      **The check this item used to prescribe was wrong — see 2.1.** Re-verify
      after the first real deploy anyway: this ran under `next start`, not the
      standalone server production actually uses.
- [ ] **A production database exists and migrations have applied to it.**
      The chain `0000 → 0001 → 0002` has only ever run against Docker.
      `docs/deploy.md` §4 covers bootstrap order.
- [ ] **An owner account exists on production**, created via
      `scripts/create-user.ts` with the **hidden prompt**, never `--password`.
      There is no signup path, deliberately.
- [ ] **Secrets are set in GitHub Actions** and `DATABASE_URL` points at
      production. `docs/deploy.md` §3.
- [ ] **`BETTER_AUTH_SECRET` is a fresh production value**, not the dev one.
- [ ] **A rollback has been rehearsed**, not just documented. `docs/deploy.md` §8.
- [ ] **The dev owner password is not reused.** `LocalDevOwner123` sat in a
      plaintext container log and must be treated as public.
- [ ] **`node .next/standalone/server.js` has been started at least once.**
      The 2026-08-12 CSP verification ran under `next start`, which printed
      `"next start" does not work with "output: standalone" configuration`. It
      gave us what was needed — no HMR, the real CSP — but it is not the
      runtime Hostinger uses. The policy and hydration are settled; the
      entrypoint is not. **Phase 1.9 should close this locally**, so that a
      failure here is a hosting problem rather than an unknown.

### 1.2 Non-blocking but decide deliberately

These do not stop a deploy. Each is a conscious "yes, launch without this."

- [ ] **Costs are entered — or deliberately are not** (open-items #4).
      **Queried 2026-08-12: 90 of 99 active products have no
      `current_unit_cost`, and 0 of 99 carry a `case_size`.** The only priced
      products are the 9 draft kegs, which came costed in the seed. Unpriced
      lines are excluded from valuation and reported as excluded rather than
      valued at zero, so this is *correct* — but a production count taken today
      would be almost entirely unpriced, and the dashboard will say so in large
      type. **Phase 1 is meant to close this** (bulk cost entry, then the data
      itself); if it has not, launching anyway is reasonable and being surprised
      by it is not.
- [ ] **Nothing sweeps expired sessions** (open-items #1b). Years away from
      mattering at this scale. **The query is Phase 1.5 work and the Hostinger
      cron is created here** — this is the phase where it stops being a plan.
- [x] ~~**No user-management screen exists**~~ — **done 2026-08-03,
      browser-verified 2026-08-04.** `/office/users` with `listUsers`,
      `setUserActive`, `setUserRole`; deactivation deletes the user's `session`
      rows in the same transaction, so the account is refused on its very next
      request. Role and active changes are no longer manual SQL.
- [x] ~~**Walk-In's count mode is inferred, not confirmed**~~ — **confirmed
      2026-07-31.** The owner answered: Walk-In holds sealed packaged beer only,
      no open kegs, so `count_mode` stays `quantity` as seeded. No code change —
      what the item waited on was the confirmation, not the value.
- [ ] **Locations are manageable from the app** (Phase 1). If Phase 1's
      `/office/locations` screen has not shipped, a production tenant cannot add
      a tap line, rename a location, or set a `count_mode` without SQL — and
      `count_mode` is what decides whether a keg gets a fill pad at all. This is
      not a blocker for *your* bar, whose locations are seeded. It is a blocker
      for the second tenant.

---

## Part 2 — Post-release verification

**Run this list against production, in this order, on the first day.** Items 2.1
and 2.2 are the ones that catch a broken launch; the rest can follow within the
first week.

### 2.1 The app is actually alive — do this first, in a browser

Not with `curl`. See the rule at the top.

- [ ] **Load the sign-in page on a real phone over the bar's WiFi.** Not a desktop
      browser, not localhost.
- [ ] **The Sign in button is ENABLED.** This is the hydration check, and it
      needs no devtools: the button is gated on a hydrated flag, so if the CSP
      is blocking inline scripts it stays disabled forever. Enabled means React
      ran. Allow a couple of seconds — a production bundle hydrates later than
      dev, and checking too early reads as a failure. (Observed 2026-08-12:
      disabled at first probe, enabled ~3s later.)
      **Corrected 2026-08-12 — the previous check here was wrong and would
      have caused a false rollback.** It said to confirm
      `typeof self.__next_r !== 'undefined'` and to watch for
      `InvariantError ... self.__next_r`. **`self.__next_r` is set only by
      `next dev`** — it is the request id Next's HMR client keys its websocket
      on (`next/dist/client/dev/hot-reloader/app/web-socket.js`, which throws
      that very InvariantError when it is missing). In a production build it is
      *correctly* undefined and that error can never appear. Verified directly:
      production had `self.__next_r === undefined` while React was fully
      hydrated. Following the old instruction would have rolled back a working
      deploy.
- [ ] **DevTools console is clean on first load** — no CSP violation reports,
      no uncaught exceptions from the app itself. Browser extensions produce
      their own noise; read the source of each line before believing it.
- [ ] **Sign in through the form.** If the URL afterwards contains
      `?email=...&password=...`, **stop and roll back**: hydration is broken and
      the app just wrote a plaintext password to the access log.
- [ ] **The dashboard renders** with real tiles, not an error boundary.
- [ ] **Navigate every office route** — dashboard, counts, catalog, reorder — and
      confirm the console stays clean on each.
- [ ] **Sign out, then request `/office` directly.** It must redirect to `/login`.
      Without this negative control, four working pages prove the pages render,
      not that anything is gated.

### 2.2 Security posture on the real origin

- [ ] **Exactly one `Content-Security-Policy` response header**, carrying a
      `nonce-`. Two headers are intersected by the browser and the stricter one
      wins silently:
      `curl -sI https://<host>/login | grep -ci content-security-policy` → `1`
- [ ] **HSTS, `nosniff`, `X-Frame-Options`, `Permissions-Policy` present** on a
      real HTTPS response.
- [ ] **`camera=(self)`** survives to production — the barcode scanner needs it,
      and the failure only appears when someone tries to scan.
- [ ] **HTTPS is genuinely enforced.** Camera and `BarcodeDetector` refuse to run
      otherwise, so this is a functional requirement, not only a security one.
- [ ] **No dev credentials work.** Confirm `owner@truestock.local` does not exist.

### 2.3 Tenancy, against real production data

The invariant that cannot be tested by one tenant using the app normally.

- [ ] **Create a second organization** and confirm a user in org A cannot reach
      org B's data — product, location, count, count line. A cross-tenant id must
      return NotFound, never an answer confirming the row is real (invariant 9).
- [ ] **Confirm both orgs can enrol the same UPC.** This was a real pre-launch
      blocker: a globally unique barcode would let the first bar to scan a UPC own
      it for every tenant.
- [ ] **Deactivate a user** (`user.active = 0`) while they hold a live session and
      confirm their very next request is refused. Better Auth's own session stays
      valid by design; `requireSession()`'s re-read is what stops them.

### 2.4 The first real count — the part with the least evidence

**Updated 2026-08-12.** This section used to say everything below had been
reasoned about and never observed. That is no longer true: four phone sessions
drove the counting loop end to end against the LAN stack, and Phase 1.9 is
where the rest gets measured. What remains true is that **none of it has run
against production** — a different database, real TLS, a real phone on the
bar's WiFi rather than the office's.

So read each box below as "confirm this still holds *here*", not as "find out
whether it works". Where there is a local result to compare against, it is
named — a check that passed locally and fails here is telling you something
specific about production rather than about the code.

- [ ] **Drive a full count on a phone, one-handed**, in actual bar lighting.
      Time it against the sub-20-minute target. *Phase 1.9 measures this first;
      if it has not run, this is the first measurement and should be treated as
      such rather than as a confirmation.*
- [ ] **Turn WiFi off mid-scan.** Count three bottles. The chip must read
      "3 pending" and the rows must still appear. *Locally: `1 pending` on
      airplane mode, count 4, 2026-08-12.*
- [ ] **Turn WiFi back on** and confirm the queue drains. *Locally: returned to
      `Synced` with no interaction, so the `online` listener fires and `flush()`
      drains.*
- [ ] **Kill the app with writes queued**, reopen, confirm the mount-time flush
      sends them. *Never observed anywhere — only the `online` path has run.
      Deferred to Phase 1.9; if that has not happened, this is the first time.*
- [ ] **Queue more than one write at a time** and confirm ordered replay. The
      queue has only ever held a single write.
- [ ] **The one that matters most:** confirm a write that reached the server *just
      before* the connection dropped does not apply twice when the queue resends
      it. That is what `client_line_id` exists for, and it is the failure the
      whole ledger design was built to prevent.
- [ ] **Walk into the walk-in with the phone.** Walk-ins are metal boxes and
      routinely kill WiFi. Either the queue holds or that section gets counted
      outside the box.
- [ ] **Scan the same bottle twice in one location.** It must increment one line,
      never create a second (invariant 3). *Covered by
      `tests/count-write-path.test.ts` and mutation-checked, but never done by
      hand on a device — both real scans so far were enrolments of unknown
      codes, which is a different branch of `onBarcode`.*
- [ ] **Close a count, then confirm it refuses edits** (invariant 1). *Locally:
      four counts closed; valuation reconciled to the cent in SQL on count 2.*
- [ ] **Rapid-scan a shelf, then count it by hand, and compare.** Its frame
      guard is tested only against modelled frame sequences, and both of its
      failure modes are silent. Quantity locations only. *Deferred to Phase 1.9;
      do not let production be where this is first tried.*

### 2.5 Numbers, once a count is closed

- [ ] **The dashboard's owner-only value and vs-previous delta render** — that
      branch has never executed (open-items #15).
- [ ] **A manager sees no cost anywhere.** Check the *response*, not the screen:
      cost fields must be absent from the payload, not hidden in CSS (invariant 8).
- [ ] **Unpriced lines are excluded and reported as excluded**, never valued at
      zero (open-items #4).
- [ ] **Reorder list is sane** against real par levels.

### 2.6 Watch for a week

- [ ] **Memory and CPU on the shared plan.** 3 GB and 4 cores cover this app *and*
      the existing website; the app is not isolated from it.
- [ ] **Database connections stay within the pool of 5–10**, against a 100
      connection limit shared with the website.
- [ ] **Daily backups are actually running**, and a restore has been tried once.
      An untested backup is a belief, not a backup.
- [ ] **`session` row growth** — informational; the sweep is deferred (#1b).

---

## Part 3 — Known-and-accepted at launch

Recorded so nobody rediscovers them as bugs. Full detail in `docs/open-items.md`.

Re-checked against the database and the code on 2026-08-12 — three rows here
had gone stale and said the opposite of the truth.

| Item | What it means at launch |
|---|---|
| #14 | Dashboard stat tiles come from capped reads (`limit: 100` products, `limit: 50` counts). **The catalog now holds 101 products, 99 active** — two more active products and the tile silently understates. Phase 1.5 replaces it with a dedicated aggregate |
| #4 | **90 of 99 active products unpriced, 0 carry a `case_size`**; valuation is proven but thin until invoices are entered |
| #2 | Fill corrections write no ledger row — an audit-trail gap, not a wrong number. Its trigger is the compliance packet, deliberately not before |
| #12 | Wine stays varietals, counted via the search picker — a scope decision |
| #21 | Case entry for spirits is deliberately absent — only bottled beer gets the field. A scope decision, not a gap |
| #24 | A plain `docker:up` silently reverts a live LAN session. Dev-only, but it is how the phone loses its allowlisted origin with everything still returning 200 |

**Three rows were removed as no longer true**, rather than left to be trusted:
#3 (user management shipped 2026-08-03 and is browser-verified — role and
active changes are no longer manual SQL), #10 (`scanCountLine` was wired
2026-08-04 and rapid mode is reachable; what is unproven is the camera, which
is now a Phase 1.9 item), and #11 (Walk-In's count mode was confirmed by the
owner on 2026-07-31).

---

## Part 4 — Roll back if

Not a judgement call in the moment. Any of these, roll back:

- `InvariantError ... self.__next_r` in the console, or any page that renders but
  does not respond to input.
- Credentials appearing in a URL or in the access log.
- Any cross-tenant read returning another org's data.
- A closed count accepting a write.
- The count line unique constraint producing duplicate rows.

`docs/deploy.md` §8 has the mechanics.
