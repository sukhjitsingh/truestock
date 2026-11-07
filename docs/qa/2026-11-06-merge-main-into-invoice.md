# QA report: `qa/merge-main-into-invoice`

- **Date:** 2026-11-06
- **Commit tested:** `857cb23` (`feat/phase-2.5-invoice-automation` + `origin/main` merged as `d731f0d` + e2e fix)
- **Stack:** local Docker, MariaDB 11.8.8
- **Repo changes:** F2 and F3 are fixed on local branch `fix/count-queue-order-and-retry`, at your request after the QA run. Nothing was pushed. Findings below describe `857cb23`, before those fixes.

Invoices are called **invoice A** (text PDF) and **invoice B** (scan). Lines are given by number and field only; no supplier contents appear here.

## Verdict

**The automated gates pass, but this branch is not ready to rely on.** Static checks, 1145 unit and integration tests, 62 Playwright tests and all three browser harnesses are green. Real invoices and a real phone found defects none of those caught.

Four problems produce wrong or missing numbers with nothing on screen to show it:

1. **Costs do not post from a real invoice.** Approving invoice A wrote 0 cost history rows and said nothing (F1).
2. **A correction made while a write is queued gets overwritten.** The phone showed `4 ea` and SYNCED; the database held 6 (F2).
3. **Queued writes never retry if the phone has mobile data.** One sat unsent for over 7 minutes (F3).
4. **One extracted line was wrong and passed the arithmetic check** (F4).

## What happened to each finding

You asked me to fix only what is small and not invoice-related, and to hand the rest to the invoice branch.

| Finding | Category | Status |
|---|---|---|
| F2, F3 | Count queue, not invoice, small | **Fixed** on `fix/count-queue-order-and-retry`. Not yet checked on the phone |
| F1, F4, F5, F6, F7, F8, F9, F10 | Invoice | **Open.** Handed off in `docs/qa/2026-11-06-invoice-failures-handoff.md` for `feat/phase-2.5-invoice-automation` |

The minor items are not fixed either.

## The F2 and F3 fix

- **Change:** `components/count/count-leg.tsx` only. Count writes go through one lock, older queued writes go first, a new write waits behind a blocked queue, and pending writes retry every 15 seconds while the scan screen is mounted.
- **Tests:** three new ones in `e2e/specs/count-flow.e2e.ts`, which block only the count POSTs so `navigator.onLine` stays true, as on the phone.
- **Result on commit `2d0f164`, production build:** `count-flow` 7 of 7 passed on the mobile project, including the three new tests.
- **Mutation check:** with the original `count-leg.tsx`, exactly the three new tests failed and the four older ones passed.
- **Regression run, same commit:** all specs on both projects gave 27 passed, 0 failed, 0 flaky, 38 skipped. Every skip is missing credentials (26 owner, 12 staff), so **those 38 are not verified** for this fix.
- **Typecheck and lint:** both exit 0 with no output, in the rig on this worktree. Lint covered the two changed files only.
- **Process:** `AGENTS.md` sends count-write changes through the planning gates. I skipped them because you asked for a small direct fix.
- **Not verified:** the fix on the real phone, where both defects were found.
- **Still open on the count side:** see `docs/open-items.md` #46. The queue retries only while the scan screen is mounted, Finish section gives no pending warning, and `/count/<id>` shows no pending indicator.

## Results by step

