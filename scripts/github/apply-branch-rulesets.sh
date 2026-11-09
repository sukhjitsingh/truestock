#!/usr/bin/env bash
# Applies the branch flow in docs/branching.md to the GitHub repository:
#
#   1. creates `qa-release` from `main` if it does not exist yet
#   2. creates or updates the rulesets in .github/rulesets/*.json, matched
#      to existing rulesets by name (so re-running is safe — it converges)
#
# The JSON files are the source of truth. Change a ruleset by editing its
# file and re-running this, not in the GitHub UI, or the next run reverts it.
#
# Refuses to run until .github/workflows/branch-policy.yml is on main: both
# rulesets REQUIRE the `branch-policy` check, and requiring a check that no
# workflow produces leaves every PR waiting forever on "Expected".
#
# Usage: scripts/github/apply-branch-rulesets.sh [--dry-run]
#   Needs `gh` authenticated as a repo admin.
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

ROOT="$(git rev-parse --show-toplevel)"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
echo "Repository: $REPO$([ "$DRY_RUN" = 1 ] && echo '  (dry run — nothing is changed)')"

run() {
  if [ "$DRY_RUN" = 1 ]; then echo "  would run: $*"; else "$@"; fi
}

# --- Precondition: the check the rulesets require must exist on main -------
if ! gh api "repos/$REPO/contents/.github/workflows/branch-policy.yml?ref=main" --silent 2>/dev/null; then
  echo "REFUSING: .github/workflows/branch-policy.yml is not on main yet." >&2
  echo "Merge the PR that adds it first; otherwise every PR waits on a" >&2
  echo "'branch-policy' check that never reports." >&2
  exit 1
fi

# --- 1. qa-release ----------------------------------------------------------
if gh api "repos/$REPO/branches/qa-release" --silent 2>/dev/null; then
  echo "qa-release: exists — left as it is."
else
  MAIN_SHA="$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha)"
  echo "qa-release: missing — creating it at main ($MAIN_SHA)."
  run gh api -X POST "repos/$REPO/git/refs" \
    -f ref=refs/heads/qa-release -f sha="$MAIN_SHA" --silent
fi

# --- 2. rulesets ------------------------------------------------------------
for file in "$ROOT"/.github/rulesets/*.json; do
  name="$(jq -r .name "$file")"
  id="$(gh api "repos/$REPO/rulesets" --paginate \
        --jq ".[] | select(.name == \"$name\" and .source_type == \"Repository\") | .id" | head -n1)"
  if [ -n "$id" ]; then
    echo "ruleset '$name': updating (id $id) from ${file#"$ROOT"/}"
    run gh api -X PUT "repos/$REPO/rulesets/$id" --input "$file" --silent
  else
    echo "ruleset '$name': creating from ${file#"$ROOT"/}"
    run gh api -X POST "repos/$REPO/rulesets" --input "$file" --silent
  fi
done

# --- 3. Show what GitHub now holds, not what we sent ------------------------
if [ "$DRY_RUN" = 0 ]; then
  echo
  echo "Active rulesets as GitHub reports them:"
  for id in $(gh api "repos/$REPO/rulesets" --jq '.[].id'); do
    gh api "repos/$REPO/rulesets/$id" --jq \
      '"  \(.name) [\(.enforcement)] targets=\(.conditions.ref_name.include|join(",")) checks=\([.rules[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]|join(",")) merge=\([.rules[]|select(.type=="pull_request")|.parameters.allowed_merge_methods[]]|join(","))"'
  done
fi
