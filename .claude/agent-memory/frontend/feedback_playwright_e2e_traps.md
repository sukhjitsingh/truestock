---
name: playwright-e2e-traps
description: Playwright runner traps hit building the Truestock e2e suite (e2e/): favicon route/observe quirk, array-returning fake BarcodeDetector, TanStack sort order, flexRender remount, .env.e2e.example gitignore
metadata:
  type: feedback
---

The e2e suite lives in `e2e/` (specs `*.e2e.ts`, run with `E2E_ENV_FILE=... bun run e2e`, README in `e2e/README.md`). Traps worth knowing before touching it:

- **Fake `BarcodeDetector.detect()` must resolve an ARRAY.** The app does `results.find(...)` inside a try/catch that swallows per-frame errors, so a bare-object fake looks exactly like a camera that sees nothing. **How to apply:** any new fake camera helper returns `[{ rawValue, format, boundingBox, cornerPoints }]`.
- **Requests to exactly `/favicon.ico` cannot be observed or intercepted** by `page.route` / `page.on('request')` (same URL with a query string can). RefreshOnOpen's HEAD probe therefore can't be blocked to mutation-test it. **How to apply:** simulate offline with an init script setting `navigator.onLine = false`; that reproduces the stale-hub-after-Back bug.
- **Mutation-check by actually breaking the thing.** Two of the first-draft regression tests passed with the fix removed (one failed for an indirect reason). Say honestly in the test comment when sensitivity is by analysis only.
- **TanStack's alphanumeric sort puts "1800 Silver" last ascending.** Assert order with comparator-free checks (aria-sort state, ascending vs descending first pages disjoint, third click restores original), never JS string compare.
- **`flexRender` mounts function cell renderers as components**; the catalog cost cell loses its "Saved" state because the columns memo rebuilds on `visibleIds` after `patchRow`. Recorded as a `test.fail()` known-defect probe in `office-catalog.e2e.ts`. Delete the `test.fail` line when fixed.
- **`.env*` in `.gitignore` swallows `.env.e2e.example`**; the negation `!.env.e2e.example` is required.
- Prod CSP has no `unsafe-eval`: never `page.waitForFunction`; poll with `page.evaluate`. Sign-in is rate limited (3/10s): sign in once per role in global setup and reuse `storageState`.
- `rm` is interactive in this shell: use `/bin/rm -f`. The sandbox refuses complex heredocs, python one-liners and commands mentioning git in compound form; use Write for scripts.
