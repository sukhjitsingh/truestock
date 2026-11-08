# Truestock — PR review

What the automated reviewer (`.github/workflows/claude-review.yml`) checks on every
pull request, and how it reports. Humans reviewing by hand can use the same list.

**The reviewer never approves and never blocks.** Its findings are input for the
owner, who merges. It runs in a fresh context, separate from the session that
wrote the code: that separation is the point (`docs/sdlc-playbook-map.md`, Tier 2.1).
The copy of this file the reviewer follows is read from the PR's **base** branch, so
a PR cannot rewrite the rules it is reviewed against.

## Before you start

Read `AGENTS.md` (the rules, stated short) and, for any rule a change touches, its
section in `docs/lessons.md` (why the rule exists). If the PR belongs to a plan,
read `docs/plans/<slug>/00-status.md` and the gate docs it points to.

## Pass 1 — the invariants (always first)

Check the diff against every numbered invariant under "Non-negotiable invariants" in
`AGENTS.md` (eleven as of 2026-11-08 — count them, don't trust this number). These
produce numbers that look plausible and are wrong, which is this app's worst failure
mode. In particular:

- **Write paths:** does a new or changed write refuse `active = false` rows **above**
  any existing-row lookup (invariant 6)? Is a count-line write idempotent through
  the `count_line_write` ledger with a fresh `client_line_id` per attempt (5)?
- **Snapshots:** is a count line's cost and case size snapshotted at write time,
  never joined live (2)? Are cases and eaches kept separate (4)?
- **Closed counts** are never updated (1).

## Pass 2 — security

- **Tenant isolation (invariant 9).** Every read filters on `Actor.organizationId`
  from `requireSession`; every write stamps it; every client-supplied id is
  **ownership**-checked, not just existence-checked; a cross-tenant id returns
  `NotFound` — not a distinguishable error, not a leaked name. Includes invoice files
  and audit-packet downloads.
- **Authorization inside every server action and route handler** (7), not only in
  middleware. **Cost and margin data never reaches `staff`** (8) — check payloads and
  RSC props, not just what the UI renders.
- Raw SQL, unvalidated input at a boundary (Zod), secrets in client bundles or error
  responses, user input reaching a file path or URL.

## Pass 3 — conformance and evidence

- **The plan.** If the PR is a slice of a `docs/plans/<slug>/` feature, does it do
  what that slice says — no more, no less? Flag a decision made silently that the
  gate docs say otherwise about.
- **Working agreements** in `AGENTS.md` — e.g. the CSP stays in `middleware.ts`;
  barcodes go through `normalizeBarcode`; sizes through `formatProductSize`; forms
  whose submit is handled in JS carry `method="post"`; row edit is a `<button>`.
- **Evidence.** A behaviour change needs a test that would fail without it. A UI
  change needs browser proof (e2e, or a stated manual check). A fixed known defect
  must have lost its `test.failing`. Flag a test that was skipped, weakened, or had
  its assertion loosened to get to green.
- **Docs that now lie.** `STATE.md` says what is *proven* vs *built*; if this PR
  changes that, the file should too.

## Severity

- **Important** — would ship a wrong number, a data leak, a broken page, a lost
  write, or an invariant violation; or a missing test for a behaviour change. Post
  each as an inline comment on the exact line, with the failure scenario (inputs →
  wrong result) and a suggested fix.
- **Nit** — style, naming, a clearer comment. **At most five per review**, collected
  in the summary, never inline. If there are more, pick the five that matter most.

Say "no Important findings" when that is true. Do not manufacture findings, and do
not restate what the PR description already says.

## Skip

Generated or bookkeeping files: `drizzle/meta/**`, `bun.lock`, `prototypes/**`,
`.claude/agent-memory/**`, `docs/history/state-log.md`, `public/zxing/**`,
`playwright-report/**`, `test-results/**`. Do review new `drizzle/*.sql` migrations —
and flag any edit to one that already exists on `main` (migrations are append-only).

## Output

1. Inline comments for Important findings only.
2. One summary comment: a one-line verdict, the Important findings as a list (file:
   line — one sentence each), then up to five nits. Nothing else.