| # | Step | Result |
|---|---|---|
| 1 | Reset stack | **Passed** on the third attempt: 10 migrations on 11.8.8, 97 products, 6 locations |
| 2 | Typecheck, lint | **Passed** with a caveat: bare `bun run lint` exits 1 (see below) |
| 3 | `test:docker` | **Passed**: 1145 pass, 5 todo, 0 fail, 303.95 s |
| 4 | E2E setup | **Passed**: `truestock_e2e`, 3 accounts, `/login` 200 after about 66 s |
| 5 | Upload and archive | **Passed**, both invoices |
| 5 | Extraction | A **passed** (pdf-inspector). B **failed** on selective OCR; Vision **not verified** |
| 5 | Review screen | Inline preview **passed**; line accuracy **failed** (A line 4) |
| 5 | Vendor matching | **Failed**: no alias learned, second upload matched 0 of 4 |
| 5 | Approve and post costs | **Failed** on real data; passed only with hand-set diagnostic data |
| 5 | Deposits not in cost | **Not verified** on real data |
| 5 | Roles | **Passed**: owner 200, manager 403, staff 403, signed out 401 |
| 5 | Audit Packet | **Failed** as first run; passed only after hand-dating invoice B |
| 6 | Playwright | **Passed**: 62 passed, 0 skipped, both projects, `E2E_REQUIRE_ALL=1` |
| 7 | Browser harnesses | **Passed**: 81/81, 13/13, 72 passed. Three checks not verified |
| 8 | Barcode integrity, desktop | **Passed**, all five checks |
| 9 | Phone: count, barcode flows, stray bottle, finish section | **Passed** |
| 9 | Phone: offline sync | **Failed**: F2, F3 |
| 9 | Phone: manual camera pass | **Passed** for unknown and different size; known bottle **not verified** |

## Failures that produce wrong numbers

### F1. Approving a real invoice posts no costs, silently (serious)

- **Evidence:** after approving invoice A, `product_cost_history` had 0 rows and `current_unit_cost` was unchanged. The success banner gave no sign that 0 costs were posted.
- **Cause:** every extracted line had `pack_size` NULL. `lib/domain/cost-derivation.ts` then returns a null cost, and `lib/domain/invoice-approval.ts` skips null costs without reporting them. `components/office/invoice-review-form.tsx` has no input for `pack_size`, so a reviewer cannot fix it.

### F2. A newer write overtakes a queued one, and the correction is lost (serious)

- **Evidence:** the server held 3 and the screen 5, with a +2 queued. A SET to 4 (button `SAVE CORRECTION (4 EA) / was 5 ea · −1`) went straight to the server, giving 4 with a delta of +1. When the queue drained, the older +2 replayed on top. **The database held 6 while the phone showed `4 ea` and SYNCED.**
- **Ledger for line 2:** `5445ee21` +12, `2afb9c97` −9, `51946b20` +1, `650eff51` +2.
- **Cause:** the save path in `components/count/count-leg.tsx` (about lines 285–345) enqueues and then calls the server action directly, without flushing older writes first. The comment on `flush` says order matters.
- **Note:** I added this test; it was not in your steps. Line 2 stays at 6 ea in the dev DB as a result.

### F3. The queue never retries while the phone has mobile data (serious)

- **Evidence:** Wi-Fi was off 13:55:49–13:56:10, and the save at 13:55:55 queued correctly (`1 PENDING`, `lastError` "Offline — will retry"). The phone fell over to 5G, so `navigator.onLine` stayed true and no `online` event fired. There was no request and no DB change for over 7 minutes, until I intervened at about 14:04.
- **Cause:** `flush` runs only on mount and on the window `online` event (`components/count/count-leg.tsx:245-267`). There is no timer or retry.
- **What drained it:** only the count page then KEEP COUNTING, which remounts the component. Finish section and re-entering Storeroom did not.
- **What did work:** the write landed once with its original id, so idempotency held.
- **Related:** Finish section gives no warning with 1 pending. `/count/1` shows no pending indicator, reported 5.5 units, and left Submit live. A guard exists in `components/count/session-actions.tsx` (`canSubmitCount`), but I read that and did not test it.

### F4. Invoice A line 4 extracted wrongly and passed arithmetic (serious)

- **Evidence:** a blank discount cell shifted the columns, so `raw_discount` holds the gross value and `raw_net` is NULL. Arithmetic still shows pass. The only hint is a false "Discount > 50%" chip. Lines 1–3 and the headers were correct.
- **Cause:** `arithmeticCheck` (`lib/domain/extraction-pipeline.ts:1132`) sums gross only, so it cannot see this.

### F5. A free-goods line writes a unit cost of 0.0000 (serious, seen in diagnostic data)

