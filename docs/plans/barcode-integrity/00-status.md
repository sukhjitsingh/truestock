# Status: barcode integrity

One barcode, one bottle size. Fixes 1, 2 and 4 from the 2026-11-05 discussion;
Fix 3 is deferred (see Notes).

- Gate 1 — Product: APPROVED 2026-11-05
- Gate 2 — Architecture: APPROVED 2026-11-05
- Gate 3 — Program Design: APPROVED 2026-11-05
- Gate 4 — Slice plan: APPROVED 2026-11-05

## Slices
- [x] Slice 1 — tracer: format travels end to end; fake camera reaches the enroll screen;
      built-in reader if usable, else the app-provided reader served same-origin
- [x] Slice 2 — one size spelling everywhere
- [ ] Slice 3 — Fix 4: refusal names the size, offers to count the owner
- [ ] Slice 4 — Fix 2: confirm the size before linking
- [ ] Slice 5 — Fix 2: "It's a different size"
- [ ] Slice 6 — Fix 1 red: reproduce the bug in DB tests (evidence recorded, not committed alone)
- [ ] Slice 7 — Fix 1 green: the normalizer, format stored, mutation-checked
- [ ] Slice 8 — close-out: full checks, STATE.md, open items

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

## Slice 1 findings (2026-11-05)

**The fake camera works.** `scripts/lib/fake-barcode-camera.mjs` renders a
real EAN-13/UPC-A (and UPC-E) into a `.y4m` that Chromium plays as its webcam.
The app's own scanner decoded it in headless Chromium and reached "Which bottle
is this?" in ~300 ms, and the server action received
`{"barcode":"0082000000013","format":"ean_13"}`.

**Real-decoder evidence for Fix 1.** The video encoded the 12-digit UPC-A
`082000000013`; the ZXing polyfill reported it as the 13-digit EAN-13
`0082000000013`. So the decoder this handset uses returns a UPC-A as a string
that differs from the printed number — the bug's mechanism, observed.

**Blocker found: the polyfill cannot load its engine under the app's CSP.**
`zxing-wasm` 3.1.1 fetches `zxing_reader.wasm` from
`fastly.jsdelivr.net` by default, and `middleware.ts` serves
`connect-src 'self'`, so on any browser without a native `BarcodeDetector`
the scanner aborts ("both async and sync fetching of the wasm failed"). The
CSP comment in `middleware.ts` already *assumes* a same-origin `.wasm`; nothing
ever set that up. A prototype — `prepareZXingModule({ overrides: { locateFile }})`
pointing at `/zxing/zxing_reader.wasm` copied from `node_modules` — made the
scan work under the production CSP. Not committed: it is a scope addition and
awaits the owner. STATE.md's 2026-08-12 claim of a polyfill decode under the
production CSP conflicts with this and should be re-checked on the handset.

**Resolved by the owner, 2026-11-05:** "check if a built-in barcode reader is
present; if not, use the app-provided reader as a fallback." Implemented in
slice 1:

- `lib/barcode-reader.ts` — `chooseBarcodeReader`: the built-in
  `BarcodeDetector` is used only if it exists **and** `getSupportedFormats()`
  includes all four retail formats (UPC-A, UPC-E, EAN-13, EAN-8). A built-in
  reader that cannot read retail codes counts as not present.
- Otherwise the app-provided reader (`barcode-detector` polyfill) loads its
  engine from `/zxing/zxing_reader.wasm` on this app's origin, and the
  scanner **waits for it** — a load failure now shows an error instead of a
  camera that silently never reads.
- `scripts/copy-zxing-wasm.mjs` copies the engine out of `node_modules` on
  every `dev` and `build` (covers local, Docker, CI, deploy). `public/zxing/`
  is git-ignored, so the file cannot drift from the installed version;
  `tests/barcode-reader.test.ts` checks the copy against the package's own
  published `ZXING_WASM_SHA256`.
- Browser harness: a fake-camera section deletes `window.BarcodeDetector`
  (so the app reader is what is tested even on a Mac whose Chrome has a
  built-in one), scans a generated UPC-A, and asserts: reached "Which bottle is
  this?", the server action carried `format`, no CSP violation.

**Evidence (2026-11-05, production standalone build, local MariaDB 10.11):**
harness 42/44 — the 3 new checks pass; the 2 failures are the pre-existing
data-dependent stock checks (no closed count in that database). Negative
control: with the engine file removed from the running server, the scan and
format checks FAIL. Rule mutation (accept any built-in reader) fails exactly
the 2 relevant unit tests. Suite 218/218.

**Not verifiable here:** the built-in-reader branch. Headless Chromium on
Linux has no `BarcodeDetector`; it needs a phone or Mac Chrome. Preflight now
reports "Built-in present" / "App reader".
