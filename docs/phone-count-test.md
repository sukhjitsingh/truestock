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

1. Full count, all five locations, start to *Finish section* on the last one.
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

Broke:
Slow but worked:
Wanted and missing:
```

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

## 6. When Phase 1.9 is done

**This file is Phase 1.9's protocol.** Re-sequenced 2026-08-12: these runs used
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
