# Testing a count on a real phone

The protocol for the one thing this project cannot verify from a laptop.

`STATE.md` puts it plainly: everything proven so far is below the UI. The
domain layer is well covered and the back office has been driven in a browser,
but the app's entire reason to exist — being faster than a clipboard, in a dim
bar, one-handed, with the other hand holding a bottle — has never been tested.
This file is how that gets tested, repeatably, by someone who was not in the
room when it was written.

**Related:** `STATE.md` (what is proven) · `docs/open-items.md` #9 (the offline
queue) and #10 (rapid-scan) · `docs/go-live.md` (the deploy gate) · `CLAUDE.md`
(the invariants any result must not violate).

---

## Why there is a written protocol at all

Three failures in a row were invisible to every check that did not involve a
human holding a device:

| What broke | What still passed |
|---|---|
| A static CSP blocked every inline script — **nothing in the app hydrated** | `curl`, `next build`, CI, `/ship`, every status code |
| The login form submitted natively as GET, putting a plaintext password in the URL | Same — the page rendered correctly and returned 200 |
| `crypto.randomUUID` is secure-context only, so **every count save threw** on a LAN origin | Server render, all 17 write-path tests, typecheck |

The pattern is identical every time: the server is fine, the response is a 200,
and the app is inert or broken in the browser. **A 200 is not evidence that a
page works.** So the protocol front-loads a device check and never treats
"the page loaded" as a result.

---

## 0. Setup — five minutes, once

On the laptop:

```bash
bun run docker:up:lan     # publishes on your LAN IP, prints the URL
bun run docker:migrate    # if this is a fresh volume
bun run docker:seed       # loads the 97-product catalog
```

`docker:up:lan` also widens the two allowlists that would otherwise reject the
phone, and prints the LAN URL. Both devices must be on the same Wi-Fi. If the
page will not load at all, it is almost always the macOS firewall.

