# Truestock — go-live gate

What must be true before the first production deploy, and what must be verified
**after** it. `docs/deploy.md` is the runbook — the mechanics of how a deploy
happens. This is the decision: whether it should.

**This is Phase 3, re-sequenced 2026-08-12.** Deploy used to follow the MVP
immediately; it now sits behind Phase 1 (locations screen, bulk cost entry),
Phase 1.5 (survive-daily-use items), Phase 2.9 (the deferred field
measurements), Phase 2 (UI redesign) and Phase 2.5 (OCR invoice automation).
See `ROADMAP.md`. Nothing in this file changed because of that — a gate is a
gate whenever it is reached — but two things follow from the new position:

- **Phase 2.9 should close the standalone-entrypoint item below** before this
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
      The full chain is now `0000 → … → 0009`. All ten migrations apply clean
      from empty on MariaDB 11.8 in isolated Docker verification; none has run
      against production. `docs/deploy.md` §4 covers bootstrap order.
- [ ] **Phase 2.9's data and field gate is signed off.** This is a prerequisite
      phase, not an optional launch follow-up: real catalog costs/case sizes/
      pars/vendors are populated, 20–25 real invoices meet or revise the
      under-30-minute target, an actual scanned invoice completes through the
      live Claude Vision path, and the redesigned phone count has run across
      all locations against a hand check.
- [ ] **Production Phase 2.5 configuration is set and proven.** Use a production
      `ANTHROPIC_API_KEY`; set `INVOICE_STORAGE_DIR` to an **absolute persistent
      directory outside both the web root and replaceable release tree**; and
      configure `EMAIL_PROVIDER=sendgrid`, `EMAIL_API_KEY`, and `EMAIL_FROM`.
      Upload/download one retained original, restart and redeploy, then prove the
      same file remains readable through its authenticated route. Send one real
      notification and follow its absolute download link. `docs/deploy.md`'s
      Hostinger setup step 4 contains the variable and storage contract.
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
      entrypoint is not. **Phase 2.9 should close this locally**, including one
      text-PDF extraction that proves the standalone trace contains
      `@firecrawl/pdf-inspector`'s native binary, so that a later failure is a
      hosting problem rather than an unknown.

### 1.2 Non-blocking but decide deliberately

These do not stop a deploy. Each is a conscious “yes, launch with this state.”