- **Evidence:** a line with net 0.00 wrote `unit_cost` 0.0000 to product 20. It was only overwritten because a paid line for the same product came later. If the free line came last, the current cost would be $0.
- **Cause:** `deriveUnitCost` treats a net of 0 as a valid cost.

## Other failures

### F6. Aliases are never learned from a real invoice

Manual matching worked and the invoice reached `reviewed`, but `vendor_alias` had 0 rows. An alias needs a `vendor_item_code`. Invoice A's codes are embedded in the description, `CODE_HEADER_PATTERNS` found none, and the review form has no field for it. A second upload (invoice 3, byte-identical to A) came back **matched 0 of 4**.

**Pre-match on a real upload remains unproven.** With placeholder codes set by SQL, 4 aliases were learned, but no fresh upload was run afterwards.

### F7. Byte-identical re-upload is accepted

Invoice 3 is the same file as invoice 1 and was accepted with no duplicate warning. Approving both would post the same costs twice.

### F8. An invoice with failed extraction can be approved with 0 lines

Invoice B failed extraction but sits in `needs_review` with no error shown, only "No lines were extracted". Approve and Return stay live, and Retry appears only after Return. It was approved with 0 lines and a hand-typed total.

### F9. PDFium is missing from the image

Selective OCR on invoice B failed: "failed to load PDFium; install a compatible PDFium shared library or set PDFIUM_LIB_PATH". It then fell back to Vision, which failed because `ANTHROPIC_API_KEY` is not set (job 2, `PIPELINE_ERROR`, phase `ocr`). Check this against Hostinger before deploying, since it is a native dependency.

### F10. Audit Packet omissions

- Packet 1 silently left out invoice B because its `invoice_date` was NULL, with no warning. That is how step 5's check failed first.
- After I hand-typed B's date, number, totals and currency, packet 2 held all 3 files plus `manifest.json`, and every SHA-256 matched the DB.
- Invoice 3 was in both packets while unapproved (approved 19:40:47; packets built 19:39:50 and 19:40:06). `buildAuditPacketJob` has no status filter.

### Minor

- No size warning when an invoice line for one size is matched to a catalog row of another.
- The greyed `USD` currency placeholder looks filled in, but review refuses with "missing: currency".
- The audit packet end-date validation message appears twice.
- `1 units` copy on the count screen.
- Stray modal "Close modal" button is 42x44, 2 px short of the target.
- The quantity button reads `SAVE CORRECTION (3 EA) / was 12 ea · −9`, not `SET TO 3 EA` as in AGENTS.md and your step. Before and after are shown; the wording differs. ADD reads `SAVE (12 EA) / 0 ea → 12 ea`.
- `count_line_write.write_type` reads `scan` on every row, including SETs. Noted, not investigated.
- Bare `bun run lint` exits 1 with 21796 problems (1806 errors), all from `.claude/worktrees` and `.agents/skills`, which `eslint.config.mjs` does not ignore. With those two excluded: exit 0, 0 errors, 31 warnings as expected.
- On Android 17, Chrome without the Nearby devices permission shows only `ERR_TOO_MANY_RETRIES` for the LAN origin. This affects LAN testing only.

## Known items from the cloud run

| Item | Result |
|---|---|
| Office side-menu focus outline | **Confirmed.** 8 links show outline 0px with no other focus change; other controls show 2px solid. `components/office/office-rail.tsx` has no focus styling. Not a test fix, so left alone |
| Invoice-preview checks | **Cleared.** PDF renders inline with real files, no console, CSP or frame errors |
| `invoice_file_write_once_survives_a_concurrent_put` | **Not reproduced, not cleared.** 0 failures in 10 isolated runs, and it passed in the full run. At 1 in 7, a clean 10 happens about 21% of the time by chance |

## Step 9 detail

Phone: Pixel 10 Pro XL, Android 17, Chrome 156, against the **dev** server on the LAN. Taps were real touch events, and every write was checked in the DB. Audits found no glued words, low contrast or horizontal scroll.