> **A later plain `docker:up` silently undoes this.** `docker:down &&
> docker:up` is the documented way back to loopback-only, and that part is
> fine — the trap is an *incidental* `docker:up`, run for an unrelated reason
> (`docker:reset`, a script, an agent told to "try `docker:up` once if the
> database looks down"). It reverts the LAN bind with no warning: the
> container comes back up healthy, `curl` against the LAN URL still returns a
> clean 200, and the phone silently loses its allowlisted origin — see
> open-items.md #24. If sign-in that worked an hour ago stops working with no
> config change you made on purpose, check this before anything else:
> ```bash
> docker compose exec -T app env | grep DEV_LAN_ORIGIN
> ```
> Empty is the tell. Re-run `bun run docker:up:lan` — not `docker:up`.

Create an account if there isn't one — there is no public signup, deliberately:

```bash
docker compose exec -T app bun run create-user -- \
  --email owner@truestock.local --name "Local Owner" \
  --role owner --org truestock --password '<12+ chars>'
```

The script prints **two** URLs and starts a TLS proxy alongside the app:

| URL | Use it for |
|---|---|
| `https://192.168.x.x:3443` | **Everything, including scanning.** |
| `http://192.168.x.x:3000` | Quantity and search-picker counting. No camera. |

**Use the https one.** The camera is only exposed to a *secure context*, which
in practice means https — so scanning works there and nowhere else.

**On the phone, once per device:** the certificate is self-signed, so the
browser warns. Accept it — *Advanced → Proceed* in Chromium browsers,
*Advanced → Accept the Risk and Continue* in Firefox. Accepting still yields a
genuine secure context; the warning is about identity, not encryption.

> An earlier version of this file recommended
> `chrome://flags/#unsafely-treat-insecure-origin-as-secure` instead. Do not
> rely on it. It is Chromium-only and per-device, and on Firefox or Samsung
> Internet it fails by simply not existing — which looks identical to having
> set it wrong. The preflight's **Browser** row is there to catch this: no
> native `BarcodeDetector` means the browser is not Chromium, and no
> Chromium-only advice applies.

The IP is baked into the certificate, so re-run `docker:up:lan` when the router
hands out a new lease — it regenerates the cert and reprints both URLs.

---

## Observed session — no screen recording

Optional. Instead of a screen recording, let the laptop watch the phone's
browser and write a short text log. A recording is 100 MB nobody can search; the
log is a few KB plus some screenshots, and it holds the things this protocol
keeps hunting for — a request that failed, a button that was dead, a console
error, a screen that stopped changing.

**One-time on the phone:** Developer options → **USB debugging** (or **Wireless
debugging**), then accept the "Allow debugging?" prompt. Needs `adb` on the
laptop (Android platform-tools). Open the app in Chrome — the https URL from
section 0 — and leave that tab open.

```bash
adb devices                                               # the phone says "device"
bun run phone:observe -- --origin https://192.168.x.x:3443
```

Test as normal. **Ctrl+C when you are done**, then read
`.phone-sessions/session-<date>/summary.md` — a counts table, anything notable,
and a timeline. Full detail is in `events.jsonl` beside it; screenshots are in
`shots/`.

| Recorded | Never recorded |
|---|---|
| Page navigations, taps (by button label), console errors, failed requests, server-action and RSC calls with status and timing, a screenshot after each screen settles | Typed values — only *that* a field changed and its length. Password fields are not even that. Request or response bodies, cookies, auth headers, query strings, other tabs |

It is **read-only**: it never taps, types, navigates or reloads, and only a tab
whose origin is *exactly* `--origin` is watched — everything else is counted and
ignored. It is a listener, not a controller.

- **Screenshots can show what was typed** into a visible non-password field (a
  search box, a quantity). None is taken while a password field has focus or
  once the tab has left `--origin` (the log notes a `screenshot-skipped`). The
  folder is gitignored, and `--out` is refused anywhere inside the repo except
  `.phone-sessions/`; still, look through `shots/` before attaching a session
  to an issue.
- The app's own `console.*` text is recorded with URLs scrubbed, so an app that
  logs a typed value would put it in the log.
- **Attach and capture proven on a real phone** (Pixel 10 Pro XL, Brave 155 over
  USB, 2026-10-26): it found the tab, read the title and viewport, and took a
  screenshot of the signed-in Dashboard. A full counting walk is still the part
  not yet observed live. Brave uses Chrome's `chrome_devtools_remote` socket.
  The browser must be **open** — its socket disappears when it is swiped away.
  It prints the DevTools sockets it finds on the device. Sockets named
  `stetho_<package>_…` belong to apps (Google Messages exposes one), not
  browsers, and are never picked automatically. If it picks the wrong browser,
  or finds none, choose one with `--socket <name>`. `--cdp http://127.0.0.1:<port>`
  skips adb entirely, for a forward you set up yourself.
- Piping its output (`… | head`) ends the session cleanly ("output closed")
  and releases the adb forward. Do not rely on that to stop it — Ctrl+C is the
  normal way, and writes `summary.md`.
- Several devices attached → `--serial <id>`. `--help` lists every option.

---

## Host-only phone rig — a branch build, no Docker, no certificate

For testing **a branch or worktree** on the phone (not the Docker stack in
section 0). `scripts/phone/rig.sh` serves this checkout's last
`bun run build` on `127.0.0.1:3204` and carries it to the phone with
`adb reverse`. The phone opens **`http://localhost:3204`**: localhost is a
secure context, so the camera and IndexedDB work with no certificate; nothing
listens on the LAN, so the macOS firewall never asks; and `BETTER_AUTH_URL` is
exactly that origin, so sign-in works in production mode. First proven
2026-11-10 (Pixel 10 Pro XL, Chrome 156, wireless debugging): the login page
hydrated as a POST form, `isSecureContext` true, IndexedDB present.

```bash
bun run build && git checkout -- AGENTS.md   # the build rewrites AGENTS.md
bun run phone:rig up          # server + tunnels; opens the login page on the phone
bun run phone:rig status
bun run phone:rig down        # stop the server, remove the tunnels
```

- **The database is whatever `.env.local` names** (`ENV_FILE=` to change it);
  `up` prints it. Sign in on the phone yourself with an account in that
  database.
- **Wireless debugging changes port** whenever the phone's Wi-Fi drops or the
  screen has been off a while; the device then shows `offline`. `up` restarts
  adb and reconnects through mDNS. If it still finds nothing, open Developer
  options → Wireless debugging on the phone (that re-advertises it) and run
  `up` again.
- The tunnel *is* wireless debugging, so **turning the phone's Wi-Fi off cuts
  the app too** — that is a real offline test, but adb needs `up` again after.

### Playwright on the phone

The e2e specs can drive the real phone's Chrome (the `phone` project in
`playwright.config.ts`, over the same DevTools forward on 9333). The browser
runs on the phone; the test runner, the database checks and the sign-in setup
run on the laptop. It is a separate run from the desktop and emulated-mobile
ones: `bun run e2e:desktop` and `bun run e2e:mobile` never touch the phone, and
`e2e:phone` never launches a local browser for the tests.

