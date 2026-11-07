#!/usr/bin/env bash
# `bun test` exits non-zero when zero test files match, which would make the
# "tests" step of CI permanently red until someone writes a test — the
# opposite of a useful gate. This script no-ops (exit 0) only when there are
# genuinely no test files yet, and defers to `bun test` — full exit code and
# all — the moment any exist, anywhere in the repo. Once real tests land,
# this file stops being interesting; it exists purely to bridge the gap
# between "CI must run tests" (CLAUDE.md) and "no tests exist yet" (true as
# of the initial deploy pipeline).
set -euo pipefail

if find . -path ./node_modules -prune -o \
    \( -iname "*.test.ts" -o -iname "*.test.tsx" -o -iname "*.test.js" -o -iname "*.spec.ts" \) \
    -print -quit | grep -q .; then
  # --timeout 30000, because bun's own default is 5 s per test AND per hook, and
  # the DB-backed suites sit close to it: the Docker MariaDB intermittently
  # stalls a single statement for 2-5 s (measured 2026-10-26: an INSERT at
  # 3.0 s, TRUNCATEs at 2.3 s and 4.6 s, nothing locked in the processlist).
  # bun does not abort a hook that times out, so the next test starts while
  # the previous resetDatabase() is still truncating, and the run then fails
  # with FK / "Duplicate entry" errors that read like real bugs.
  # It has to be this CLI flag: bun 1.4.0 ignores `timeout` in bunfig.toml,
  # and `setDefaultTimeout()` from a preload or a shared helper only governs
  # the first test file loaded. test:docker in package.json carries it too.
  exec bun test --timeout 30000 "$@"
fi

echo "run-tests: no *.test.ts(x)/*.spec.ts files yet — nothing to run."
