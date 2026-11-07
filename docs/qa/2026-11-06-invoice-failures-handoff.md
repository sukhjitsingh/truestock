# Handoff: invoice failures from the 2026-11-06 QA run

**For the next session.** Work these on `feat/phase-2.5-invoice-automation`, not on the QA or fix branches.

The QA run tested `857cb23`, which is `feat/phase-2.5-invoice-automation` plus `origin/main` (PR #36) plus one e2e fix. It used real invoices and a real phone. Automated gates were all green, and every failure below was found only by real data.

Invoices are called **invoice A** (text PDF) and **invoice B** (scan). Line numbers refer to positions in those documents. No supplier contents appear here, and none may appear in commits, docs or fixtures.

## How the ten findings were split

| Finding | What | Where it goes | Status |
|---|---|---|---|
| F1 | Approving a real invoice posts no costs, silently | Invoice branch | **Open** |
| F2 | A newer count write overtakes a queued one | Fix branch | Fixed, see below |
| F3 | Queued count writes never retry on mobile data | Fix branch | Fixed, see below |
| F4 | Line extracted wrongly, arithmetic still passes | Invoice branch | **Open** |
| F5 | Free-goods line writes a unit cost of 0 | Invoice branch | **Open** |
| F6 | Aliases never learned from a real invoice | Invoice branch | **Open** |
| F7 | Byte-identical re-upload accepted | Invoice branch | **Open** |
| F8 | Failed extraction can be approved with 0 lines | Invoice branch | **Open** |
| F9 | PDFium missing from the image | Invoice branch | **Open** |
| F10 | Audit Packet omissions | Invoice branch | **Open** |

F2 and F3 are in `components/count/count-leg.tsx` only and have nothing to do with invoices. They are on local branch `fix/count-queue-order-and-retry`, which is stacked on `857cb23` and has not been pushed.

## Before you start

1. **Decide how the branches join.** `feat/phase-2.5-invoice-automation` does not yet contain the PR #36 merge, the e2e fix or the F2/F3 fix. It is an ancestor of `857cb23`, so it can fast-forward. That is the owner's call, so ask.
2. **The code pointers below hold either way.** Between `feat/phase-2.5-invoice-automation` and `857cb23`, the invoice domain files, `app/api` and `docker/app/Dockerfile` are unchanged. The only differences in the areas named here are `lib/domain/catalog.ts`, `lib/domain/counts.ts` and `components/office/catalog-table.tsx`.
3. **Read `docs/plans/README.md`.** F1, F6 and F7 change behaviour across several files and carry product decisions, so they probably need the gates. F5 is a small change.
4. **Get an `ANTHROPIC_API_KEY`.** Without it, Vision cannot run, and anything depending on invoice B stays unverified.
5. **`tests/invoices/` holds real supplier documents.** It is untracked and not in `.gitignore`. Never commit it, never copy its contents, and do not add it to `.gitignore` without asking. Test fixtures must be synthetic.

## Open findings

> **Status, 2026-11-07:** all eight findings and the three minor items are fixed on
> `feat/phase-2.5-invoice-automation`. What each proof covers, and what stays
> unverified, is in `docs/open-items.md` #47. The findings below are kept as found.

The order is a suggestion: wrong numbers first, then what blocks verifying the rest.

### 1. F1. Approving a real invoice posts no costs, silently

- **Seen:** after approving invoice A, `product_cost_history` had 0 rows and `current_unit_cost` was unchanged. The success banner gave no sign that 0 costs posted.
- **Cause:** every extracted line had `pack_size` NULL. `deriveUnitCost` (`lib/domain/cost-derivation.ts:66`) returns null, `lib/domain/invoice-approval.ts:180` skips null costs without reporting them, and `components/office/invoice-review-form.tsx` has no `pack_size` input, so a reviewer cannot fix it.
- **Decide:** should approval refuse, warn, or post what it can and say what it skipped? Silent is the one wrong answer. Can `pack_size` be extracted, or is it reviewer input with a remembered value per product?
- **Done when:** a real invoice approved through the UI writes cost history, and the screen states how many lines posted and how many did not.

### 2. F5. A free-goods line writes a unit cost of 0.0000

- **Seen, in diagnostic data:** a line with net 0.00 wrote `unit_cost` 0.0000. It was overwritten only because a paid line for the same product came later. Had the free line come last, the current cost would be $0.
- **Cause:** `deriveUnitCost` refuses a zero or negative quantity and pack size, but not a zero net.
- **Fix shape:** treat net 0 as no cost. Also decide what a negative net (a credit) should do, because it is not refused either and gives a negative cost. These lines must count as skipped in F1's report.

### 3. F4. Invoice A line 4 extracted wrongly and passed arithmetic

- **Seen:** a blank discount cell shifted the columns, so `raw_discount` holds the gross value and `raw_net` is NULL. Arithmetic still shows pass. The only hint is a false "Discount > 50%" chip. Lines 1–3 and the headers were correct.
- **Cause:** two separate gaps. The markdown table parser lets a blank cell shift columns, and `arithmeticCheck` (`lib/domain/extraction-pipeline.ts:1132`) sums gross only, so it cannot see the damage.
- **Fix shape:** a line with gross but no net should not pass. Check per line, not only the sum. Reproduce with a synthetic table that has a blank cell.

### 4. F8. An invoice with failed extraction can be approved with 0 lines

- **Seen:** invoice B failed extraction but sits in `needs_review` with no error shown, only "No lines were extracted". Approve and Return stay live, and Retry appears only after Return. It was approved with 0 lines and a hand-typed total.
- **Fix shape:** show the failure, offer Retry directly, and refuse approval with 0 lines. See `lib/domain/extraction-pipeline.ts:1286` for the move to `needs_review`.

### 5. F9. PDFium is missing from the image

- **Seen:** selective OCR on invoice B failed with "failed to load PDFium; install a compatible PDFium shared library or set PDFIUM_LIB_PATH". It then fell back to Vision, which failed because `ANTHROPIC_API_KEY` is not set (`PIPELINE_ERROR`, phase `ocr`).
- **Fix shape:** add PDFium to `docker/app/Dockerfile`, or decide that scans always go to Vision.
- **Check Hostinger first.** Production does not use this Docker image, and Truestock has never been deployed there, so a Dockerfile fix proves nothing about the host. If a native PDFium cannot load there, the answer is "Vision only" in production. Add the check to `docs/go-live.md` either way.

### 6. F7. Byte-identical re-upload is accepted

- **Seen:** invoice 3 is the same file as invoice 1 and was accepted with no warning. Approving both would post the same costs twice.
- **Facts:** `invoice.file_sha256` is stored (`db/schema.ts:991`), and none of the table's indexes cover it.
- **Decide:** refuse a duplicate, or only warn? Scope the check to one organization (invariant 9).

### 7. F6. Aliases are never learned from a real invoice

- **Seen:** manual matching worked and the invoice reached `reviewed`, but `vendor_alias` had 0 rows. A second upload of the same file came back matched 0 of 4.
- **Cause:** an alias needs a `vendor_item_code`. Invoice A's codes are embedded in the description, `CODE_HEADER_PATTERNS` (`lib/domain/extraction-pipeline.ts:408`) found none, and the review form has no field for it.
- **Decide:** extract the code from the description, add a review field, or fall back to the description as the alias key.
- **Still unproven:** pre-match on a fresh real upload. With placeholder codes set by SQL, 4 aliases were learned, but nothing was uploaded afterwards.

### 8. F10. Audit Packet omissions

- **Seen:** packet 1 silently left out invoice B because `invoice_date` was NULL. Invoice 3 was in both packets while unapproved, because `buildAuditPacketJob` (`lib/domain/audit-packets.ts:299`) has no status filter.
- **Passed:** once B was dated by hand, packet 2 held all 3 files plus `manifest.json`, and every SHA-256 matched the database.
- **Decide:** should a packet include unapproved invoices at all? Either way, an omitted invoice must be named, not dropped.

### Minor, same screens

- No size warning when an invoice line for one size is matched to a catalog row of another.
- The greyed `USD` currency placeholder looks filled in, but review refuses with "missing: currency".
- The audit packet end-date validation message appears twice.

## Not verified on the invoice side

| Item | Why |
|---|---|
| Claude Vision extraction | `ANTHROPIC_API_KEY` not set |
| Invoice B's lines and totals | Depends on Vision |
| Deposits excluded from cost on real data | A has none, B needs Vision. Refusal read in code only |
| Pre-match on a second real upload | Blocked by F6 |
| Approve and post on real data | Only passed with hand-set `pack_size`, so that pass does not count |

## How to re-check

Follow the invoice flow through the UI, against real files, and end at the database. A diagnostic pass with SQL-set values does not count, which is how F1 stayed hidden.

```sql
SELECT COUNT(*) FROM product_cost_history;
SELECT COUNT(*) FROM vendor_alias;
SELECT line_number, raw_gross, raw_discount, raw_net, pack_size FROM invoice_line WHERE invoice_id = ?;
```

Environment notes:

- `docker compose build app` before testing, or the image can lag the branch's `pdf-inspector`. Host `node_modules` may also lag; the container is the reference.
- `scripts/e2e-rig.sh prod` serves a production build on `127.0.0.1:3101` in about 5 minutes. The e2e database name must end in `_e2e`. Never point setup at `truestock`.
- The e2e owner and staff passwords from the QA run were lost, so create fresh accounts. Without them the owner and staff specs skip, and a skip means not verified.
- `verify-browser` leaves a second `Jameson` (1.75 L) in `truestock_e2e`, which breaks `count-flow` with a strict-mode error on re-run. It is deactivated for now, and a re-run will recreate it.

## F2 and F3, for reference

The fix sends all count writes through one lock with older queued writes first, and retries pending writes every 15 seconds while the scan screen is mounted. Evidence and what remains open are in `docs/open-items.md` #46.