- [ ] **The expired-session sweep is scheduled** (open item #1b).
      `sweepExpiredSessions` exists and is tested; only the Hostinger cron is
      missing. Create it here or explicitly accept manual invocation.
- [ ] **Local Phase 2.5 invoice files are migrated or declared a throwaway
      pilot.** The database rows and `INVOICE_STORAGE_DIR` tree must move
      together; migrating one without the other creates archive rows whose
      retained originals do not exist.
- [ ] **Audit-packet open item #39 is accepted or fixed.** Today one build can
      buffer all selected invoices in memory, and a process death can strand a
      packet at `building`, permanently blocking that organization until manual
      repair. Record the maximum supported range and recovery procedure if these
      ship unchanged.
- [ ] **The full compliance module is still deferred.** Phase 2.5 ships retained
      originals and a limited invoice/count ZIP. It does not ship Phase 6's
      locked month-end food/liquor reports or a legally reviewed regulator
      presentation.

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
- [ ] **`INVOICE_STORAGE_DIR` is outside the web root, verified on the real host**
      (Phase 2.5, AR-1). Two separate things to check, because they fail
      independently:
      1. Fetch a known stored path directly — `https://<host>/var/invoices/1/1.pdf`
         and whatever the deployed root actually is — and confirm **404**, not the
         file. The only path that may return bytes is
         `GET /api/invoices/<id>/file`, and only for an owner.
      2. Confirm `process.cwd()` at server start is the directory that contains the
         deployed `public/`. `invoiceStorageRoot()`'s refusal-if-inside-`public/`
         guard resolves `./public` relative to the working directory, so a cwd that
         is *not* the standalone output root silently defeats that specific guard —
         it would compare against a `public/` that isn't the one being served.
         The containment check in `resolveStoredPath` still holds either way, so
         this is the belt failing quietly while the braces hold; check it once
         rather than assume it. Under `output: 'standalone'` the cwd should already
         be correct — verify, don't reason.

### 2.3 Phase 2.5 production smoke — archive through audit packet

- [ ] **Upload one text PDF and one real photographed/scanned invoice as the
      owner.** Both originals survive a process restart and deploy; direct URL
      guesses return 404; manager and staff sessions receive no file bytes.
- [ ] **Run extraction through both providers.** The text PDF uses
      pdf-inspector from the standalone artifact. The scan reaches the real
      Claude Vision API, records provider/model/token/cost provenance, and lands
      in the owner review queue rather than silently inventing unmatched data.
- [ ] **Review and approve one matched line.** Confirm the invoice locks, one
      `product_cost_history` row points to its source line, and a repeated
      approval cannot post the cost twice.
- [ ] **Generate a date-range audit packet.** Observe `PROCESSING → READY`,
      receive the real SendGrid message, follow its absolute authenticated link,
      inspect the ZIP manifest/hashes, confirm another tenant cannot fetch it,
      and confirm the link stops working after its ten-minute expiry.
- [ ] **Exercise the accepted #39 recovery contract.** Stay within the recorded
      range limit and prove the operator can clear or fail a deliberately
      stranded `building` row; if there is no safe rehearsal, fix the reaper
      before launch rather than call the debt accepted.

### 2.4 Tenancy, against real production data

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

### 2.5 The first real count — the part with the least evidence

**Updated 2026-08-12.** This section used to say everything below had been
reasoned about and never observed. That is no longer true: four phone sessions
drove the counting loop end to end against the LAN stack, and Phase 2.9 is
where the rest gets measured. What remains true is that **none of it has run
against production** — a different database, real TLS, a real phone on the
bar's WiFi rather than the office's.

So read each box below as "confirm this still holds *here*", not as "find out
whether it works". Where there is a local result to compare against, it is
named — a check that passed locally and fails here is telling you something
specific about production rather than about the code.

- [ ] **Drive a full count on a phone, one-handed**, in actual bar lighting.
      Time it against the sub-20-minute target. *Phase 2.9 measures this first;
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
      Deferred to Phase 2.9; if that has not happened, this is the first time.*
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
      failure modes are silent. Quantity locations only. *Deferred to Phase 2.9;
      do not let production be where this is first tried.*

### 2.6 Numbers, once a count is closed

- [ ] **The dashboard's owner-only value and vs-previous delta render.** Closed
      counts exist and the dashboard has been opened, but no named positive
      browser assertion proves this branch while preserving the manager's
      negative control (open item #15).
- [ ] **A manager sees no cost anywhere.** Check the *response*, not the screen:
      cost fields must be absent from the payload, not hidden in CSS (invariant 8).
- [ ] **Unpriced lines are excluded and reported as excluded**, never valued at
      zero (open-items #4).
- [ ] **Reorder list is sane** against real par levels.

### 2.7 Watch for a week

- [ ] **Memory and CPU on the shared plan.** 3 GB and 4 cores cover this app *and*
      the existing website; the app is not isolated from it.
- [ ] **Database connections stay within the pool of 5–10**, against a 100
      connection limit shared with the website.
- [ ] **Daily backups are actually running**, and a restore has been tried once.
      An untested backup is a belief, not a backup.
- [ ] **`session` row growth** — informational; the sweep exists, but Hostinger
      cron scheduling is deferred to this deploy (#1b).

---

## Part 3 — Known-and-accepted at launch

Recorded so nobody rediscovers a deliberate limit as a new bug. Full detail and
triggers live in `docs/open-items.md`; anything Phase 2.9 or Part 1 closes should
be removed from this table rather than left stale.

| Item | What it means at launch |
|---|---|
| #12 | Wine remains varietals and uses the search picker — a deliberate scope decision |
| #21 | Case entry for spirits is deliberately absent; only bottled beer gets the field |
| #28 | Chart colors 2–5 remain undefined because no chart ships before Phase 4 |
| #29 | The full accessibility harness covers `/office/catalog`; other office routes were visually opened but not all receive the same named tab/heading/icon assertions unless closed before launch |
| #30 | Three older tables still use ad hoc markup; this is accessibility/design-system debt, not data risk |
| #31 | Invoice-path containment does not resolve symlinks; accepted only while every stored path is generated internally and filesystem write access is already privileged |
| #39 | Audit-packet builds buffer selected files and have no stale-build reaper; launch requires an accepted range limit and manual recovery procedure if not fixed |

Rows deliberately removed because they are closed: #2 (fill corrections now
write before/after ledger rows), #3 (user management), #10 (rapid scan is
reachable), #11 (Walk-In mode confirmed), #14 (dedicated dashboard aggregates),
#24 (LAN-state prevention), and #25–#27 (verification fixes).

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
