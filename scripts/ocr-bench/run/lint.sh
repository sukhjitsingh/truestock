#!/usr/bin/env bash
# Lints scripts/ocr-bench with the repo's own eslint config, inside the app image (the worktree itself never gets a
# node_modules: it is mounted at /app with anonymous volumes over node_modules and .next).
#   lint.sh            eslint scripts/ocr-bench --max-warnings 0, a non-vacuity probe (eslint must flag a bad snippet
#                      and must report on every .mjs here), and a proof that root tsc does not see these files
set -uo pipefail
WT="$(cd "$(dirname "$0")/../../.." && pwd)"
CMD="bun install --frozen-lockfile >/dev/null 2>&1
echo '=== eslint scripts/ocr-bench ==='
bunx eslint scripts/ocr-bench --max-warnings 0 2>&1 | tail -60
echo \"eslint exit=\${PIPESTATUS[0]}\"
echo '=== probe: files eslint reports on (json) vs .mjs files present ==='
bunx eslint scripts/ocr-bench --format json 2>/dev/null | grep -o '\"filePath\"' | wc -l
find scripts/ocr-bench -name '*.mjs' | wc -l
echo '=== probe: eslint flags a deliberately bad snippet (expect non-zero exit) ==='
printf 'function f() {\n  if (globalThis.a) useState();\n}\nf();\n' | bunx eslint --stdin --stdin-filename scripts/ocr-bench/lib/zz-probe.mjs --max-warnings 0 2>&1 | tail -8
echo \"probe exit=\${PIPESTATUS[1]}\"
echo '=== tsc: files listed in total / under scripts/ocr-bench ==='
bunx tsc --noEmit --listFilesOnly 2>/dev/null | grep -vc node_modules
bunx tsc --noEmit --listFilesOnly 2>/dev/null | grep -c 'scripts/ocr-bench' || true
echo '=== tsc --noEmit (whole repo) ==='
bunx tsc --noEmit 2>&1 | tail -15
echo \"tsc exit=\${PIPESTATUS[0]}\""
docker run --rm --entrypoint bash \
  --network truestock_default \
  -v "$WT":/app -v /app/node_modules -v /app/.next -w /app \
  -e DATABASE_URL=mysql://truestock:truestock@db:3306/truestock_test \
  -e BETTER_AUTH_SECRET=verify-only-not-a-real-secret-0123456789abcdef \
  -e BETTER_AUTH_URL=http://localhost:3000 \
  truestock-app:latest -c "$CMD"
