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
  exec bun test
fi

echo "run-tests: no *.test.ts(x)/*.spec.ts files yet — nothing to run."
