#!/usr/bin/env bash
# Enforces open-items.md #6: once a migration file has landed on main, it is
# a record of what actually ran (or will run) against a database that
# matters. From that point on, migrations are append-only — a new file,
# never an edit to one that's already there. See db/README.md's "Migrations"
# section for the full reasoning.
#
# This only looks at *.sql files directly under drizzle/ (the migrations
# themselves). drizzle/meta/_journal.json and drizzle/meta/*_snapshot.json
# are drizzle-kit's own bookkeeping — `drizzle-kit generate` legitimately
# appends to them on every run, so they're deliberately not checked here.
#
# Usage: scripts/check-migrations-immutable.sh [base-ref]
#   base-ref defaults to origin/main. CI calls this with a full history
#   fetch (fetch-depth: 0) so the diff is meaningful.
set -euo pipefail

BASE_REF="${1:-origin/main}"

if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "check-migrations-immutable: '$BASE_REF' not found — skipping (nothing to compare against yet)."
  exit 0
fi

# --name-status against the merge-base, not a two-dot diff, so a PR branch
# that's behind main isn't penalized for changes main already made.
CHANGES="$(git diff --name-status "$(git merge-base "$BASE_REF" HEAD)" HEAD -- 'drizzle/*.sql' || true)"

if [ -z "$CHANGES" ]; then
  echo "check-migrations-immutable: no changes under drizzle/*.sql — OK."
  exit 0
fi

VIOLATIONS=""
while IFS=$'\t' read -r status path rest; do
  [ -z "$status" ] && continue
  case "$status" in
    A*) ;; # new migration file — fine
    M*|D*|R*)
      VIOLATIONS="${VIOLATIONS}  ${status}\t${path}${rest:+ -> $rest}\n"
      ;;
  esac
done <<< "$CHANGES"

if [ -n "$VIOLATIONS" ]; then
  echo "check-migrations-immutable: FAILED"
  echo ""
  echo "The following already-applied migration file(s) were modified, renamed, or deleted:"
  echo ""
  printf '%b' "$VIOLATIONS"
  echo ""
  echo "Migrations are append-only once they've landed on main (open-items.md #6,"
  echo "db/README.md 'Migrations'). Add a new migration to make the change instead"
  echo "of editing an existing one — and if this specific edit is a deliberate,"
  echo "pre-launch exception, say so explicitly rather than silently overriding this check."
  exit 1
fi

echo "check-migrations-immutable: OK."
