---
name: project-phase2-ui-redesign-audit-2026-08-13
description: Security audit of Phase 2 UI redesign diff (43f2927..HEAD, feat/phase-2-ui-redesign) — confirmed presentation-layer-only, no exploitable findings
metadata:
  type: project
---

Audited `git diff 43f2927..HEAD` (43 files, ~3300 insertions) on branch
`feat/phase-2-ui-redesign`, 2026-08-13. The claim that this was a
presentation-layer-only change **held** — verified, not assumed:

- `app/actions/**`, `lib/**`, `middleware.ts`, `next.config.ts`, `package.json`
  all show a **zero-line diff**. No new server action, route handler, or
  dependency was introduced. `@tanstack/react-table` was already installed
  pre-diff (added earlier, matches AGENTS.md's note).
- `components/office/catalog-table.tsx` (rewritten to TanStack Table v8,
  577 lines): cost column is omitted from the `columns` array per role at
  call time (`columnVisibility` never used), and the server-side gate this
  depends on (`lib/domain/catalog.ts`'s `selectProducts`/`canSeeCost`) is
  unchanged and was re-verified directly — non-owner selects genuinely omit
  the `currentUnitCost` column from the SQL, not just from the rendered
  props. `updateProduct`'s return value re-runs through the same
  role-gated `selectProducts`, so even the inline-edit round trip never
  hands a manager a payload containing cost.
- CSP (`middleware.ts`) byte-for-byte unchanged; the diff's only
  `style={{...}}` usages are React inline `style` attributes covered by
  the existing `style-src 'self' 'unsafe-inline'` (documented and
  intentional for Radix primitives) — not a violation.
- `prototypes/generate-tokens.mjs` (new) has hardcoded source/output paths
  derived from `__dirname`, takes no argv/env input, and has no npm script
  or CI wiring — confirmed dev-only, manually run.
- `scripts/verify-browser.mjs` (new checks added) reads `CHECK_EMAIL` /
  `CHECK_PASSWORD` from env only, never logs them; only Better Auth's own
  JSON error body is echoed on an auth failure (no credential in it).
  Not wired into `ci.yml`.
- Every mutating `<form>` in the diff carries `method="post"`; the one
  `method="get"` form (catalog search box) is intentionally GET — a
  read-only, idempotent search query has no password-in-URL risk, so this
  is correct HTTP semantics, not the invariant violation the checklist
  was hunting for.
- `bun audit` findings (playwright<1.55.1, postcss/sharp/nanoid/brace-expansion/js-yaml/esbuild
  transitive advisories) are **all pre-existing**, carried over unchanged
  from before this branch (package.json/lockfile untouched) — see
  [[project-baseline-audit-2026-07]]. Not a Phase 2 regression.

**Net finding: no exploitable issue in this diff.** This is a clean review
outcome, not a shallow one — every invariant-7/8/9 claim in the diff's own
code comments was independently re-derived against the actual unchanged
server code rather than trusted at face value.
