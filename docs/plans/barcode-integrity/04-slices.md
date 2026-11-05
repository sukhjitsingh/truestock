# Gate 4 — Vertical slices: barcode integrity

Build order. Each slice ends working, tested and shown before the next starts.
Order follows the owner's "Fix 4 → Fix 2 → Fix 1", behind a tracer that
proves the riskiest unknown first (Gate 3, least confident #6).

1. **Tracer bullet — the format travels end to end, and a browser can scan.**
   Scanner reads `format` and passes it through count-leg to
   `resolveBarcodeAction` and the domain, which accepts it and does nothing
   with it yet. The browser harness launches Chromium with a fake camera
   playing a generated barcode video, and reaches "Which bottle is this?" from
   a real decode. Proves: the plumbing compiles and runs, and the enroll
   screens are browser-testable. If the fake camera cannot be made reliable,
   stop and switch the screen checks to the phone fallback before slice 3.
   **Added by the owner during the slice:** use the built-in reader only if it
   can read retail barcodes, else the app-provided reader with its engine
   served from the app's own origin (it was fetched from a CDN the CSP
   refuses). DONE 2026-11-05 — see `00-status.md`.

2. **One size spelling everywhere.** `formatProductSize` + `kegGallons` with
   their tests; preset lists move to `{ ml, nickname? }` with derived labels;
   the six components stop formatting sizes themselves. Browser check: the
   back-office catalog shows `1.75 L` / `Sixtel keg` and no `…ml` string.

3. **Fix 4 — the refusal names the size, and offers to count the owner.**
   [RED FIRST] the size-in-message DB test against the unchanged code; then the
   shared `barcodeOwnerMessage` helper; then the "Count Smirnoff 750 ml"
   button (re-resolves the barcode). Browser check: a conflict offers the
   button and it opens the owner's entry screen.

4. **Fix 2 — confirm the size before linking.** Picking a search result opens
   the confirm screen instead of linking; size is the largest text; beer's
   bottle/case question moves onto it. Browser checks: a pick writes no
   barcode row until "Link and count"; the size is the largest text.

5. **Fix 2 — "It's a different size".** Create form opened with name,
   category and unit type prefilled, no size preselected, the picked size
   excluded, Save disabled until a size is chosen; carries the bottle/case
   choice. Browser check covers all four.

6. **Fix 1, red — reproduce the bug against a real database.** Add every
   [RED FIRST] test from Gate 3's "one barcode, one product, in any written
   form" block and run them against the unchanged code; record the failure
   output in `00-status.md`. These tests are **not committed on their own** —
   they land in the same commit as slice 7, so the branch never carries a red
   suite. The recorded output is the evidence that they failed first.

7. **Fix 1, green — the normalizer.** `lib/barcode.ts` and its table tests;
   all six domain touchpoints normalize; `format` stored (unknown names →
   null); `scanCountLine` passes `format`. Slice 6's tests go green. Mutation
   check: make the normalizer return its input → exactly those tests fail.
   Browser check: a bottle linked as UPC-A, scanned again as EAN-13 by the fake
   camera, goes straight to counting.

8. **Close-out.** Full suite, typecheck, lint, production build, full browser
   harness. `STATE.md` history entry; `docs/open-items.md` gains the deferred
   Fix 3 (size edits rewrite history and re-point barcodes) and the
   back-to-back `docker:reset` note for the owner's local database;
   `00-status.md` marked done.
