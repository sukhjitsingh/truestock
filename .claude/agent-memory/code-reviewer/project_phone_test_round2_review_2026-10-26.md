---
name: phone-test-round2-review-2026-10-26
description: Review of fix/phone-test-round2 (RefreshOnOpen, count-leg holdBusyOnOk, enroll hint, phone:observe) - recurring patterns around router.refresh() and mounting conditions
metadata:
  type: project
---

Review of uncommitted changes on fix/phone-test-round2 (2026-10-26). Invariants 1 and 5 untouched/sound.

Recurring patterns worth rechecking on any future "refresh the stale page" or client-router change:

- **`router.refresh()` offline is a hard navigation in Next 16.4.3.** `fetch-server-response.js` only waits-and-retries when the experimental `__NEXT_USE_OFFLINE` flag is on (off by default, `define-env.js`); otherwise a failed RSC fetch returns the URL as an MPA navigation (`app-router-state.js` ~261 -> `location.replace`). The repo has no service worker, so the result is Chrome's offline error page. Any effect that calls `router.refresh()` unconditionally (mount, visibilitychange) needs a `navigator.onLine` / probe guard in an app that is designed to count offline.
- **A mounting condition that is "only when there is data" excludes the empty state**, which is the state that goes stale when the user starts something and comes back. `/count` home mounted `RefreshOnOpen` only if `activeCount` existed; a restored "no active count" snapshot shows "Start a count" again, and `openCount` (lib/domain/counts.ts) has no single-open-count guard, so a second draft count gets created. Check both branches of any conditional mount.
- `useRouter()` returns the module singleton `publicAppRouterInstance`, so `[router]` effect deps are stable and cannot loop; `router.refresh()` preserves client state (no remount).
- `busy`-style state held across an await and released by the caller: check the throw path (IndexedDB enqueue/dequeue rejection) - `runWrite` still strands `busy` true on a throw (pre-existing).
- Observer tooling: `summary.md` footer asserts "Never recorded: typed values, password fields" while screenshots are raw pixels (the docs carry the caveat, the generated file does not). Same class as ui-copy-asserting-unbacked-guarantees.
