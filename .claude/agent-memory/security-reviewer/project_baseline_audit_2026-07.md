---
name: project-baseline-audit-2026-07
description: Kickoff security audit of Handlebar (pre-auth scaffold) — findings, dependency status, and the authorization checklist backend must satisfy
metadata:
  type: project
---

Baseline audit run 2026-07-24, when the repo was only a Next.js scaffold + Drizzle DB
layer (no auth, no server actions, no routes yet). Full findings live in that
conversation; the durable facts worth keeping:

**Secrets/gitignore posture was clean at baseline.** `.env.example` has only a
placeholder `DATABASE_URL`/blank `BETTER_AUTH_SECRET`; `.gitignore` correctly excludes
`.env*` except `.env.example`; no `.env.local` on disk; `git status` had nothing
sensitive staged. Re-check this each time — the risk resets to zero every audit only
if this discipline holds.

**Dependency findings at baseline (via `bun audit`, 2026-07-24):**
- `next@16.2.11` was npm's current `latest` tag at audit time — up to date, but I could
  not independently confirm against the Next.js security-advisories page that this
  build specifically contains the July-2026 middleware/SSRF/image-optimization fixes
  spec.md §11 references. Re-verify against `https://github.com/vercel/next.js/security/advisories`
  each audit rather than trusting "it's the latest tag" as proof.
- Real, current: `next/node_modules/postcss@8.4.31` is a vendored-inside-Next.js
  vulnerable postcss (GHSA-6g55-p6wh-862q / GHSA-r28c-9q8g-f849, arbitrary file
  read via sourceMappingURL) — top-level `postcss` is fine at 8.5.23, this is Next's
  own bundled copy. Not directly fixable (no override point found yet); build-time
  only, no known runtime request path in this app. Low severity but re-check each
  Next.js bump — Next may fix its internal bundling before we'd otherwise notice.
- `sharp@0.34.5` (optional dep of `next`, for image optimization) has a high-severity
  advisory (GHSA-f88m-g3jw-g9cj) fixed at 0.35.0. Currently dormant because
  `next.config.ts` sets `images: { unoptimized: true }` — sharp's optimizer path
  never runs. **If anyone ever flips `unoptimized` back to false, re-run this check
  first** — that's the moment this stops being theoretical.
- `brace-expansion` (ReDoS, via eslint's minimatch chain) and `esbuild<=0.24.2`
  (dev-server arbitrary request, via drizzle-kit/tsx) are dev-only transitive deps —
  not shipped to production, low priority.

**Authorization checklist held over for the backend agent** (per CLAUDE.md invariants
7–8 and spec §4/§11): every server action and route handler must, independent of
middleware — (1) verify a valid session exists, (2) load the user's role fresh from
the DB (not trust a client-supplied role claim), (3) explicitly allow/deny per role
for that specific action (staff = count-only, no cost/margin reads or writes anywhere,
including hidden/omitted-in-UI payload fields; manager = counts/receiving/reorder,
still no cost/margin; owner = everything), (4) reject any write to a `count` whose
`status = 'closed'` at the DB level, not just hide the button. Re-verify this list is
still being followed once server actions actually exist — this was written before any
existed.

**Schema note relevant to future audits:** `db/schema.ts` currently has no row-level
or column-level access control of its own (expected — Drizzle doesn't do this).
`current_unit_cost` lives directly on `product` with no separate cost table, so
role-gating cost data is 100% an application-layer responsibility (server actions
must select/omit the column per role) — there is no schema structure forcing it.
Worth flagging again once query code exists: check that any `select()` reachable by
a `staff`-role handler never includes `currentUnitCost`, `unitCostAtCount`, or
`totalValue`, even in an object that's merely filtered in the UI.