| Check | Result |
|---|---|
| Speed Rail fill, same bottle again | Passed: 1 line, `[0.5,0.5]`, 2 ledger rows |
| Storeroom ADD 12, SET 3 | Passed: DB 12, then 3, delta −9 |
| Known barcode, fake detector | Passed: EAN-13 and UPC-E resolve to one row |
| Unknown, link, size confirmation | Passed |
| It's a different size | Passed: new product 98, Jameson 750 ml left alone |
| Barcode already taken | Passed: names Tito's 750 ml, offers to count it |
| Stray bottle | Passed: leg stayed Storeroom, line recorded in Back Bar |
| Finish section | Passed |
| `750 ml`, `1.75 L`, `Sixtel keg` on the device | Passed |

### Manual camera pass

Recording: `.phone-sessions/session-20261106-140603` (gitignored). 0 page errors, 0 console errors, 0 failed requests, 17 server actions.

| Scan | Barcode as stored | Path | Result in DB |
|---|---|---|---|
| Grey Goose | `00080480280048` | Add as new product | Product 99, 200 ml, unit **can**; line 4: 2 ea |
| Smirnoff | `00082000000082` (read as UPC-E `08200802`) | Linked, then It's a different size | Product 100, 200 ml; Smirnoff 750 ml untouched; line 5: 1 ea |
| Miller Lite | `00034100575052` | Linked as **case** | Product 71; line 6: 1 case |

- **Real camera decoding passed**, including a true 8-digit UPC-E, which expanded correctly (I checked the digits by hand).
- **Known bottle on a real camera: not verified.** All three barcodes were new to the database and none was rescanned. Direct resolve is proven only with the fake detector.
- **The 20-second enroll budget: not verified.** The new-product form took 49 s, but 36 s of that was going through the category, unit and size lists. It is not a fair timing.
- **Size resets by design.** Changing category or unit moves the size to that list's default if it is not on the new list (`enroll-form.tsx:595`). Size went from 200 ml back to 750 ml this way and was re-picked. The form shows the change but does not call it out.
- **All 16 bottled beers have a NULL `case_size`.** The app is honest about it ("units unknown — no case size"), but any case counted before this is filled in, including line 6, has no unit total.
- **Aborted requests:** 6 server action requests show as aborted in the recording. No write was lost or doubled: the 3 saves made 3 ledger rows.
- **Check product 99.** It is a second Grey Goose row with unit `can`. It may be what you intended, but it is the one row from this pass that looks odd.
- Tapping the Tito's card 6 times in 2 seconds did nothing. Cards are not tappable. I can't tell what was intended.

## Not verified

| Item | Reason |
|---|---|
| Claude Vision extraction | `ANTHROPIC_API_KEY` not set |
| Invoice B's lines and totals | Depends on Vision |
| Deposits excluded from cost on real data | A has none, B needs Vision. Code refuses them by read only |
| Pre-match on a second real upload | Blocked by F6 |
| Offline behaviour on a production build | Step 9 uses the dev server, with a 21 s window because HMR reloads the page after about 40 s |
| `canSubmitCount` blocking Submit with writes pending | Read, not tested |
| Known bottle with a real camera; 20 s enroll budget | See manual camera pass |
| `verify-browser`: open item 26 preflight banner | Dev only |
| `verify-browser`: Decision 5 | Needs `VERIFY_DECISION5_BASE` |
| `verify-browser`: open item 44 no-closed-count sentence | Shows only before any close |
| Whether F2 and F3 predate this merge | Not tested on `main` |
| Typecheck against pdf-inspector 1.25.2 | Host `node_modules` still has 1.15.0. The container has the right version |

## What I did beyond your steps

