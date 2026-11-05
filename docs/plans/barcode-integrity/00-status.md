# Status: barcode integrity

One barcode, one bottle size. Fixes 1, 2 and 4 from the 2026-11-05 discussion;
Fix 3 is deferred (see Notes).

- Gate 1 — Product: APPROVED 2026-11-05
- Gate 2 — Architecture: APPROVED 2026-11-05
- Gate 3 — Program Design: in progress
- Gate 4 — Slice plan: pending

## Slices
(written at Gate 4)

## Notes for a fresh session

**Where this came from.** The owner reported on 2026-11-05 that "the app does
not check the size — I can assign multiple bottle sizes to the same barcode."
Reproduced the same day against a real MariaDB (10.11, in a cloud session —
not the owner's 11.8 Docker) by calling the catalog domain functions directly.
Three different strings went onto two different sizes:

```
082000000019   → Smirnoff 1750 ml
0082000000019  → Smirnoff 200 ml
08200019       → Smirnoff 200 ml
```

**Correction, recorded rather than rewritten:** those were hand-typed strings,
and they are NOT valid encodings of one code — `082000000019` fails its check
digit, and `08200019` expands to `082100000009`, not to it. What the run DOES
prove is the mechanism: the `product_barcode` unique index refuses only an
identical string, and no code normalizes a scanned value, so two encodings of
one code would both be accepted. A valid example, checked by computing the
GS1 check digit and the UPC-E expansion, used in every doc from here on:

```
UPC-A   082000000013
EAN-13  0082000000013
UPC-E   08200103        (expands to 082000000013)
GTIN-14 00082000000013  (the stored standard form)
```

Gate 3's test plan must reproduce the bug with THESE strings against the
pre-change code before the fix, so the test is known to fail first.
Separately, the link screen links on one tap with no size confirmation.

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
- **Standard form: padded to 14 digits (GTIN-14), and the format is recorded
  too.** Decided by the owner 2026-11-05, reversing an earlier "do not pad to
  14" from the same day after the two fields were explained. The stored
  barcode is always the standard 14-digit form; the format column records
  what kind of barcode the camera said it read (`upc_a`, `ean_13`, `upc_e`,
  ...). The owner confirmed they understood that saving the barcode "in the
  format it was read" would leave three different strings for one bottle,
  which is the bug. Rejected alternative: keep the raw digits and compare
  standard forms only in app code — the database's unique index would then
  stop identical text only.
- **Order:** step 0 (CI test fix) → Fix 4 → Fix 2 → Fix 1 (normalizer + tests,
  then scanner passes format).
- **No conversion script** (owner, 2026-11-05, during Gate 2): there is no
  production database yet. Local Docker rows enrolled before this ships stay
  raw and stop resolving; reset the local database after it ships. Supersedes
  Gate 1 decision 4.

- **Size display (owner, during Gate 3):** `750 ml` under a litre, `1.75 L`
  from a litre up, kegs by name (`Sixtel keg` / `Quarter barrel keg` /
  `Half barrel keg`, gallons as a secondary line). Applied **everywhere a size
  is printed**, back office included, via one formatter — "so everything stays
  the same". Gates 1 and 2 carry a dated amendment for this rather than being
  reopened.

**Step 0 is done** — commit `d637cbb` on `claude/mvp-readiness-report-tehzeg`:
`tests/user-write-path.test.ts` and `tests/rapid-scan.test.ts` now migrate in
`beforeAll`. It was trivial, so it skipped the gates per `docs/plans/README.md`.

**Still open (asked 2026-11-05, not yet answered):** see 01-product.md,
"Decisions for the owner".
