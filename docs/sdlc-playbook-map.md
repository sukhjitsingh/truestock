# Truestock against the AI-native SDLC playbook

Evaluated 2026-11-08 against `main` at `9ca9bb8` (PR #37, Phase 2.5 merged), using
Anthropic's [AI-native SDLC playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook)
(2026-08-21). This is a point-in-time assessment, not a living doc: `STATE.md`,
`ROADMAP.md` and `docs/open-items.md` stay authoritative for status and sequencing.

**Context that shaped every recommendation below** (owner answers, 2026-11-08):

- The team is **one human plus Claude** — sessions and subagents write and review, the
  owner merges.
- At go-live the owner wants **merge to `main` to stay cheap, with production behind a
  one-click manual release approval.**
- The time drains to fix, in the owner's words: **reviewing agent output**, **rework
  after bugs**, and **session startup / context**. Gate ceremony was *not* named as a
  drain, so the 4-gate workflow is kept as is.

---

## Verdict in four sentences

Truestock is **ahead of the playbook on Plan, Design and the test suite**, and
**behind it on everything that turns prose into enforcement**: no `.claude/settings.json`
(no hooks, no permission allowlist), no `REVIEW.md`, no independent PR review, browser
tests that exist but don't run in CI, and a deploy pipeline with no release gate. Nearly
every rule this project learned the hard way lives as a paragraph an agent must read,
remember and choose to follow — which is exactly why reviewing output and rework are
the drains. The cheapest, highest-leverage moves are (1) cutting the always-loaded
context by roughly 80%, (2) making the four or five most expensive lessons deterministic
(hooks and CI), and (3) moving review out of the authoring session. None of it needs a
new tool beyond what the repo already has.

---

## How Truestock's artifacts map to the playbook's

| Playbook artifact | Truestock equivalent | Status |
|---|---|---|
| `intent.md` (Plan) | `docs/plans/<slug>/01-product.md` + `mockups/`; owner reports via `docs/qa/*.md` | ✅ Stronger — mockups and a one-number success metric |
| `spec.md` (Design) | `02-architecture.md` + `03-program-design.md`; project-wide `docs/spec.md` | ✅ Stronger — Gate 3 fixes types/signatures and "least confident decisions" before code |
| `plan.md` (Build) | `04-slices.md` + `00-status.md` checklist with commit SHAs | ✅ Equivalent; resume rule is better than the playbook's |
| `CLAUDE.md` (< 1 page) | `CLAUDE.md` → `@AGENTS.md`, **422 lines / ~33 KB** | ⚠️ ~10× the recommended size |
| Skills `.claude/skills/` | `.claude/commands/{ship,invariants}.md` | ⚠️ Works; legacy format, only two |
| Subagents `.claude/agents/` | 7 agents, project memory (61 memory files) | ✅ |
| Hooks, permissions | **none** — no `.claude/settings.json` | ❌ |
| Verification block in CLAUDE.md | scattered: "verify UI in a browser", `/ship`, gate rules | ⚠️ No single "run these, paste output" rule |
| One-command checks | `bun run typecheck / lint / test / e2e / build` | ✅ |
| Failing test first | Barcode-integrity slices 6→7; `test.failing` known-defect pins | ✅ Already practised |
| Browser feedback loop | `e2e/` Playwright rig, `verify-browser*.mjs`, `phone:observe` | ✅ Local; ❌ not in CI |
| Evals for agent config | none | ❌ (low priority for a solo project — see Tier 3) |
| `REVIEW.md` + AI PR review | none; reviewers run inside the authoring session | ❌ |
| Separation of duties | same session writes and reviews; owner merges | ⚠️ |
| Hooks as approval gates / prod gate | none; `deploy.yml` ships every merge to `main` | ❌ (never run — nothing deployed yet) |
| One-command rollback | `rollback.yml` from release artifacts | ✅ Built; never rehearsed |
| `bands.yaml`, scheduled scans, lessons file | none; `STATE.md` history log is the lessons file | ❌ Expected pre-launch |

---

## Stage-by-stage

### 1 · Plan — **strong**

The 4-gate workflow (`docs/plans/README.md`) is the playbook's Plan→Design→Build chain
with one extra gate. Six plan folders exist; approvals are dated in `00-status.md`.
Owner-reported problems enter the loop properly: the 2026-11-05 barcode report went
Gate 1→4→shipped in one day, and the 2026-11-06 QA handoff became
`docs/plans/invoice-qa-fixes/` the same day.

*Gap:* none worth building. The playbook's "intent survival rate" metric is already
visible in git (every plan folder so far shipped).

### 2 · Design — **strong**

Gate 3 is the step the playbook doesn't have and the one that most reduces mid-build
surprises. The `phase-2.5-backend-followons` backtrack note (a Gate 3 finding sent
Gates 1–2 back for re-approval) is the playbook's "spec.md commits after plan.md"
rework signal, handled correctly.

*Gap:* the playbook's "org skills for security/compliance/UX" are here as agent prompts
and `docs/design-system.md` — fine at this size.

### 3 · Build — **mixed**

Good: Gate 4 tracer-bullet slices, a defined subagent order, worktree-safe Docker
(`docker-compose.worktree-test.yml`), conventional commits.

Gaps, in order of cost to you:

1. **Context load.** `AGENTS.md` instructs every agent to read `docs/spec.md` (735 lines),
   `docs/open-items.md` (2,305) and `STATE.md` (1,409) *before any non-trivial work*, on
   top of the 422-line `AGENTS.md` itself — roughly **4,900 lines before the first
   edit**, and ~20,700 lines of markdown in the repo against ~32,000 lines of source. The
   playbook's reason for the one-page rule: *"anything stale is taking up context for no
   benefit."* This is the **session startup** drain, and it also feeds **rework**: a
   model holding 5,000 lines of history follows any one rule less reliably.
2. **Nothing is enforced.** Every invariant and working agreement is advisory. The
   playbook: *"a skill is a control, though an advisory one"* — must-hold rules need a
   hook or a CI check. Truestock already proved this on itself: the CSP-in-`headers()`
   break, GET-method login form, row-`onClick` and raw-barcode bugs were each a written
   rule *after* the fact, and each would be cheaper as a check.
3. **No permission allowlist**, so routine read-only commands prompt.
4. **Sequential-only backend/frontend** ("they will collide in `app/`"). Worktrees
   already solve this for independent slices; the rule can relax to "same files ⇒ same
   session".

### 4 · Test — **strong locally, gap in CI**

83 test files against a real MariaDB 11.8 in CI, a migrations-immutable check, a
`known-defects` suite pinned with `test.failing`, mutation-checked invariant tests, a
hermetic Playwright rig with a fake camera. This is better than the playbook's baseline.

Gaps:

1. **`bun run e2e` is not in CI** (`.github/workflows/ci.yml` runs typecheck, lint, unit,
   migrations, build). The project's own top lesson is *"a 200 is not evidence that a
   page works"*, and the one class of failure the e2e smoke spec exists to catch — the
   app renders and nothing hydrates — is the one CI cannot currently see. This is the
   biggest single **rework** lever.
2. **CI uses `bun-version: latest`**, so a green PR and a green deploy can run different
   toolchains. Pin it to the version `bun.lock` was built with.
3. **No "definition of done" with evidence.** The playbook's verification block — run
   the checks, paste the output, fix the code not the test — is what turns
   *reviewing agent output* from reading diffs into reading evidence.

### 5 · Deploy — **weak (and untested)**

1. **Review happens in the authoring session.** `code-reviewer` and `security-reviewer`
   run as subagents of the session that wrote the diff, guided by the same context. The
   playbook's rule — *the agent that wrote the code cannot approve it* — is about fresh
   context as much as identity. With one human, an independent AI review on the PR is
   the only second pair of eyes you have.
2. **No `REVIEW.md`**, so there's no stated bar for Important vs Nit or for what to skip.
3. **`deploy.yml` has no release gate**: merge → migrate production DB → deploy. You've
   asked for a manual approval; note the gate must sit **before `migrate`**, the first
   job that touches production.
4. **Rollback has never been rehearsed**, and the deploy pipeline has never run.

### 6 · Maintain — **not started (expected)**

No error monitoring, uptime check, scheduled scans or incident→test loop yet. The
project already has the *habit* the playbook wants — every escaped bug becomes a test
and a dated line in `STATE.md` — it just isn't triggered by anything automatic.

---

## What is driving your three drains

| Drain | Root cause in this repo | Fix (tier below) |
|---|---|---|
| **Reviewing agent output** | Output arrives as diffs + prose claims; no standard evidence; review is in the same context that wrote it | Verification block (1.3), PR template "Proof" section (2.4), independent AI PR review with `REVIEW.md` (2.1) |
| **Rework after bugs** | Rules are prose, not checks; browser tests not in CI; 75 `fix` commits vs 63 `feat` in history | Hooks for the expensive lessons (1.2), e2e smoke in CI (1.4), known-defect #1 before Phase 2.9 (1.6) |
| **Session startup / context** | ~4,900 lines required reading; `AGENTS.md` mixed rules with incident narratives (and carried a stale 175-line duplicate until this commit) | Slim the always-loaded core (1.1), split `STATE.md` history out (1.1) |

---

## Recommended changes

### Tier 0 — done in this commit

- **Removed the stale duplicate in `AGENTS.md`** (lines 419–593, an older copy of
  "The catalog" through "CodeGraph" introduced by `1b758bc`, missing the
  `normalizeBarcode`, `formatProductSize` and zxing rules). 593 → 418 lines (422 with the CodeGraph note); nothing
  unique was lost (diff-checked).
- **`/invariants` now audits every invariant in `AGENTS.md`**, not "the eight in
  `CLAUDE.md`".
- **`code-reviewer` checklist extended from 8 to 11** — tenant isolation (#9), waste
  factor (#10) and session revocation (#11) were missing; #6 now includes the
  write-path rule.
- **`security-reviewer` gained a tenant-isolation item** — it had none.
- **CodeGraph section says the index is local-only** and to fall back to grep when
  `.codegraph/` is absent (it is in every cloud session and fresh worktree).

### Tier 1 — before Phase 2.9 starts — **DONE 2026-11-08**

All six landed on `claude/project-sdlc-evaluation-fr1klo`, one commit each, in a
single PR (owner decision). Status per item:

| Item | Commit | Proof |
|---|---|---|
| 1.1 Slim the context | `ab6ca01` (STATE split), `af00f6e` (AGENTS.md → core + `docs/lessons.md`) | `AGENTS.md` 35.7 KB → 16.0 KB; `STATE.md` 1,409 → 615 lines; every old paragraph checked as kept, moved verbatim, or condensed; 19/19 lesson links resolve |
| 1.2 Settings + hooks | `b42f77d`, review fixes `0ab2ab5` | 20 tests incl. end-to-end; live-fired (an edit to an applied migration was refused); 0 warnings on the 72 existing `.tsx` files; each review fix mutation-checked |
| 1.3 Verification block | `af00f6e` ("Commands and the definition of done") | — |
| 1.4 e2e smoke in CI | `9804782` | Job's own steps rehearsed locally: 26/26; nonce removed from `lib/csp.ts` → exit 1, `"form" never hydrated`. **Green on GitHub** (PR #38 run #68, 26/26), after `10256ee` fixed a workflow-level error that had stopped run #67 from starting |
| 1.5 Pin Bun | `ede08dd` | Pinned to **1.4.0** (the Dockerfile's version, not 1.4.4); suite 1,397 pass / 0 fail on 1.4.0 |
| 1.6 Known defect #1 | `530d632`, docs `1f47a69` | A1–A3 now regression guards; mutation-checked two ways; owner decision: write-path refusal only |

Found along the way: on Next 16.4 a static CSP in `next.config.ts` *beside* the
middleware's is replaced, not intersected (recorded in `docs/lessons.md`); the
catalog path in AGENTS.md pointed at a file that never existed.

The original plan, as proposed:


**1.1 Slim the always-loaded context.** *(Build · startup drain)*
- Cut `AGENTS.md` to a ~1–2 page core: one-line product, stack + must-not-drift config,
  the 11 invariants as one-liners, working agreements as one-liners, commands, the
  verification block, and pointers. Move each incident story ("this shipped on
  2026-08-12 and…") to `docs/lessons.md`, linked by heading. The rule stays in front of
  every session; the *why* is one `grep` away.
- Change "read spec, open-items and STATE before any non-trivial work" to: read
  `STATE.md`'s *One-line status* and the active `docs/plans/<slug>/` folder; look up
  `open-items.md` entries by number when cited.
- Move `STATE.md`'s dated history below the status sections into
  `docs/history/state-log.md`; `STATE.md` keeps only "proven / built-not-proven / next".

**1.2 Add `.claude/settings.json` — allowlist plus a few fast hooks.** *(Build · rework)*
Allow the safe inner loop (`bun run typecheck|lint|test|build|e2e`, `git status|diff|log`,
`docker compose exec …`) so read-only work doesn't prompt; deny reading `.env*` except
the `.example` files. Then hook only the lessons that already cost a bug, and keep each
check under a second:

| Hook (PreToolUse on Edit/Write unless noted) | Lesson it enforces |
|---|---|
| Block edits to an existing `drizzle/*.sql` migration | migrations are append-only (also checked in CI — the hook catches it at write time) |
| Block `Content-Security-Policy` appearing in `next.config.ts` | CSP stays in `middleware.ts` |
| Warn on a `<form` without `method=` in a `.tsx` | the GET-password leak |
| Warn on `onClick` on a `<tr` | row-level edit is a `<button>` |
| PostToolUse: `eslint --fix` on the changed file only | formatting churn (`1b758bc`-style "fixed formatting" commits) |

Static greps can't prove these; they catch the regression the moment it's typed, which
is the point. A lint rule is the better long-term home for the last three.

**1.3 Add a verification block to `AGENTS.md`.** *(Test · review drain)*
> Before reporting any task complete: run `bun run typecheck && bun run lint && bun run test`
> (and `bun run e2e` for anything under `app/` or `components/`), and paste the tail of
> each output. If a test fails, fix the code, not the test. A UI change is not done
> until it has been driven in a browser.

**1.4 Run the e2e smoke spec in CI.** *(Test · rework)*
Add a job (or a step after Build) that starts the production build against the CI
MariaDB service and runs at least `e2e/specs/smoke.e2e.ts`. Chromium is the expensive
part; the smoke spec alone is enough to catch the "inert app" class. Grow to the full
e2e set once timing is known.

**1.5 Pin Bun in CI** (`bun-version: 1.4.4`, or whatever built `bun.lock`) in both
`ci.yml` and `deploy.yml`.

**1.6 Fix known-defect #1 before field counting.** *(rework)* `docs/known-defects.md`
#1 — *a deactivated product is still countable* — breaks invariant 6 on the write path,
and Phase 2.9 is the first phase where real counts happen. It's already pinned by three
`test.failing` cases; flipping them is the acceptance test.

### Tier 2 — before Phase 3 go-live

**2.1 Independent AI PR review with a `REVIEW.md`.** *(Deploy · review drain)*
Write `REVIEW.md` at the repo root: pass 1 the 11 invariants, pass 2 security incl.
tenant isolation, pass 3 conformance to the active `docs/plans/<slug>/` gates; define
Important vs Nit (cap nits at ~5); exclude `drizzle/meta/`, `bun.lock`, `prototypes/`,
`.claude/agent-memory/`. Run it on every PR in a fresh context — `anthropics/claude-code-action`
in CI (needs an API key secret and costs per run) or the managed Code Review service.
Findings don't approve or block on their own; you still merge. This is the
"separation of duties" you can have as a team of one.

**2.2 Branch protection on `main`.** Require the CI check (and the review check once it
exists) to pass; disallow direct pushes. A required *human* approval isn't possible with
one human, so required checks are the gate.

**2.3 Manual release approval in `deploy.yml`.** *(Deploy · your choice)*
Create a GitHub Environment `production` with you as required reviewer, and add a gate
job that `migrate` depends on:

```yaml
  release:
    needs: verify
    runs-on: ubuntu-latest
    environment: production   # pauses here until you approve
    steps:
      - run: echo "Release ${GITHUB_SHA::7} approved"
  migrate:
    needs: release
```

Move the Hostinger secrets to the `production` environment so no un-approved job can
read them. Caveat: required reviewers on environments need a public repo or a paid
GitHub plan for private repos — check before relying on it.

**2.4 PR template with a Proof section** (`.github/pull_request_template.md`): which
gate/slice, commands run with output tails, browser/e2e evidence, invariants touched.
This makes the review drain a checklist read, not a diff read.

**2.5 Rehearse rollback once** before the first real deploy — deploy, roll back to the
previous `deploy-*` release, confirm. The playbook's bar is *rollback as a single,
rehearsed command*; it's built but has never run.

### Tier 3 — after go-live (Maintain)

- **Uptime + error reporting** on the Hostinger app; a post-deploy check on 5xx rate.
- **Weekly scheduled security review** (a scheduled cloud session running the
  `security-reviewer` checklist on `main`, output as an issue or `docs/qa/` note).
- **Incident → test**, formalised: every production bug gets a `test.failing` pin in
  `known-defects` first, then the fix flips it — the pattern already exists.
- **Agent-config evals, lightweight**: 5–10 real past tasks (e.g. "add a count-line write
  path for X", "add a cost column to a table staff can see") with a `check.sh` each,
  run when `AGENTS.md` or `.claude/**` changes. Worth it only once agent config changes
  often; skip until then.

---

## Metrics worth watching (all derivable from git/GitHub, no new tooling)

| Metric | Today | Direction |
|---|---|---|
| `fix:` vs `feat:` commits (non-merge) | 75 : 63 | `fix` share falling = less rework |
| Always-loaded context | was ~422-line `AGENTS.md` + ~4,450 lines required reading; **now 16 KB `AGENTS.md` + STATE status + active plan** (2026-11-08) | keep `AGENTS.md` under ~16 KB |
| First-pass CI success on PRs | not tracked | up |
| "Built but not proven" items in `STATE.md` | several (Vision, redesigned mobile screens on a phone, queue fix #46) | down before go-live |
| Escaped defects per phone/QA round | 2026-10-25 and 2026-11-06 rounds each produced a fix PR | down |
| PR open → merge time | not tracked | down once review is evidence-based |

---

## Open questions found during the scan (not changed here)

1. **`docs/plans/ui-ux-redesign/00-status.md` says "do not open a PR from this branch
   until the browser pass"**, but `feat/ui-ux-redesign-v2` merged as PR #29. Either the
   pass happened and the status file is stale, or it merged unproven — `STATE.md`
   should say which.
2. **`lib/domain/extraction-pipeline.ts:906` sets `MODEL_ID = "claude-sonnet-5"`.**
   Vision has never run (open-item #47), so the model id has never been exercised.
   Confirm it is the model you intend when the API key arrives.
3. **`docs/known-defects.md` header says "None of these are fixed"**, but #2 (zero/negative
   net) was fixed by `2044644` and its tests flipped. The header is stale.
4. **Agent memory was untracked then re-tracked** (`56c7c89`, `a954d17`). Decide the
   policy once — it is 61 files and grows every phase; tracked memory is shared context
   but also more for every agent to load.