The suite needs the **e2e database and the e2e accounts**, so the server must
be a second rig on another port, with the e2e env file (the one
`E2E_ENV_FILE` points at: a `DATABASE_URL` for a `_e2e` database plus the
`E2E_*` role accounts; see `e2e/README.md`). The build is the same `.next`:

```bash
PORT=3206 ENV_FILE=<e2e env file> bun run phone:rig up
E2E_ENV_FILE=<e2e env file> E2E_BASE_URL=http://localhost:3206 bun run e2e:phone
E2E_ENV_FILE=<e2e env file> E2E_BASE_URL=http://localhost:3206 bun run e2e:phone -- count-flow   # one spec
PORT=3206 bun run phone:rig down
```

- Global setup signs each role in **from the laptop** and saves the cookies;
  each test then opens a fresh, incognito-like context on the phone with that
  state. Your own Chrome sign-in on the phone is untouched.
- Tabs open and close on the phone while it runs. **Keep the screen on and
  unlocked** and leave Chrome in the foreground. A sleeping phone stops
  rendering and every test dies on its 60 s timeout, so `e2e:phone` checks
  over adb first and refuses to start (exit 2) if the screen is off or locked.
  The screen can still time out mid-run; Developer options → Stay awake
  (while charging) prevents that.
- `count-flow` resets every count in that `_e2e` database before and after
  itself. Never point it at a database you care about (the suite refuses any
  name not ending `_e2e`).
- Office-only specs (`office-catalog`, `vendors-retire`) are not run on the
  phone, as in the emulated mobile project. The phone runs the same 39 tests
  as `e2e:mobile`.
- The soft keyboard is neutralised for the phone project only: each test
  context sets `navigator.virtualKeyboard.overlaysContent = true`
  (`e2e/support/fixtures.ts`). Without it, focusing a field makes Chrome pan
  the visual viewport (236 px on the Pixel) while Playwright still clicks by
  layout coordinates, so the first click after a `fill` misses — the login
  specs time out waiting for a sign-in POST and the trace shows a label
  "intercepting" the button. A person's tap was never affected; this is a
  harness-over-CDP problem, not an app defect.
- Failure screenshots include one per tab already open in the phone's
  Chrome (the CDP default context); the test's own page is the last one.