- Ran `docker compose build app` before the reset, because the image had pdf-inspector 1.15.0 and the branch needs 1.25.2.
- `docker:reset` failed twice ("did not receive an exit event") and succeeded on the third run.
- Dumped the dev DB before the reset to `~/truestock-qa-2026-11-06/pre-reset-truestock-dev.sql`. **The reset removed that data:** 1 user, 98 products, 5 counts, 12 count lines, 3 invoices, 2 vendors.
- **Set data by SQL on invoice 3** (placeholder `QA-DIAG-1..4` codes and pack sizes) to reach the alias and cost code. Those results are labelled diagnostic and are not passes.
- Hand-typed invoice B's date, number, totals and currency in the UI.
- Created dev manager `qa-phone-manager@example.test` with a generated password that I did not print.
- Held a screen wake lock from the test script, because `svc power stayon true` had no effect on battery. Released at the end.
- Ran the offline step with an on-device script using `input tap`, because adb drops with Wi-Fi.
- Used a desktop browser as the second client in the taken-barcode race.

## Rows created

### `truestock` (dev)

| Table | Rows |
|---|---|
| `user` | 1 `qa-phone-manager@example.test` |
| `session` | 1, 2 |
| `count` | 1 (in progress) |
| `count_line` | 1–6 |
| `count_line_write` | 1–10 |
| `product` | 98 Jameson 1.75 L, 99 Grey Goose 200 ml, 100 Smirnoff 200 ml |
| `product_barcode` | 1 `00042100005264` and 3 `00036000291452` (both Tito's), 2 `00012345678905` (98), 5 `00080480280048` (99), 6 `00082000000082` (100), 7 `00034100575052` (Miller Lite, case) |

Barcode rows 1, 2 and 3 are test values, so **rows 1 and 3 attach fake codes to the real Tito's**. Rows 5–7 are real scans. Line 2 stands at 6 ea because of F2.

### `truestock_e2e`

| Table | Rows |
|---|---|
| `user` | 1 owner, 2 manager, 3 staff, 4 `qa-fix-manager@example.test` (for the F2/F3 tests) |
| `vendor` | 1, 2 (both named `QA Vendor …`) |
| `invoice` | 1, 2, 3 (mine), 7 (harness) |
| `audit_packet` | 1, 2 |
| `vendor_alias` | 4 `QA-DIAG` rows |
| `product_cost_history` | 5 (4 diagnostic, 1 harness) |
| `product` | 99 harness, 100 Jameson 1.75 L (**deactivated by SQL** during the fix, see below) |
| `product_barcode` | 3 test barcodes |
| `product_par` | par 6.00 on product 35 |
| `count` | #11 closed, #13 open (the suite's `resetCounts()` also deletes counts, so other ids come and go) |

Two things happened in `truestock_e2e` during the fix:

- **I deleted the temp file holding the e2e passwords,** so the accounts for users 1–3 can no longer be used from here. I created user 4 for the fix tests, with a generated password I did not print. This is why owner and staff specs skipped.
- **I set `active = 0` on product 100.** My barcode check left this second `Jameson`, and it made six `count-flow` tests fail with a strict-mode error. Those failures were my leftover data, not the fix.

`resetCounts()` also ran during these tests, replacing the counts listed above. The `truestock` dev database was not touched during the fix.

## State left behind

- **Phone:** `stay_on` is 0, the port forward is removed, the throwaway files are gone. Our Chrome tab is still open on the Storeroom leg. Chrome's Nearby devices permission stays allowed, as you set it.
- **Scripts:** the throwaway phone drivers are deleted, along with stored browser sessions.
- **Stack:** `docker:up:lan` is still running, so the app is reachable on the LAN (ports 3000 and 3443). Undo with `bun run docker:down && bun run docker:up`. The e2e rig is down.
- **Branches:** `fix/count-queue-order-and-retry` is local only and stacked on `857cb23`. `qa/merge-main-into-invoice` and `feat/phase-2.5-invoice-automation` were not changed.
- **Evidence:** logs and screenshots are in `~/truestock-qa-2026-11-06/evidence/`. Invoice screenshots were left out, as was one Android dialog that shows the Wi-Fi network name.
- **Real invoice copies** remain in this job's temp folder (`e2e-invoices/`, audit zips), and `truestock_e2e` holds their extracted lines. The temp folder goes when the job is deleted; the database stays until you drop it.
- **`tests/invoices/` shows as untracked.** I did not add it to `.gitignore`.
