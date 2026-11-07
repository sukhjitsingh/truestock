---
name: turbopack-cold-compile-exceeds-playwright-networkidle-timeout
description: A never-before-hit dev route can take 20-30s+ to Turbopack-compile in this project's Docker dev stack, which blows past Playwright's default waitForURL/goto timeouts and looks like a broken feature when it is only a cold cache
metadata:
  type: feedback
---

Hit running `scripts/verify-browser-slice4.mjs` against the isolated worktree
stack (`docker-compose.worktree-test.yml`, `next dev -H 0.0.0.0` inside
Docker, "Slow filesystem detected" warning present). First-ever hits of
`/api/auth/[...all]` (POST sign-in) and `/office/invoices/[id]` each took
20-31 seconds to compile server-side in this container (`next.js: 24.0s` etc.
in the dev server's own request-timing log) — both exceeded the calling
script's default timeout (`page.waitForURL(..., {timeout: 20000})` on
sign-in; `page.goto(..., {waitUntil: "networkidle", timeout: 30000})` on
navigation) and surfaced as `FAIL sign-in succeeds` / a thrown
`page.goto: Timeout 30000ms exceeded`, even though the server-side log showed
the request completed and returned 200 moments later.

**Why this looked like a real bug at first:** the failure mode is
indistinguishable from an actually-broken route from the test output alone —
no error, just a timeout — and it happened on the FIRST run against a
freshly-started container, which is exactly when a real regression would
also first surface.

**How to apply:** if a browser-verification script against this project's
`next dev` Docker stack fails with a `waitForURL`/`goto` timeout on the FIRST
route hit of a fresh container (sign-in, or the first navigation to a route
not yet visited this container lifetime), re-run once before concluding
anything is broken — a second run against the now-warm Turbopack cache is the
real signal. Don't raise the client-side timeout as the fix; that just makes
a real hang take longer to report. If a SECOND run against a warm cache still
times out, that is the real finding. Also: any scratch/fixture DB rows a
timed-out run's cleanup pass didn't reach (this project's verify scripts only
clean up in a `finally` block after all checks run) should be deleted by hand
before the retry, or the retry's own evidence gets mixed with the aborted
run's half-applied fixtures.
