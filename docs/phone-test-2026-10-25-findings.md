# Phone test findings — 2026-10-25

First manual count on a real phone against the **main database**, on the merged
Phase 2.5 build (`52c5901`, PR #30). This document is the post-test analysis:
what the test wrote to the DB, what the DB shows is broken or missing, and (§5
onward) what the UI needs to be easier on a phone.

| | |
|---|---|
| Build | `52c5901` (main, via `bun run docker:up:lan`) |
| Device | Android 10, **Brave** (reports itself as Chrome 155), over `https://192.168.12.33:3443` (secure context, camera on) |
| Database | `truestock-mariadb` (the main DB, not the worktree-test DB) |
| Tester | owner (`owner@truestock.local`) — the only user that exists in this DB |
| Times | DB is UTC; local was UTC−7 (the Mac reports MST). Both shown where it matters |

How the numbers were gathered: read-only SQL (`SET SESSION TRANSACTION READ ONLY`)
against the running container, plus the app and nginx logs. Nothing was written,
deleted or migrated by the analysis. UI evidence is split: §5 comes from the code
and the logs, §6 from the screen recording.

---

## 1. Headline

The **counting loop works on a phone**: scan-to-enroll, search picker, per-location
entry, finish and close all completed, and the data it left behind is clean — no
orphans, no duplicate ledger ids, no cross-tenant rows.

The **valuation side is where this falls over**, and it fails quietly:

1. Every closed count in the DB is valued **$0.00** because no count line has a
   cost snapshot. The detail page flags the excluded lines, but the Close button,
   the hub and the stored record show a bare $0.00 that reads as a real answer
   (§3, DB-1).
2. The two invoices that were **approved posted zero costs**, with no signal to
   the approver. The cause is a missing `pack_size` that the reviewer has no way
   to supply (§3, DB-2).
3. The same invoice file was uploaded twice and **approved twice** (§3, DB-3).

These three together mean the app currently cannot produce a valued inventory
from supplier invoices, which is its stated purpose. Counting is ahead of costing.

On the phone UI (§5, §6): the loop is fast and the core screens are well sized, but
three things can lose or hide a number — **Save drops a fill level that was chosen
but not added** (V1), the **tab bar is live during entry** (A18), and **Submit and
Close have no pre-flight** (A20). The navigation changes that save the most taps
are landing the owner and manager on `/count`, deep-linking the location chevron
and Resume, and a *Review and submit* step after the last leg (§5.3).

---

## 2. What this test wrote

Count #3 is the phone test. Everything else is older (2026-08-23) test data.

| Local (UTC−7) | UTC | Event |
|---|---|---|
| 19:14:00 | 02:14:00 | Phone sign-in (session 5, Android UA). Session 4 is my `curl` login check |
| ~19:14–19:17 | | ~3.5 min browsing the back office before starting (from the request log) |
| 19:17:39 | 02:17:39 | Count #3 started |
| 19:18:12 | 02:18:12 | Barcode `080480280048` enrolled → Grey Goose |
| 19:18:22 | 02:18:22 | Line 5: Grey Goose, **Storeroom**, 2 ea |
| 19:18:55 | 02:18:55 | Barcode `08200802` enrolled → Smirnoff |
| 19:19:00 | 02:19:00 | Line 6: Smirnoff, **Storeroom**, 1 ea |
| 19:20:02 | 02:20:02 | Line 7: Four Roses, **Speed Rail**, tenths `[0.3]` |
| 19:20:22 | 02:20:22 | Count #3 **closed** (2 m 43 s after start), `total_value = 0.00` |

Rows added by the test: 1 `count`, 3 `count_line`, 3 `count_line_write`,
2 `product_barcode`, 2 `session`. Nothing else changed (no product, vendor, user
or invoice rows).

Pace: 43 s from start to the first line, then 38 s and 62 s between lines. From
barcode enroll to the line being written: 10 s and 5 s. Four Roses has no barcode
row, so it was almost certainly found through the search picker (inference — the
DB does not record how a product was chosen).

## 2a. Integrity checks (all pass)

| Check | Result |
|---|---|
| Count lines with no ledger write | 0 |
| Closed counts with no `closed_at` | 0 |
| Count lines whose org differs from their count's org | 0 |
| Ledger rows vs distinct `client_line_id` (all 3 counts) | 7 = 7, 7 distinct |
| Ledger writes dated after their count's `closed_at` | not checked (the last write of each count is before its close time by inspection) |

`count_line_write` is one row per write attempt with a fresh id, as AGENTS.md
requires. Note what this test did **not** exercise, because it cannot be seen as
a pass: every line was created once, so there was no second scan of the same
bottle (the increment path behind invariant 3), no SET/ADD edit and no retry. The
SET/ADD before/after button and the offline queue are therefore still unproven on
a phone.

---

## 3. DB findings

Severity: **H** = produces wrong or silently missing numbers · **M** = will bite
within weeks of real use · **L** = hygiene.

### DB-1 (H) — Every count is valued $0.00, and $0.00 is indistinguishable from "unknown"

All 7 count lines across counts #1–#3 have `unit_cost_at_count = NULL` and
`case_size_at_count = NULL`; all three closed counts have `total_value = 0.00`.
Only **9 of 97** products have a cost — all seeded kegs (Beer: 9 of 25 costed;
Spirits 0 of 62, Wine 0 of 5, Liqueur 0 of 2, NA 0 of 3). None of the bottles
counted in the test has a cost.

The snapshot behaviour itself is right (invariant 2 — NULL is stored rather than
a guess). The problem is what the number then says: a count reading **$0.00** is
the "plausible-but-wrong" failure AGENTS.md calls the worst mode, because a reader
cannot tell "worth nothing" from "not costed yet".

The app already half-handles this, which narrows the fix. The count detail page
says `No cost on file — excluded from valuation` on each line
(components/count/count-line-card.tsx:130) and `N excluded from valuation` on the
progress card (components/count/progress-card.tsx:62–65), fed by
`excludedLineCount` from `summarizeValuation` (lib/domain/valuation.ts:99–130).
The gap is every place that shows **only the number**:

- the **Close count button** — `ActionBarPrimary` renders `formatMoney(value)`
  whenever `value != null`, and `0` is not null, so an owner sees `$0.00` on the
  one irreversible control (components/ui/action-bar.tsx:47–62,
  components/count/session-actions.tsx:167);
- the count hub (app/(count)/count/page.tsx:147–154, progress-card.tsx:31–35);
- the closed record itself — `count.total_value` is persisted as `0.00` and the
  excluded-line count is not stored with it, so after close the row alone cannot
  say the value is partial (the per-line NULL snapshots still allow recomputing).
  The closed-count list under `/office/counts` was not checked.

Fix: pass `excludedLineCount` to the Close button and the hub, show
`$0.00 · 7 of 7 lines uncosted` (or `—` when nothing is costed) in warning colour,
and keep storing NULL on the lines.

### DB-2 (H) — Approving an invoice posted no costs, and nothing told the approver

Invoices #1 and #2 are both `approved`, with 8 lines matched (manually) to
Black Velvet, Grey Goose and Maker's Mark. `product_cost_history` has **0 rows**
and none of those products has a cost. Every line has `raw_net` populated
(131.88, 59.98, 0.00, 168.00 — and the header total 359.86 reconciles) but
`pack_size` is NULL on all eight, so `deriveUnitCost` (`raw_net / qty /
pack_size`) returns null and `approveInvoice` skips the line. Skipping is the
designed "never guess" behaviour. Three things make it a bug rather than a rule:

- **The reviewer cannot fix it.** `pack_size` is only ever set by extraction:
  `parsePackSize` (lib/domain/extraction-pipeline.ts:489) matches only a pack
  column that starts like `12/750ML` or `6x…` (`^\d+\s*(/|x|×)`). This vendor's
  layout prints `1.0L • 6 Cas…`, which does not match. There is no reference to
  `packSize` in `app/actions/**` or `components/**` — the review form has no
  pack-size field.
- **The approver is never told.** `approveInvoiceAction` returns
  `costLinesApplied`, but `handleApproveCosts`
  (components/office/invoice-review-form.tsx ~359–375) discards it and just calls
  `router.refresh()`. Approving an invoice that priced 0 of 4 lines looks
  identical to one that priced 4 of 4.
- **Line 3 is a legitimately free line** (`raw_gross 42.00`, `raw_discount 42.00`,
  `raw_net 0.00`). It can never derive a cost and should be shown as "free goods",
  not as a failure.

Fix, in order: (1) show `costLinesApplied` of N on approve and on the invoice
page ("2 of 4 lines costed — 2 need a pack size"); (2) a pack-size input on the
review line, required to cost a case line; (3) widen `parsePackSize` for this
vendor's format once the owner confirms what `6 Cas…` means. Do **not** default
`pack_size` to 1 for `each` lines to make the number appear — `db/schema.ts`
states "NULL means not determinable, never 1", and a bottle priced at a case
price is exactly the plausible-but-wrong failure.

### DB-3 (M) — The same invoice was accepted twice

Invoices #1 and #2 have the same `file_sha256` (`48001976e862…`), invoice number
`5402426`, date `2026-02-02` and total `359.8600`, and both are `approved`
(#1 with `vendor_id` NULL, #2 with Southern Glazer's). The `invoice` table has no
unique index on `(organization_id, file_sha256)` or on a vendor + invoice number;
`file_sha256` is used only to verify the stored file. `docs/open-items.md` has no
duplicate-invoice item.

Today this is harmless because nothing posts costs (DB-2). Once pack size is
fixed, re-uploading a file posts a second `product_cost_history` row.

Fix: on upload, look up the sha for the org and warn ("already uploaded as #1,
approved") with an explicit override; add a non-unique index on
`(organization_id, file_sha256)` first, and decide separately whether
`(organization_id, vendor_id, invoice_number)` should be a hard unique.
Also worth a look: #1 was approved with no vendor — check whether approval
should require one.

### DB-4 (M) — Count #3 closed with 4 of 6 locations never visited

Lines exist only in Storeroom and Speed Rail. Back Bar, Wine Rack, Walk-In and
Tap 1 had nothing counted and the count still closed — immutably (invariant 1).
For this test that was intended; the question is whether the UI says so before the
irreversible step. See §5 (close-flow) for what the code does.

### DB-5 (M) — `case_size` is NULL on all 97 products, including the 16 bottled beers

AGENTS.md is explicit that liquor correctly has no case size and that only the 16
bottled beers need one. They currently have none, so a sealed-case count of beer
is indeterminate (`computeLineUnits` returns null for `sealed_case_qty > 0`). The
test counted only spirits so this did not show. It is a catalog onboarding task,
not a code change — fill the 16 rows before the first real beer count.

### DB-6 (L) — Scan-to-enroll worked; barcode `format` is not recorded

Two barcodes were enrolled and then counted within 10 s and 5 s. `080480280048`
is a 12-digit UPC-A and `08200802` an 8-digit UPC-E. `product_barcode.format` is NULL on both; storing the detector's format
string would make scanner problems diagnosable later. Low priority.

### DB-7 (L) — Only the owner exists in this DB; correct an earlier suggestion

The main DB has one user, the owner. I earlier implied the `CHECK_MANAGER_*` /
`CHECK_STAFF_*` logins from `.env.local` could be used against this stack — they
cannot, because those accounts do not exist in this database. So the role-gating of
cost and margin (invariant 8) was **not** exercised on the phone. To get that
pass, create the accounts with the `create-user` command shown in
`docs/phone-count-test.md` (`docker compose exec -T app bun run create-user -- …`).

### DB-8 (L) — Invoice #3 could not be extracted; extraction times need a look

Invoice #3 (a scanned PDF) failed with `ANTHROPIC_API_KEY is not set; it is
required for scanned, mixed, or image-based invoice extraction`, and was rejected
with reason `test`. Text PDFs work (jobs #1 and #2 `done`, no model tokens
used). The two text-PDF jobs took 96 s and 123 s from `created_at` to
`completed_at` for a single page — that is long for a local parse; it may just be
the worker's poll interval or dev-mode compile, but it is unverified and worth
timing on a production build before deciding the "20–25 invoices in 30 minutes"
metric is reachable.

### DB-9 (L) — Test-data hygiene

Test rows from today: count #3, lines 5–7, ledger 5–7, barcodes 1–2, sessions 4–5.
Older: counts #1–#2, invoices 1–3, vendors 1–2, sessions 1–3 (2026-08-23). A
restore point from before the test is at
`/Users/moni/Claude_Workspace/truestock-db-backups/truestock-main-pre-phone-test-2026-10-25.sql`.
Nothing was deleted. Session 4 is the harmless `curl` sign-in used to check the
login. If you want a clean slate for the next test, restore that file rather than
deleting rows by hand (closed counts are immutable by design).

---

## 4. Not verified by this test

- Second scan of an existing line (increment), SET vs ADD, and the live
  before/after button.
- Offline queue and retry (all ledger rows are first-attempt).
- Manager and staff roles; cost hiding for non-owners.
- Android system Back, and a tab-bar tap with an unsaved entry (A18, A19) — the
  recording shows the bar present, not the loss (§6.4).
- The stray-bottle sheet.
- Camera behaviour in poor light, torch, and decode speed.
- Costed valuation of a count (no costs exist).
- Production build behaviour: the stack was `next dev`, so first-hit page
  latencies (0.6–2.3 s) are not representative; steady-state server actions were
  38–125 ms.

---

## 5. UI and navigation — from the code and the logs

A read-only audit of the count app and its entry points (45 findings: 6 H, 20 M,
19 L). The full list, with file and line for each, is **Appendix A**; items are
referred to below as A1–A45. I spot-checked the highest-impact ones against the
source myself (A18, A19's missing `popstate`, A20, A22, A23, A24, A33, and the
`$0.00` Close button); the audit's own "unverified" marks are kept — they need a
real handset; §6 settles some of them from the recording and §6.4 lists the rest.

### 5.1 How the test actually moved through the app

What §2 shows (DB rows and the request log), read as a user journey:

- The owner signs in and lands on **`/office`**, not the count app (`app/page.tsx:15`
  sends everyone except `staff` to `/office`).
- About **3.5 minutes** pass in the back office before the count is started.
- Start to close was **2 m 43 s** for three lines; 43 s to the first line, then
  38 s and 62 s between lines. The two enrolls took 10 s and 5 s from barcode to
  saved line, well inside the 20 s budget.
- Only two of the six locations were touched (Storeroom, Speed Rail), and the count
  was then closed (DB-4).

Taps to the first scan, from the code: staff — sign in → Start a count → pick a
location → Scan (3 taps). Owner or manager — the same, **plus finding the Count link
in the office rail** (`components/office/office-rail.tsx:259–267`), 2–3 extra taps.
The count app has a Reports tab that returns to `/office`, so the route exists in
both directions; it is just not the default for the person holding the phone.

### 5.2 Highest-impact problems

These can lose data or hide a wrong number, ordered by how likely they are to bite.

1. **The bottom tab bar is live during entry and bypasses the discard guard (A18).**
   `CountTabBar` is rendered by the layout for every phase and its tabs are plain
   `<Link>`s, so one stray thumb tap on Catalog or Account throws away an unsaved fill
   level or quantity with no prompt. Commit `f7fd608` fixed exactly this for the
   in-screen Back chevron (`requestLeave`, count-leg.tsx:586–599) and missed this
   route. Fix: hide the tab bar unless the phase is picking/counting.
2. **Android's system Back leaves the scan screen from any phase (A19).** Phases are
   component state and there is no `popstate`, `pushState` or `beforeunload` anywhere
   under `components/` or `app/`, so Back (the most natural one-handed gesture)
   exits mid-entry instead of stepping back. Not exercised in the
   recording (§6.4) — test on the handset. Fix: push a history entry per phase and map `popstate` to
   `requestLeave`.
3. **Submit and Close count have no pre-flight (A20).** Nothing warns about unvisited
   locations, uncosted lines or a zero total, and closing is irreversible. Count #3
   closed with 4 of 6 locations untouched (DB-4) and a `$0.00` on the button (DB-1).
   AGENTS.md rules out confirmation modals for frequently-used controls; this is a
   once-per-count action, so an inline panel is in keeping: "2 of 6 locations counted
   — not started: Back Bar, Wine Rack, Walk-In, Tap 1 · 3 of 3 lines uncosted",
   with a second tap on "Close anyway".
4. **A normal Save gives no visible confirmation (A21).** The only announcement is
   `sr-only` and only for a re-scan (count-leg.tsx:543–550, 882–884); the new line is
   appended to the "Just counted" list, probably below the fold. In a dim bar,
   one-handed, "did that save?" has no on-screen answer except an 11px indicator.
   Fix: a short non-blocking "Saved — Jameson 750 · 3 ea" banner and newest-first
   ordering. (The recording softens this for a short list — §6.3. The ordering claim is from
   the audit, not re-checked.)
5. **Tapping a search result in *link to existing* attaches the scanned barcode
   immediately, with no confirm and no undo (A22,
   `components/count/enroll-form.tsx:291–298`).** A mis-tap persists a wrong UPC, and
   every later scan of that bottle resolves to the wrong product — silent,
   plausible and permanent, the failure AGENTS.md warns about. Fix: tap to select,
   then a 56px "Link 08200802 to Smirnoff" button; or a 5–8 s undo.
6. **The scanner takes the first barcode anywhere in the frame (A33).** The code's
   own comment says the aiming rectangle is "purely visual — detection runs on the
   whole frame" (barcode-scanner.tsx:252). With several bottles on a back-bar shelf
   the result is whichever the detector lists first. Fix: keep only results whose
   bounding box centre is inside the rectangle, or the one nearest its centre.

### 5.3 Making the workflow easier to navigate

Ordered by taps saved per count, smallest changes first:

| Change | Why | Ref |
|---|---|---|
| Send **owner/manager** to `/count` on a phone (or remember the last surface); keep `/office` for desktop | Removes 2–3 taps and a disorienting detour every session | A24 |
| Pass `?locationId=` on the hub's per-location chevron and on **Resume** | The chevron is labelled "Count Speed Rail" but lands on the picker; the detail page already does it right. 1 tap × 5 legs | A23 |
| After the last leg, show a 56px **Review and submit →** at the top of the picker | Today the only route to Submit is a caption-size back link; "where do I submit?" | A26 |
| Show **per-location progress on the detail page** (where Submit lives) | The hub has "N of M started"; the page you submit from does not | A29 |
| A **next step after Close** (*Back to counts* / *Start new count*) | The CLOSED badge and the "Immutable closed count record" panel do appear (§6.3), but nothing says what to do next | A27 |
| `loading.tsx` and `error.tsx` for the `(count)` group | No file exists; every tap on bar Wi-Fi freezes the old screen, and a thrown action shows Next's default error page | A32 |
| Search with no hits → **"Add as new product"** (name prefilled, no barcode) | Today it dead-ends — and AGENTS.md names house infusions and damaged labels as the reason the picker exists | A25 |
| Move the **Preflight** diagnostics link to Account; use icons not emoji in the header | A dev/handset diagnostic shown to every role at the same weight as the role pill | A30, A31 |

### 5.4 Making it friendlier on a phone

**Thumb zone and keyboard**

- Scanner **Close and torch are in the top corners** — the hardest place to reach
  one-handed, and Close is the only way out of the scanner (A6). Move a full-width
  *Search instead* to the footer and the torch to the bottom right.
- No `interactiveWidget` in the viewport export, and the save bars are
  `fixed bottom-0`, so with the keyboard up they may sit under it (A7, A8, A15).
  Unverified on device; test the stray-bottle sheet and quantity entry with the
  keyboard open. The enroll form's Save is at the bottom of a scrolling form after
  three native selects.
- Remove sits in the same row as *Update bottle* (A1); two primary-looking Save
  buttons share a tenths screen and it is unclear whether one discards the other's
  edits (A2, unverified).

**Input friction**

- Case counts cost ~5 taps because there are no quick-add chips; add `+6 +12 +24`
  and `enterKeyHint="done"` (A11).
- Search inputs lack `autocapitalize="none"`, `autocorrect="off"`, `spellcheck=false`
  and an accessible name, so Gboard may rewrite brand names; and search fires on
  every keystroke with no debounce or stale-response guard (A12, A13).
- The vial sets the fill on `pointerdown`, so a touch meant to steady the phone
  changes the level (A14) — a silent wrong default; set on `pointerup`.
- The enroll form must stay under 20 s (AGENTS.md); replace the size/pack native
  selects with segmented buttons for 750 / 1000 / 1750 ml (A15).
- The camera stream is torn down on every scan in non-rapid mode, so each tenths
  bottle pays a cold start (A28, unverified). Keep the stream alive for the leg.

**Legibility in a dim bar**

- Every Button label, the tab labels and the SyncIndicator are 11px uppercase (A37,
  A39, A40), and the live **SET/ADD before/after caption is 13px at 75% opacity**
  (A38) — the one line AGENTS.md leans on to prevent an ADD/SET mix-up should be the
  most readable text on the screen. Raise to 13px, full opacity, tint the delta.
- Give the SyncIndicator an icon so save/offline state is not carried by tiny text
  alone (A39); add `navigator.vibrate` on an accepted/refused scan (A34).

### 5.5 What to keep

Do not regress: 44/56px tap tokens and the 5-column tenths grid with Full/Half/Empty
presets; the hard-coded dark count layout and `dvh` units (no `100vh` anywhere);
the locked-location pill with the stray-bottle escape hatch; the inline discard row
(no modal); optimistic writes with the IndexedDB queue and a fresh `client_line_id`
per attempt; the self-hosted WASM scanner fallback and its specific secure-origin
message; row edit as a real button; and "link to existing" being search-first.

## 6. UI and navigation — from the screen recording

`phone-test-20261025-195126.mp4` — 243.7 s, 1344×2992, recorded in **Brave on
Android** (it reports itself as Chrome 155, so the browser name does not appear in
the DB's session user agent). Three parts: a tour of the back office (0–60 s), the
count itself (≈64–236 s: Storeroom and Speed Rail, two enrolls, search and link,
Submit, Mark reviewed, Close), and the dashboard afterwards (≈240 s). I reviewed the
whole video as frame sheets — one frame every 4 s throughout, every second around
Close, every 2 s around the scanner and the link flow. V1–V3 below were then checked
against the source or the DB; V4–V6 are visual only. Times are seconds into the
recording.

### 6.1 What the recording confirms

| Ref | What the video shows |
|---|---|
| **DB-1, A41** | The Close button reads **`CLOSE COUNT $0.00`** with no word about coverage, and the dashboard's "Last closed count" repeats a bare `$0.00`. The closed-count page itself does it right — "0 of 3 priced (0%)" and an amber panel saying excluded lines are "omitted from monetary totals, never valued at zero". The fix is to carry that wording to the button and the dashboard, not to invent new copy. |
| **A20, DB-4** | Submit → Mark reviewed → Close count is **three taps in about 15 s**. No step mentions the unvisited locations, the three uncosted lines or the zero total, and none asks for a second look before the irreversible one. |
| **A18** | The bottom tab bar is present on the section picker and on both the fill-level and the quantity entry pages, one thumb tap from Catalog or Account with a draft on screen. The recording shows the exposure; the tester did not tap it, so the loss itself is still unobserved. |
| **A2** | The tenths entry page is **4–5 screens tall**. "+ Add bottle to line" sits below the fold, and two save rows share the page (`SAVE FILL LEVELS` and `SAVE (0 EA)`). |
| **A12** (partly) | Gboard's suggestion strip ("Goose / Goosebumps") sits over the catalog search, so autocorrect is on for a brand-name field. Whether a term was actually rewritten was not seen. |
| §5.1 | The enroll and link flows are quick (10 s and 5 s in the DB). The keyboard opens by itself on the enroll and "Which bottle is this?" screens and covers the tab bar there. |

### 6.2 New findings — only visible on the recording

- **V1 `H` — Save drops a level that was chosen but not added.** On the tenths entry
  page a level is chosen, then a separate **+ Add bottle to line (N%)** button stages
  it. In the recording **Save fill levels was tapped with a level selected and that
  button still enabled**, and the line saved with only the one already-staged bottle
  (30%). The chosen level vanished with nothing on screen to say so.
  `components/count/fill-entry.tsx` confirms it: `handleCommitSave` saves `fills`
  (the staged list) only. The leave-guard treats the draft as unsaved, but Save does
  not. This is the AGENTS.md failure — a plausible total that is wrong — on the most
  used screen. Fix: while a level is selected, make the primary button **"Add 80% and
  save"** (stage and save in one tap), or disable Save until the draft is added or
  cleared.
- **V2 `M` — Dates show the server's UTC date.** A count started on Oct 25 at about
  19:14 local is shown as **"Oct 26, 2026"**. `formatDate` and `formatDateTime` in
  `lib/utils.ts` call `toLocaleString("en-US", …)` with no `timeZone`, from server
  components, and the containers run in UTC (checked: `docker exec truestock-app
  date`). Anyone west of UTC sees tomorrow's date every evening. For a count that is
  an audit record, the date is the record. Fix: store an organization time zone and
  format with it (or format on the client).
- **V3 `M` — An 8-digit barcode is stored raw.** The enrolled code `08200802` is an
  8-digit UPC-E / EAN-8 style code. The scanner's format list accepts both, and no
  code under `lib`, `components` or `app` expands UPC-E to UPC-A or normalises GTINs.
  *Unverified impact:* a later scan of the same product from a pack that carries the
  UPC-A form may not match, and a duplicate product gets enrolled. With DB-6 (the
  barcode `format` column is NULL) there is also no record of how the code was read.
  Fix: normalise to GTIN-14 on write and on lookup, and store `format`.
- **V4 `L` — Tenths for one bottle took about 45 s** with the scrolling. The tester
  was exploring, so this is not a clean timing, but it is the number to beat after
  the entry page is cut down to one screen (A2): vial, **Add bottle**, Save in view
  without scrolling.
- **V5 `M` — The screen is mostly chrome.** Brave's own bottom toolbar and address
  bar plus the app's header, its tab bar and the save bar leave about **70 % of the
  screen height** for content on the entry pages (my estimate from the frames).
  Hiding the tab bar during entry (A18) is also the cheapest height win; keep the
  save bar as the only fixed bar on those screens.
- **V6 `M` — The back office is not usable as-is on a phone.** The owner lands there
  first (§5.1) and it shows: the Catalog table is clipped at the right edge (only
  the stubs "CA…" and "Vo…" of the next columns show), Locations clips "Counting
  mode", Vendors clips "Method / Lead time / Actions" under the form, Invoices clips
  the vendor column, and navigation is an **icon-only rail** with no labels. This
  is admin work and desktop-first is a fair choice, but if the owner is going to
  open it on a phone, below about 640 px render rows as cards or keep the first
  column sticky with a scroll hint, and label the rail.

### 6.3 Where the recording softens §5

- **A21 (no visible Saved).** For a short list the new line card and a green
  **SYNCED** pill do appear straight away under the entry. So "no confirmation" is
  too strong: the gap is a **long list pushing the new line off screen**, and no
  banner that stays with the thumb. Keep the fix, lower the urgency (P1).
- **A27 (nothing after Close).** After Close the **CLOSED** badge and a green
  "Immutable closed count record" panel do appear, and the dashboard updates. What
  is missing is a next step — *Back to counts* / *Start a new count*.

### 6.4 Not exercised, so still unverified

Android system **Back** (A19) · tapping the tab bar with a draft (A18's loss) ·
re-scanning a product, and SET against ADD · the stray-bottle sheet · the offline
queue and retry · manager and staff roles and cost hiding · torch, poor light and
decode speed · a bottle with a case size. Test these on the handset before building
fixes that depend on them; A19 in particular is a **M**-sized change that should
wait for a real Back-button run.

### 6.5 What the recording says to keep

The empty default level ("—", "Tap a level below") rather than a preselected 50 % ·
the live before/after Save button (`SAVE (1 EA)  0 ea → 1 ea`) · the green SYNCED
pill · per-location PENDING and "2 COUNTED" chips on the hub · the locked-location
pill with "Count a stray bottle elsewhere" · the scanner (opens quickly, Close at
top left, torch at top right, a hint line, a "Rapid mode off" pill) · the newest-first
line list on the detail page · the "Immutable closed count record" panel and the
coverage caveat on closed-count pages · big tap targets and the dark theme.

### 6.6 Dev-only artefacts, not defects

The Next.js **"N" badge** (it overlaps the leftmost tab and the scanner hint) and the
**"Rendering…" pill** come from `next dev`. Re-check both on a production build
before counting them against the design.

## 7. Recommendations, in priority order

Effort is my estimate: **S** under half a day, **M** one to two days, **L** more.
The recording confirmed A18, A20 and A41, **added V1 to P0** (a silent drop), added
V2, V3 and V6 to P1, and softened A21 and A27 (§6.3). A19 is still unverified, so
its row says to test first.

### P0 — fix before the next real count (silent wrong numbers or lost input)

| # | Change | Effort | Ref |
|---|---|---|---|
| 1 | Show cost coverage next to every bare total: Close button, hub, dashboard, closed-count list; never a lone `$0.00`. Reuse the closed-count page's wording | S | DB-1, A41 |
| 2 | On approve, report `costLinesApplied` of N; add a **pack-size input** on the review line; widen `parsePackSize` for this vendor | M | DB-2 |
| 3 | Inline **pre-flight panel** before Submit/Close: unvisited locations, uncosted lines, zero total; "Close anyway" | S–M | A20, DB-4 |
| 4 | **Save must not drop a chosen level**: "Add N% and save" in one tap, or block Save while a level is selected but not added | S | V1 |
| 5 | Hide or guard the **tab bar** during entry and enroll (also reclaims height) | S | A18, V5 |
| 6 | Handle **Android Back** (history entry per phase) — *run it on the handset first, the recording did not exercise it* | M | A19 |
| 7 | Confirm before **linking a barcode** to an existing product (or add undo) | S | A22 |
| 8 | Warn on **duplicate invoice** (same sha / vendor + number); decide on a unique index | S–M | DB-3 |

### P1 — the phone workflow

| # | Change | Effort | Ref |
|---|---|---|---|
| 9 | Keep the saved state in view when the list is long: a short **Saved** banner, newest-first | S | A21 |
| 10 | Scanner: accept only the barcode in or nearest the frame | S–M | A33 |
| 11 | Land owner/manager on `/count` on a phone; pass `locationId` on chevron and Resume | S | A23, A24 |
| 12 | **Review and submit** CTA after the last leg; a next step after Close; per-location progress on the detail page | S | A26, A27, A29 |
| 13 | Show dates in an **organization time zone**, not the server's UTC | S–M | V2 |
| 14 | **Normalise barcodes** (UPC-E → UPC-A → GTIN-14) on write and lookup; store `format` | M | V3, DB-6 |
| 15 | Cut the tenths entry page to one screen: vial, Add bottle, Save in view | M | A2, V4 |
| 16 | Quick-add chips, search input attributes, debounce | S | A11–A13 |
| 17 | Search no-match → add a product without a barcode | M | A25 |
| 18 | Raise button, caption and SyncIndicator type sizes; icon on sync state | S | A37–A40 |
| 19 | Scanner Close/torch to the thumb zone; sticky Save rows; check keyboard overlap on device | M | A6–A8, A15 |
| 20 | Back office on a phone: cards or sticky first column under ~640 px; label the rail | M | V6 |

### P2 — polish

`loading.tsx`/`error.tsx` (A32), vial set-on-release (A14), keep the camera stream
alive across scans (A28), vibrate on scan (A34), `aria` fixes (A42–A45), move the
Preflight link and swap emoji for icons (A30, A31).

### Data and environment tasks (not code)

- Fill `case_size` on the 16 bottled beers before the first beer count (DB-5).
- Enter or import costs, and confirm what the vendor's `6 Cas…` pack text means
  so pack size can be derived (DB-2).
- Create manager and staff accounts in this DB to exercise the role gating on a
  phone (DB-7).
- Set `ANTHROPIC_API_KEY` in the dev stack if scanned/photo invoices are to be
  tested (DB-8); time invoice extraction on a production build (DB-8).

### Questions for you

1. Should an owner on a phone land on the count app, or does the owner want the
   back office first? (A24 assumes the count app; it is a one-line change either way.)
2. Is a hard block on closing with unvisited locations ever wanted, or always
   warn-and-allow? (A20 assumes warn-and-allow.)
3. What does `6 Cas…` mean on the Southern Glazer's lines — units per case, or a
   case count? It decides whether pack size can be parsed or must be typed.
4. Should dates follow **one time zone per organization** (a setting) or whatever
   the viewing device uses? (V2 assumes per organization, because a count date is
   part of an audit record.)

---

## Appendix A — full code-audit list

Read-only audit of the count app, as used on an Android phone in Chrome in a dim
bar, one-handed. Severity: **H** can lose or corrupt data or breaks the core loop ·
**M** measurable friction or a latent trap · **L** polish. Items marked
*unverified* depend on a real handset. Token reference (`app/globals.css`):
`min-h-tap-min` 44px, `min-h-tap-primary` 56px, `text-label` 11px uppercase,
`text-caption` 13px, `text-body` 16px.

### A.1 Tap targets, spacing, destructive-next-to-routine

- **A1** `M` — components/count/fill-entry.tsx:276-292 — "Remove" (destructive) sits in the same row as the routine "Update bottle #N". One-handed mis-tap deletes a bottle's fill. Also the per-bottle X (:347-349, 44px) sits against the chip that selects that bottle. Fix: move Remove out of the primary row (a `variant="ghost"` text button under the Save row with `mt-6`), or reuse the inline two-step pattern from DiscardRow (count-leg.tsx:1215-1247) instead of a modal. Cost if mis-tapped: re-enter 1 bottle, ~5 taps.
- **A2** `M` — components/count/count-leg.tsx:662-873 (entry phase) — on a tenths location FillEntry and QuantityEntry are mounted together, each with its own Save ("Save fill levels" fill-entry.tsx:389-396, quantity Save quantity-entry.tsx:288-334). Two primary-looking Save buttons on one screen; which one commits what is not obvious. **Unverified:** whether tapping one Save discards the other form's unsaved edits. Fix: one sticky Save for the whole entry, or label them "Save fill levels" / "Save sealed qty" and keep both visually distinct (`variant` outline on the secondary).
- **A3** `L` — components/count/count-leg.tsx:1072-1101 — "Finish section" (outline, 56px) is adjacent to the accent Scan button, same height, in the thumb's primary zone; the Search icon beside them is only 44px (:1074-1082). Fix: `gap-3` minimum, give Finish `w-1/3`, keep Scan `flex-1`; match Search to `size-tap-primary`. Reversibility of Finish is unverified (it returns to the picker, so probably cheap to undo).
- **A4** `L` — components/count/location-picker.tsx:28-33 — the back link is a caption-size text link at 44px; it is also the only route toward Submit (see A19). Fix: promote to a labelled button.
- **A5** `L` — components/ui/action-bar.tsx — `fixed bottom-0 z-40 p-bar-pad` with no `pb-safe-bottom` (the scanner footer does use it, barcode-scanner.tsx:259). **Unverified** whether Chrome-on-Android reports a non-zero bottom inset with `viewportFit: cover` on gesture nav; if so the bar sits over the gesture handle. Fix: `pb-[max(var(--spacing-bar-pad),var(--spacing-safe-bottom))]`.

### A.2 One-handed reachability, fixed/sticky bars vs keyboard, safe-area, vh vs dvh

- **A6** `M` — components/count/barcode-scanner.tsx:219-241 — Close (X) and torch are the top corners of a full-screen scanner, the least reachable place for a one-handed grip, and Close is the only escape (the "search instead" advice in the footer :266 and error text :177 requires it). Fix: move a full-width "Search instead" / "Close" button to the footer (`min-h-tap-primary`), torch to bottom-right. Cost: a grip change (~1-2 s) on every exit.
- **A7** `M` — app/layout.tsx:20-28 — `viewportFit: cover`, no `interactiveWidget`. Android Chrome's default is resizes-visual, so `fixed bottom-0` bars (ActionBar, CountLeg bottom bar :1072-1101, StrayBottleModal bottom sheet) are not pushed up by the keyboard. **Unverified on device.** Test: open the stray-bottle modal (search `autoFocus`) and the quantity entry with the keyboard up. Fix if it fails: add `interactiveWidget: "resizes-content"` to the viewport export (check it does not squash the scanner), or position the sheet with `bottom-[env(keyboard-inset-height,0px)]`.
- **A8** `M` — components/count/quantity-entry.tsx:288-334 — Save is inline at the bottom of the entry form, not in a fixed bar. With the numeric keyboard open it is probably under the keyboard; the user has to dismiss the keyboard and scroll. **Unverified** (depends on the entry screen height). Fix: sticky Save row (`sticky bottom-0 bg-background/95 pb-safe-bottom`) or `enterKeyHint="done"` plus submit-on-Enter.
- **A9** `L` — components/count/count-leg.tsx:983-1012 — the search input and its results are at the top of the page, the farthest point from the thumb; the bottom Search icon (:1074-1082) only does `scrollIntoView` and focus. Acceptable because of that shortcut, but the results list stays at the top while the keyboard is at the bottom. Fix (optional): render results directly above the bottom bar when the input is focused.
- **A10** `L` — components/count/vial-display.tsx:112 — 200px-tall `touch-none` slider. A swipe that starts on it cannot scroll the page. **Unverified:** whether the entry screen needs scrolling on a 640px-high viewport. Fix: `touch-pan-y` if the drag is horizontal, or reduce to 160px on short screens (`h-40 max-[700px]:h-32`).

### A.3 Input friction (inputmode, autofocus, enterKeyHint, autocomplete, steppers, tenths)

- **A11** `M` — components/count/quantity-entry.tsx:340-390 — no quick-add chips; typing "24" costs tap field + keyboard + digits + dismiss + Save (~5 taps), steppers are +/-1 only; no `enterKeyHint`, no autofocus. Fix: a row of `+6 +12 +24` (`min-h-tap-min` chips) under the stepper that call the same set/add handler; add `enterKeyHint="done"`. Saves ~3 taps/line on case lines.
- **A12** `M` — components/count/count-leg.tsx:983-1003 — product search `type="search"` with no `autoCapitalize="none"`, `autoCorrect="off"`, `spellCheck={false}`, `enterKeyHint="search"`, or `aria-label`. Gboard autocorrect will rewrite brand names ("Jameson" -> "Jameson's" or a dictionary word). Same on the stray-bottle search and catalog-search.tsx. Fix: add those attributes.
- **A13** `M` — components/count/count-leg.tsx:569-582 (also stray-bottle-modal.tsx and catalog-search.tsx) — search fires on every keystroke with no debounce and no stale-response guard, so a slow earlier response can overwrite newer results. Fix: 150-250 ms debounce plus a request-id ref (`if (id !== latest.current) return`) or `AbortController`.
- **A14** `M` — components/count/vial-display.tsx:43-48 — the value is set on `pointerdown`, so a touch that was meant to scroll or steady the phone changes the fill level. The number is shown before Save, so it is visible, but it is a silent-wrong-default risk. Fix: set on `pointerup` unless the pointer moved, or require a drag (`pointermove` past 4px).
- **A15** `M` — components/count/enroll-form.tsx:541 (CreateNew) — Save at the very bottom of a scrolling form after Name plus three native `<select>`s; with the keyboard up it is hidden. Each native select is a two-tap interaction. The <20 s budget is **unverified** on a handset. Fix: sticky Save; replace the size/pack selects with segmented buttons for the 3-4 common values (750 / 1000 / 1750 ml).
- **A16** `L` — components/count/quantity-entry.tsx:302 — Save is `disabled` when nothing is entered, with no reason shown. Fix: helper text "Enter a quantity" under the field (`text-caption`).
- **A17** `L` — components/count/count-leg.tsx:1012-1035 — the results block renders only when `length > 0`; no "no match" state. See A25.

### A.4 Navigation and workflow

Tap count from login (derived from code, unverified on device): sign in -> `router.replace("/")` (components/login-form.tsx:57) -> `redirect` to `/count` for staff (app/login/page.tsx:21, app/page.tsx:15) -> "Start a count" (1) -> location picker (2) -> Scan (3). Resume is the same: Resume (1) -> location (2) -> Scan (3).

- **A18** `H` — components/count/tab-bar.tsx:31-50 + app/(count)/layout.tsx:20-22 — the bottom tab bar (Count / Catalog / Reports / Account) is rendered during entry and enroll and its `<Link>`s bypass the leg's `requestLeave` / dirty-tracking (count-leg.tsx:586-599). One stray thumb tap on Catalog or Account discards an unsaved fill level or quantity with no prompt. This is the same defect class that commit f7fd608 fixed for the in-leg back chevron. Fix: hide the tab bar while `phase !== "counting"` (render it only in the pick-location / counting phases), or lift the dirty flag into context and have `CountTabBar` intercept. Cost: lost entry, ~5-10 s.
- **A19** `H` — components/count/count-leg.tsx (phases pick-location | counting | entry | enroll are component state; grep found no `popstate` / `pushState` / `beforeunload` in components/count) — Android system Back (button or swipe) leaves the whole scan screen from any phase, including mid-entry, instead of stepping back one phase, and bypasses `requestLeave`. **Unverified on device** but nothing in the code intercepts it. This is the most natural one-handed gesture on Android. Fix: `history.pushState` per phase and handle `popstate` by mapping to the same function the back chevron uses (:586-599); add a `beforeunload` guard for the dirty case.
- **A20** `H` — components/count/session-actions.tsx:83-111, :162-171 — "Submit" and "Close count" (shown with the total value) have no confirmation, no warning for locations with zero lines, for lines without a cost, or for a $0 total. `canSubmitCount` guards only queued offline writes. Closing is irreversible by invariant 1 (a closed count cannot be edited, and `SessionActions` renders `null` at closed, :65). AGENTS.md rules out modals on frequently used controls; this is a once-per-count control, so a summary is appropriate. Fix: an inline pre-flight panel above the button: "3 of 5 locations counted - Walk-in, Patio not started", "7 lines have no cost", amber `text-warning` + `bg-warning-bg`, and require a second tap on "Close anyway".
- **A21** `H` — components/count/count-leg.tsx:547, :884, :1040-1058 — after a normal Save the only confirmation is `setRescanAnnouncement`, which is set for rapid rescans only and rendered `sr-only`. A sighted user gets no toast; the line is appended at the END of the "Just counted" list (insertion order), which is likely below the fold. In a dim bar with one hand, "did it save?" has no visible answer except the 11px SyncIndicator. Fix: a 1.5 s non-blocking toast/banner ("Saved - Jameson 750 - 3 ea") and render "Just counted" newest-first (`[...recent].reverse()`); flash the new row (`animate-pulse` once, or `bg-success-bg`). Cost: a re-check tap or a double count when unsure.
- **A22** `H` — components/count/enroll-form.tsx:291-298 (LinkExisting) — tapping a search result attaches the scanned barcode to that product immediately, for non-case products, with no confirmation and no undo. A mis-tap writes a wrong UPC permanently, and every later scan of that bottle resolves to the wrong product. Silent, plausible, persistent. This is the failure mode AGENTS.md warns about. Fix: first tap selects (highlight plus a sticky "Link <barcode> to <Product name>" 56px button), second tap commits; or show an "Undo" toast for 5-8 s that clears the UPC.
- **A23** `M` — app/(count)/count/page.tsx:231-239 and :158-163 — each location row's chevron (aria-label "Count {loc.name}") and the "Resume" link both go to `/count/{id}/scan` WITHOUT `?locationId=`, so the user lands on the picker. The detail page does pass it (app/(count)/count/[countId]/page.tsx:123-125), so the screen supports it. The label promises a jump that does not happen. Fix: `` href={`/count/${activeCount.id}/scan?locationId=${loc.id}`} ``. Saves 1 tap per leg (5 per count).
- **A24** `M` — app/page.tsx:15 and app/login/page.tsx:21 — `redirect(staff ? "/count" : "/office")`. The user in this brief is a manager or owner on a phone: they land on `/office` and must find the rail's "Count" link (components/office/office-rail.tsx:259-267) before the first scan. Office layout width on phones was not audited. Fix: default managers to `/count` (`role === "owner" ? "/office" : "/count"`), or remember the last surface in a cookie. Cost: +2-3 taps per session, plus orientation.
- **A25** `M` — components/count/count-leg.tsx:1012-1035 and components/count/catalog-search.tsx:31-35 — a search with no hits shows nothing, and there is no barcode-less add anywhere (the comment in catalog-search.tsx says so). House infusions and damaged labels (AGENTS.md's reasons for the search picker) dead-end. Fix: when `query && results.length === 0`, show "No match - Add as new product" (56px) opening the enroll phase with the name prefilled and `upc` empty.
- **A26** `M` — components/count/location-picker.tsx:28-33 and count-leg.tsx:1099 ("Finish section") — finishing the last leg returns to the picker; the route to Submit is the small back link to `/count/{id}`. No "Review and submit" call to action. Fix: when every location has lines, show a 56px "Review and submit ->" button at the top of the picker. Saves 1-2 taps, and removes the "where do I submit" question.
- **A27** `M` — components/count/session-actions.tsx:79 and :65 — after Close/Submit success the page does `router.refresh()` and the actions disappear (returns `null` at closed). No confirmation, no next step. Fix: set a success banner (`role="status"`) with "Count #N closed - $X" and two links: "Back to counts" and "Start a new count".
- **A28** `M` — components/count/barcode-scanner.tsx:131-133, :186-189 — the camera stream is torn down on every unmount, so every non-rapid scan (tenths locations) is scan -> close -> entry -> save -> tap Scan -> camera cold start. **Unverified:** cold-start time on the target handset (commonly 0.5-1.5 s on Android). Fix: keep the `MediaStream` in a ref or context scoped to CountLeg and hide the `<video>` instead of stopping the tracks.
- **A29** `L` — app/(count)/count/[countId]/page.tsx — the detail page (where Submit lives) shows lines but no per-location progress, while the hub shows "N of M started" (count/page.tsx:196-199). Fix: reuse the hub's per-location rows (or a one-line "Not started: ...") above SessionActions; this feeds A20.
- **A30** `L` — app/(count)/count/page.tsx:60-82 — header emoji (the person icon and gear) and a "Preflight" diagnostics link shown to every role, equal in weight to the role pill. For a bar manager it is noise next to the account link. Fix: move Preflight to the Account page (components/count/preflight.tsx is a dev/handset diagnostic); replace the emoji with lucide icons.
- **A31** `L` — app/(count)/count/page.tsx:65-72 — the role pill is a link to Account but looks like a status badge. Fix: use the user name and a chevron, or drop the link (Account is in the tab bar).

### A.5 Feedback and state

- **A32** `M` — app/(count) route group — `find app -name loading.tsx -o -name error.tsx` returns nothing. The hub and detail pages await 3-4 server actions; on bar Wi-Fi the previous screen stays frozen with no feedback after a tap, and a thrown action shows Next's default error page. Fix: `app/(count)/loading.tsx` (skeleton cards with `animate-pulse bg-muted`) and `app/(count)/error.tsx` with a 56px "Try again" calling `reset()`.
- **A33** `H` — components/count/barcode-scanner.tsx:152-153, :253 — detection runs on the whole frame and takes `results.find(r => r.rawValue)` (first hit), while the rectangle drawn at :253 is explicitly "purely visual". With three bottles on a back-bar shelf in view, the scan is whichever barcode the detector lists first, not the one inside the frame. The entry screen shows the resolved product name, so a careful counter can catch it, but in rapid mode (quantity locations, cartons with several labels) the only check is the overlay. Fix: filter by `boundingBox` centre inside the frame rectangle, or pick the result nearest the frame centre, so the affordance is true.
- **A34** `L` — components/count/barcode-scanner.tsx:155-157, :163-165 — no `navigator.vibrate` or audio cue anywhere in the repo (grep). In non-rapid mode the screen change confirms; in rapid mode only the overlay does. Fix: `navigator.vibrate?.(30)` on accepted hit, a different pattern `[30, 40, 30]` for refusal.
- **A35** `L` — components/count/barcode-scanner.tsx:259-271 — the permission-denied / insecure-origin / camera-failed text is `text-caption` (13px) in the footer, and the error replaces the rapid toggle. The copy is good and specific; the size and the lack of an action are the issue. Fix: `text-body`, and add a "Search instead" 56px button (ties to A6).
- **A36** `L` — components/count/barcode-scanner.tsx:131-133 — constraints are `{ facingMode: "environment" }` only: no resolution hint, no zoom, no continuous focus. **Unverified:** Android may select 640x480, which is marginal for small EAN-13 on a glossy label. Fix: `width: { ideal: 1280 }, height: { ideal: 720 }`, and apply `advanced: [{ focusMode: "continuous" }]` where supported; consider a zoom slider using `track.getCapabilities().zoom`.

### A.6 Legibility / dim-bar

- **A37** `M` — components/ui/button.tsx:16 — every Button label is `text-label uppercase` (11px). That includes the 56px primary actions and the live SET/ADD consequence text on the entry button ("SET TO 3 EA / was 12 ea - -9"). 11px uppercase is hard to read at arm's length in low light. Fix: `text-caption` (13px) for buttons, keep `tracking-wide uppercase`, or define a `--text-button: 0.875rem`.
- **A38** `M` — components/count/quantity-entry.tsx:319-327 — the before/after caption is `text-caption` at 75% opacity. AGENTS.md calls this the safeguard against an ADD/SET mix-up; it should be the most legible text on the screen. Fix: remove the opacity, use `text-body font-semibold tabular-nums`, and tint the delta (`text-negative` for a decrease).
- **A39** `M` — components/count/count-leg.tsx:1249-1271 — SyncIndicator, the only visible save/offline signal, is 11px uppercase. Fix: `text-caption`, add an icon (check / cloud-off / spinner) so state is not carried by colour or tiny text alone, and put "N unsent" in `text-warning`.
- **A40** `L` — components/count/tab-bar.tsx:31-50 — tab labels are `text-label` (11px). Fix: `text-caption` for the label, keep the icon `size-6`.
- **A41** `L` — app/(count)/count/page.tsx:147-154 and components/count/progress-card.tsx:31-35 — a valuation figure is shown whenever `totalValue != null`, so `$0.00` or a partial total appears with no caveat. The detail page has a coverage bar; the hub does not. Fix: show "(n of m lines costed)" next to the number and `text-warning` when coverage < 100%; on a $0 total show "No costs on file".

### A.7 Accessibility

- **A42** `L` — components/count/quantity-entry.tsx:187-222 — Add/Set `role="tablist"` / `role="tab"` without `aria-controls` / `role="tabpanel"`. Fix: add them, or switch to a `role="radiogroup"` with two radios (it is a mode switch, not navigation).
- **A43** `L` — components/count/stray-bottle-modal.tsx — `role="dialog" aria-modal`, labelled close and Escape handling are present; there is no focus trap, and no destination is preselected so results stay disabled until a chip is tapped (+1 tap, safe by design). Fix: trap focus (`inert` on the siblings), optionally preselect the last-used destination.
- **A44** `L` — components/count/count-leg.tsx:983-1003 — the search input has no accessible name (placeholder only); see A12. Search results are not in an `aria-live` region.
- **A45** `L` — components/count/barcode-scanner.tsx:250 — `<video aria-label>` is fine; the live region for "scan accepted/refused" exists only for the rapid rescan (count-leg.tsx:884). Fix: announce Saved / Refused for every write via the same region (pairs with A21).
