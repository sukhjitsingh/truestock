# Status: barcode integrity

One barcode, one bottle size. Fixes 1, 2 and 4 from the 2026-11-05 discussion;
Fix 3 is deferred (see Notes).

- Gate 1 — Product: in progress
- Gate 2 — Architecture: pending
- Gate 3 — Program Design: pending
- Gate 4 — Slice plan: pending

## Slices
(written at Gate 4)

## Notes for a fresh session

**Where this came from.** The owner reported on 2026-11-05 that "the app does
not check the size — I can assign multiple bottle sizes to the same barcode."
Reproduced the same day against a real MariaDB (10.11, in a cloud session —
not the owner's 11.8 Docker) by calling the catalog domain functions directly:

```
082000000019   → Smirnoff 1750 ml   (UPC-A form)
0082000000019  → Smirnoff 200 ml    (EAN-13 form of the same code)
08200019       → Smirnoff 200 ml    (UPC-E form of the same code)
```

The `product_barcode` unique index only refuses an *identical string*, and no
code normalizes a scanned value. Separately, the link screen links on one tap
with no size confirmation.

**What was decided in chat, 2026-11-05 (owner):**

- **In scope:** Fix 1 (recognise a barcode however it is read), Fix 2 (confirm
  the size before linking), Fix 4 (name the size in the "already assigned"
  message).
- **Out of scope for now:** Fix 3 — locking or warning on a back-office size
  change once a product has barcodes or count history. Deferred, not rejected.
  The finding stays true: past counts read the product's *current* `size_ml`
  (`lib/domain/counts.ts` around line 1123), so a size edit silently rewrites
  how history displays. Record it as an open item when this feature closes.
- **Fix 1 must be one self-contained function**, testable without a camera
  (same shape as `lib/rescan-guard.ts`).
- **The scanner passes the barcode's format, and the format is stored** in the
  database (the `product_barcode.format` column exists and is never written today).
- **Do NOT pad to 14 digits (GTIN-14).** The canonical form must be something
  else — proposed in Gate 1, decided at Gate 2/3.
- **Order:** step 0 (CI test fix) → Fix 4 → Fix 2 → Fix 1 (normalizer + tests,
  then scanner passes format, then a one-time conversion of existing barcodes).

**Step 0 is done** — commit `d637cbb` on `claude/mvp-readiness-report-tehzeg`:
`tests/user-write-path.test.ts` and `tests/rapid-scan.test.ts` now migrate in
`beforeAll`. It was trivial, so it skipped the gates per `docs/plans/README.md`.

**Still open (asked 2026-11-05, not yet answered):** see 01-product.md,
"Decisions for the owner".