**Result, 2026-11-10 (Pixel 10 Pro XL, Chrome 156, this branch's build):
39/39 passed in 2.9 min**, including all of `count-flow` (the #46a
Finish-section warning, the #46b Submit gate, the queue draining without an
`online` event). Desktop 33/33 and emulated mobile 39/39 on the same build.

### #29 — accessibility on the counting screens

With the phone signed in and showing a counting screen:

```bash
bun run phone:a11y -- --origin http://localhost:3204
```

It attaches to the DevTools forward the rig made (`PHONE_CDP`, default
`http://127.0.0.1:9333`). It reads the screen the phone is already on — it
navigates only if given `--path /x`, and never clicks or types — and walks
focus with Tab (stopping if a password field takes focus), then reports:
a visible focus ring on every stop, heading levels that skip, icon-only buttons
with no accessible name, and tap targets under 44 px (WARN, not FAIL). Exit 1
on any FAIL; a screenshot lands in `.phone-sessions/`. Run it once per screen:
`/count`, the section picker, the scan/leg screen, the quantity editor, the
fill (tenths) editor, and the session page with Submit.

### #46 — the pending-write drills

Each drill is a count in progress, with writes made while the server cannot
take them. **Watch for**, on the leg screen, the sync chip showing pending
writes and the "not synced" warning beside **Finish section** (46a); on the
session page `/count/<id>`, **Submit count disabled** while anything is pending
(46b), enabling once it drains.

1. **Server unreachable, phone online** (the F3 shape — retries, not the
   `online` event, must drain it). `bun run phone:rig server-down`; on the
   phone enter two or three quantities; check the chip, the Finish warning and
   the disabled Submit; `bun run phone:rig server-up`; within ~15 s the queue
   drains, Submit enables, and the lines are in the database with no
   duplicates.
2. **Real offline.** Phone Wi-Fi off (mobile data off too — a cellular
   fallback is "online"); enter quantities; Wi-Fi on; the queue drains on
   reconnect. Then re-run `bun run phone:rig up` — adb needs a new port.
3. **Leave and come back.** With writes pending, go to `/count/<id>`: Submit
   must stay disabled until the drain. (The retry timer lives on the scan
   screen only — whether the session page waits forever is what this checks.)

---

## 1. Preflight — on the phone, before walking anywhere

Open **`/count/preflight`** and read it. This is the step that turns "walk to
the bar, start counting, discover it is broken" into five seconds. The
**Origin** row runs server-side and is checked first — if it fails, nothing
below it can be trusted yet.

| Row | Expected | If not |
|---|---|---|
| Origin | **Allowed** | The `Host` header isn't in the allowlist — almost always because the app was brought up with plain `docker:up` instead of `docker:up:lan`, which silently reverts a live LAN session (open-items.md #24). The page still renders 200; every `/_next/*` chunk 403s and nothing on the page responds. Confirm with `docker compose exec -T app env \| grep DEV_LAN_ORIGIN` — empty is the tell — then `bun run docker:up:lan`. |
| Secure context | **Yes** | You are on the http URL. Reload on `https://…:3443`. Camera is impossible until then; search-only counting still works. |
| Camera API | **Present** | Downstream of secure context — fix that first. |
| Barcode decoder | Native *or* WASM polyfill | Polyfill is fine; the **first** scan is slow. Do not read that as a stall. |
| Write ids | either value | Both are fine. The fallback is expected on a plain-http LAN origin. |
| Offline queue | **IndexedDB ready** | Usually private browsing. Counted lines would be lost on a drop — fix before Run C. |

Then tap **Test camera** and grant permission. Note whether torch is supported:
no torch in a dim bar changes what a slow scan means.

**Do not proceed with any red row.** Every one of them fails later in a way
that looks like something else.

---

## 2. The three runs

They are separate on purpose and measure different things. Running them as one
pass produces a number that means nothing.

### Run A — the enrollment pass

**What it measures: the scan-to-enroll form, which is the highest-risk
interaction in the MVP.**

The catalog ships with `upc` deliberately blank — 97 products, zero barcodes.
So on a first pass *every* scan is an unknown barcode and opens the enroll
form. That is the intended design, and it means **Run A is not a speed test of
counting.** The 20-minute target does not apply here.

CLAUDE.md's budget for the enroll form is **under 20 seconds**, because if it
gets slow the catalog decays and the whole system dies with it.

Do this:

1. Pick one location and stay in it. Count 15–20 bottles.
2. Time the enroll form specifically — barcode detected → back to counting.
3. Record every field you had to think about, and every one you left blank.

Record: median and worst enroll time, how many scans failed to read first try,
and whether the form ever felt like it needed the other hand.

> **Known gap, read before starting.** Enrolling creates a **new product**;
> there is no "attach this barcode to the existing catalog row" path
> (`createProductAction` is the only enroll action). Scanning a bottle that is
> already one of the 97 seeded products therefore creates a duplicate rather
> than filling in its `upc`. For Run A on a throwaway local database that is
> harmless — but it means the catalog you build here is not reusable, and at a
> real bar the first count would duplicate the entire catalog. Tracked as
> open-item #16.

### Run B — the speed pass

**What it measures: the sub-20-minute claim the whole design is justified by.**

Only meaningful once barcodes resolve. Either follow Run A with a second pass
over the same bottles, or enrol first and count second.

1. Full count, all six locations (including Tap 1), start to *Finish section* on
   the last one.
2. One stopwatch, running the whole time, including walking.
3. Count normally. Do not be careful for the benefit of the test.

Record: total wall time, per-location split, and — separately — how long you
spent *not* counting: waiting on the camera, retyping, hunting for a product,
recovering from a mistake. That second number is the one that tells you what to
fix.

Also note, because both are design claims and neither has been tested:

- **The locked location.** Did you ever want to switch mid-leg? Did the "count
  something elsewhere" escape hatch come up, and did it return you to the right
  leg? A wrong active location fails *silently* — the total stays right and
  only the distribution is wrong.
- **The SET/ADD button.** It states the consequence as you type
  (`SET TO 3 EA / was 12 ea · −9`). Did you actually read it? It is the only
  guard against a SET that was meant as an ADD, and that mistake is invisible
  afterwards — the line just reads `3 ea` either way.

### Run C — the offline queue

**What it measures: open-item #9, the thing that has only ever been reasoned
about. It was already wrong once — the original queue had no drain path.**

Walk-ins are metal boxes and routinely kill Wi-Fi, so this is not a synthetic
test. Do all four:

1. Turn Wi-Fi **off**, count three bottles. The rows should still appear and a
   chip should read "3 pending".
2. Turn Wi-Fi **on**. Confirm the queue drains without a reload.
3. With writes queued, **kill the app**, reopen it, confirm the mount-time
   flush sends them.
4. **The one that matters most:** make a write that reaches the server *just*
   as the connection drops, then let the queue resend it. It must not apply
   twice. This is what `client_line_id` exists for, and preventing this exact
   double-count is why the ledger was built.

Verify #4 against the database rather than the screen:

```bash
bun run db:shell
```
```sql
-- One row per (count, product, location). More than one is invariant 3 broken.
SELECT count_id, product_id, location_id, COUNT(*) c
FROM count_line GROUP BY 1,2,3 HAVING c > 1;

-- The ledger should show one row per write ATTEMPT, with signed deltas that
-- sum to the line's current quantity.
SELECT client_line_id, delta_each, delta_case, created_at
FROM count_line_write ORDER BY created_at DESC LIMIT 20;
```

---

## 3. Recording a run

Keep it in the same place each time — a run that is not written down is an
anecdote. Minimum:

```
Date / phone / browser:
Origin used:
Preflight: all green?  (note any amber)

Run A  enroll median ___s   worst ___s   failed scans ___/___
Run B  total ___min   Speed Rail ___  Back Bar ___  Wine ___  Walk-In ___  Storeroom ___
       time not counting: ___min   what caused it:
Run C  1 ☐  2 ☐  3 ☐  4 ☐    duplicate rows found: ___

Bet 1  enroll field set fits 20s      held ☐  failed ☐   which field ate it: ___
Bet 2  SET/ADD consequence line       held ☐  failed ☐   unintended SETs in ledger: ___
Bet 3  persistent sync pill           held ☐  failed ☐   did you ever look at it: ___
Bet 4  one card per product           held ☐  failed ☐   scroll-backs per leg: ___

Broke:
Slow but worked:
Wanted and missing:
```

The four bets are §6 — read what each one is actually asking before the run, and
what the *permitted* fix is if it fails. Two of them have a fix that is
explicitly ruled out in advance.

---

## 4. Triage — failure signatures

Every entry here has already happened at least once. Match the symptom before
theorising.

| Symptom | Cause | Fix |
|---|---|---|
| "Sign-in failed. Check your email and password." on a **correct** password | Origin not in Better Auth's `trustedOrigins` — returns 403, reported generically on purpose | `docker:up:lan` sets it. Confirm the origin matches including port. |
| Nothing on the page responds; server returns 200 | Not hydrated. Historically a CSP without a nonce, or Next dev blocking `/_next/*` for an unlisted host | Check the submit button on `/login`: still disabled after load = not hydrated. Add the host to `allowedDevOrigins`. |
| **"The login page just refreshes when I submit"** / nothing on the whole page responds, on the phone specifically | `DEV_LAN_ORIGIN` is empty — the app was brought up with plain `docker:up`, which silently reverts a live LAN session back to loopback-only. Every `/_next/*` chunk 403s for the phone's origin; with no hydration the login form's `onSubmit` never attaches, so the browser falls back to a native GET — which presents as a refresh, not as "JavaScript is broken." | Confirm with `docker compose exec -T app env \| grep DEV_LAN_ORIGIN` — empty is the tell. Re-run `bun run docker:up:lan`, not `docker:up`. Then **clear the phone's cached copy of the page** before retrying (see note below) — a plain reload can still show the cached, 403'd chunks and look like the fix did nothing. Check the preflight **Origin** row first next time. |
| Scan screen: "camera needs a secure origin" | Working as intended — the origin is plain http | Reload on `https://…:3443` and accept the certificate. |
| Certificate warning on the https URL | Expected — self-signed, names the LAN IP | Advanced → Proceed. Once per phone. |
| https 502s while http works | nginx cached a stale container IP after the app was recreated | Should not happen — nginx re-resolves per request. If it does, `docker compose restart tls`. |
| Scan screen: "Camera access was blocked" | Permission denied and remembered per-origin | Clear it from the ⚠ icon in the address bar. |
| `crypto.randomUUID is not a function` | Fixed 2026-07-28 — secure-context-only API on a plain-http origin | Should not recur; `newWriteId` falls back to `getRandomValues`. If it does, the fallback was removed. |
| First scan takes seconds, later ones are fast | The ZXing WASM polyfill loading on demand | Not a bug. Preflight says which decoder you have. |
| Count total right, distribution wrong | Counted a leg into the wrong active location | Locked-location design exists to prevent this; report it as a design failure, not user error. |

**A note on the console.** Chrome reports CSP violations through a channel the
devtools console API does not carry, so a clean console proves nothing about
CSP. Trust the hydration check, not the absence of red text.

**A note on the phone's cache.** Once a chunk has 403'd, the phone can keep
serving that cached failure even after `docker:up:lan` fixes the origin — a
plain reload does not guarantee a re-fetch. Clear site data for the LAN IP
(Chrome: the ⓘ icon in the address bar → *Site settings* → *Clear data*) or
open the URL in a private tab before deciding the fix did not work. Without
this step the re-fetch looks identical to the fix having failed.

---

## 5. Reset between runs

Run A pollutes the catalog with duplicate products by design. Start clean:

```bash
bun run docker:reset      # wipes the volume, re-migrates, re-seeds
```

Then recreate the user — `docker:reset` drops accounts too.

To reset only the counts and keep the catalog:

```sql
DELETE FROM count_line_write;
DELETE FROM count_line;
DELETE FROM count;
```

Never edit a **closed** count to clean up (invariant 1). Delete the rows or
reset the volume.

---

## 6. The four Phase 2 bets these runs settle

**Added 2026-08-14, at the close of Phase 2 (PR #13).** The UI redesign shipped
*before* any of the measurements below existed — that was the deliberate cost of
re-sequencing field validation from Phase 1.9 to 2.9. Phase 2's Gate 1 required
that every design decision which is really a **bet about where count time goes**
be written down here before the phase closed, so these runs settle them instead
of the next person re-arguing them from scratch. All four are presentation-layer
by construction: none touches the schema, the write path, or the leg model, so
falsifying any of them costs a component or a copy change, never a migration.

Record the verdict for each one in §3 alongside the timings. "Felt fine" is not
a verdict; say what you observed.

**Bet 1 — the enroll form's field set fits the 20-second budget.**
The form uses preset lists (size, category, unit type) rather than free text,
and the bet is that the current field count is achievable in 20 seconds without
cutting anything. **Run A settles it** — that is exactly what Run A measures.
*If it comes in over budget, the fix is cutting a field or widening a preset
list. It is never adding a free-text field.* A free-text size box accepts a
plausible wrong answer from someone who is not expected to check it, which is
the draft-keg-default lesson in `AGENTS.md` — and the reason there is
deliberately no "Other…" escape on the size list today. Also note *which* field
the time actually goes into; the assumption is that it is the search step added
on 2026-07-30, and that has never been checked.

**Bet 2 — a visible consequence line is enough friction on SET/ADD.**
The submit button states the outcome as you type (`SET TO 3 EA / was 12 ea ·
−9`, or `ADD 3 EA / 12 → 15`) instead of putting a confirmation dialog in front
of it. The bet is that seeing the consequence catches the mistake without
costing a tap. **Run B settles it** — deliberately do a SET on a line that
already has a quantity, mid-count, at pace, and see whether you read the button.
Better: check the ledger afterwards for a SET whose delta you did not intend.
*If mis-taps happen, the fix is copy or emphasis — not a modal.* A dialog on a
control used 150 times a count gets clicked through blind inside a week, which is
worse than no guard because it feels like one (`AGENTS.md`).

**Bet 3 — a persistent sync pill beats a toast.**
Pending-write state shows as a pill that is always on screen (`Synced`,
`1 pending`) rather than a toast that appears and leaves. The bet is that a
counter needs sync state available at a glance without it stealing attention
from the count. **Run C settles it**: the question is not whether the pill is
*correct* — that was observed working on 2026-08-12 — but whether anyone
actually looks at it while counting, and whether a number that sits at
`3 pending` for a minute reads as "working" or as "broken". If it is ignored
entirely, that is a finding, not a null result.

**Bet 4 — one card per scanned product is worth its vertical space.**
"Just counted" is a list of cards separated by `card-gap`, not a dense table
row. The bet is that browsing what you just counted as cards is worth the
scrolling it costs across a six-location walk. **Run B settles it**, and the
signal is specific: how often you scroll back to check something you already
counted, and how far. This one interacts with the floating bottom bar — the bar
exists precisely *because* this list grows past a viewport — so judge them
together rather than separately.

**One thing that is not a bet, and is simply unverified.** The entire redesigned
counting surface has never been opened on a phone. `count-leg.tsx`,
`fill-entry.tsx`, `quantity-entry.tsx`, `count-line-card.tsx`,
`barcode-scanner.tsx`, `catalog-search.tsx` and `tab-bar.tsx` all changed in
Phase 2, and the only thing anyone has looked at is a desktop browser window
narrowed to 400 px. Every phone-verified fact in `STATE.md` — the fill pad, the
camera enrolments, the offline chip — predates this rebuild and is evidence
about the mechanisms underneath, not about the screens that ship today. Open
item **#20** carries the full list of what to exercise.

---

## 7. When Phase 2.9 is done

**Status, 2026-11-07: not started as a protocol run.** Two phone sessions
(2026-10-25 and 2026-11-06) used the redesigned screens. Neither was Run A or
Run B, and none of the §6 bets has a verdict. The status of each item is in
`docs/open-items.md` #48.

**This file is Phase 2.9's protocol.** Re-sequenced 2026-08-12 and again
2026-08-13 (1.9 → 2.9, now after the UI redesign and OCR): these runs used
to be Phase 1's exit criteria, and were deferred to a phase of their own so
Phase 1 could close on construction. Nothing about the runs changed — only when
they happen. From `ROADMAP.md`, and none of it is a code question:

- A full count runs on a phone in **under 20 minutes** (Run B).
- Weekly counts happen without anyone being nagged.
- The numbers are trusted enough to act on.

Two decisions should come out of these runs rather than out of a discussion:

- **Rapid-scan mode** (open-item #10) — `scanCountLine` is built and
  unreachable. Sealed backstock is 60–75% of units and always quantity 1, so
  the entry screen may be pure overhead. Decide against Run B's numbers, and if
  the answer is no, delete it.
- **Open vs sealed split** (CLAUDE.md open question 3) — Run A and B finally
  produce the real ratio, which is what the counting-speed estimates depend on.
