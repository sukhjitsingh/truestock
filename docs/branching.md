# Branching and release flow

Decided 2026-11-09. `main` is production: every push to it starts `deploy.yml`.
Nothing reaches `main` except a tested release from `qa-release` or a hotfix.

```
feature/*  bugfix/*  fix/*  chore/* …
      │  PR (squash or merge)
      ▼
  qa-release ──── PR (merge commit) ────▶ main ──▶ deploy.yml (approval gate)
      ▲                                    ▲  │
      │  PR: back-merge (merge commit)     │  │
      └────────────────────────────────────┼──┘
                                           │  PR (merge commit)
                                       hotfix/*   ← the only bypass
```

## The rules, and what enforces each

| Rule | Enforced by |
|---|---|
| Into `main`: only `qa-release` or `hotfix/*`, from this repo (not a fork) | `branch-policy` check (`.github/workflows/branch-policy.yml`), required on `main` |
| Into `qa-release`: work branches (`feature/ feat/ bugfix/ fix/ chore/ docs/ test/ refactor/ perf/ ci/ build/ claude/`) or `main` (back-merge) | `branch-policy` check, required on `qa-release` |
| No direct push, force push or deletion on either branch, no bypass | Rulesets `main` and `qa-release` (`.github/rulesets/*.json`) |
| `verify`, `e2e-smoke`, `actionlint` green before any merge into either | Same rulesets |
| `main` accepts **merge commits only** | `main` ruleset (`allowed_merge_methods: merge`) |
| A release PR must contain everything already on `main` | `main` ruleset: *require branches up to date* (strict) |

The prefix list is defined once, in `branch-policy.yml` (`QA_PREFIXES`). To allow a new
kind of branch, add it there and to the table above.

## Day to day

**A feature or bug fix**
```bash
git switch -c feature/par-by-location origin/qa-release
# … work, commit …
gh pr create --base qa-release
```
Squash or merge, either is fine into `qa-release`.

**A release** (when `qa-release` has been checked and is ready for production)
```bash
gh pr create --base main --head qa-release --title "release: 2026-11-09"
```
Merge with **Create a merge commit** — it is the only method `main` allows. Then
approve the `release` job in Actions as usual (`docs/deploy.md` §5).

**A hotfix** (production is broken and `qa-release` holds unreleased work you cannot ship yet)
```bash
git switch -c hotfix/login-500 origin/main
# … the smallest fix, with its test …
gh pr create --base main
```
After it merges and deploys, **back-merge `main` into `qa-release` the same day:**
```bash
gh pr create --base qa-release --head main --title "chore: back-merge main after hotfix/login-500"
```
Merge that with **Create a merge commit**, never squash. If it conflicts, `main` cannot be
edited, so resolve on a branch instead:
```bash
git switch -c chore/back-merge-login-500 origin/qa-release
git merge origin/main        # resolve, commit
gh pr create --base qa-release
```
and merge *that* with a merge commit too.

## Why merge commits on the release path, and why it matters

`main`'s ruleset requires a release PR to be up to date with `main`, which means every
commit on `main` must already be an ancestor of `qa-release`. Squash and rebase both
write **new** commits on the target, so:

- a squashed release leaves `main` holding a commit `qa-release` never had — the next
  release PR is "out of date" and has to be back-merged first;
- a squashed back-merge leaves `qa-release` without `main`'s real commits — the release
  PR stays "out of date" however many times you back-merge.

`main` refuses everything but merge commits, so the first cannot happen. The second
cannot be blocked by a ruleset (`qa-release` must accept squash for feature PRs), so it
is on you: **back-merges are always merge commits.** If a release PR says it is out of
date, that is the symptom — back-merge `main` with a merge commit.

## Why `qa-release` is not "strict"

`qa-release` does not require a PR's branch to be up to date before merging. If it did,
the back-merge PR (`main` → `qa-release`) could never merge: `main` would have to
contain `qa-release`'s tip first, and `main` can only change through a PR. The cost is
that two feature PRs can each be green alone and conflict together. That is caught by
CI on the push to `qa-release` (`ci.yml` runs on it) and again by the strict release PR
into `main`.

## Setting it up, and changing it

The rulesets live in `.github/rulesets/*.json` and are applied by:
```bash
scripts/github/apply-branch-rulesets.sh --dry-run
scripts/github/apply-branch-rulesets.sh
```
It creates `qa-release` from `main` if missing, then creates or updates each ruleset by
name. Edit the JSON and re-run it. Do not edit them in the GitHub UI, because the next
run overwrites the UI change. The script refuses to run until `branch-policy.yml` is on
`main`. Before that, a required `branch-policy` check would leave every PR waiting
forever.

**Emergency with CI itself broken.** There is no bypass list, as decided on 2026-11-08
(`docs/deploy.md` §3). If CI cannot go green, switch the `main` ruleset to *Disabled*
for the minute it is needed, then re-run the script to restore it.

## What this does not do

- **No QA environment.** `qa-release` is tested by CI and by you on the local rig
  (`bun run e2e`, the phone on `docker:up:lan`). Nothing deploys it to a server. A
  staging deploy on push to `qa-release` would be a separate Hostinger site plus a
  `staging` GitHub Environment. That is not built.
- **No automatic back-merge.** A PR opened by `GITHUB_TOKEN` does not trigger other
  workflows, so an auto-opened back-merge PR would sit forever waiting for its required
  checks. Opening it by hand, as shown above, avoids that.
