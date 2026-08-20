---
name: project-phase2.5-slice4-verified-uncommitted
description: Slice 4 (Cost Flow + Alerts) fully implemented and browser-verified 2026-08-19/20 on feat/phase-2.5-slice-4 but NOTHING committed yet — devops/deploy has no action until this lands
metadata:
  type: project
---

Branch `feat/phase-2.5-slice-4` (stacked on `feat/phase-2.5-slice-3`'s tip,
worktree `.claude/worktrees/phase-2.5-slice-3`). Database, backend, code-
reviewer and security-reviewer subagents had all already done their passes
(their own memory files: `database/project_phase25_slice4_product_cost_history.md`,
`backend/cas_replay_before_writeloop_idempotency.md`,
`code-reviewer/project_phase2.5_slice4_cost_flow_review_2026-08-19.md`,
`security-reviewer/project_phase2.5_slice4_cost_flow_audit_2026-08-19.md` —
all clean, no findings) before this verification pass ran. **As of this
writing every change is still uncommitted** (`git status` shows modified +
untracked files only, no new commit on top of `ada079a`) — do not assume a
deploy pipeline has anything new to ship until a commit lands.

**Browser verification (this pass, 2026-08-19/20):** `tsc --noEmit`, `eslint`,
and the full `bun test` suite (391 pass / 0 fail, including the new
`tests/invoice-approval-path.test.ts` + `tests/invoice-line-alerts.test.ts`)
all clean inside the isolated worktree Docker stack. Then
`scripts/verify-browser-slice4.mjs` (real Playwright/Chrome, signed in as
`verify-owner@truestock.local`) against `http://localhost:3010` — 13/13
checks passed: "Approve & post costs" present only on a `reviewed` invoice
and absent on `needs_review`; the `discount > 50%` badge renders live from
in-progress form state before any submit AND from a persisted reviewed line;
clicking Approve transitions the invoice to `approved` (banner + terminal —
no action buttons remain); `product.current_unit_cost` and one
`product_cost_history` row both land correctly (verified via direct
`mysql2` ground-truth queries, not the page's own claim); the catalog edit
screen shows the new cost. Left in the dev DB as inspectable evidence:
product id 99 (`current_unit_cost = 8.0000`), invoice id 3 (`status =
approved`), its one line, and its one `product_cost_history` row. The
scratch `needs_review` invoice/line used only for the live-badge check was
deleted by the script's own cleanup pass.

**How to apply:** before doing any deploy-pipeline work on this feature, check
`git log` — if `ada079a` is still the tip of this branch, Slice 4 exists only
as a working tree, not a committable/deployable artifact yet. See
[[turbopack-cold-compile-exceeds-playwright-networkidle-timeout]] for a
verification-run gotcha hit while producing this evidence.
