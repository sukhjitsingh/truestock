---
name: project-backend-auth-audit-2026-07
description: Deep-dive verification of Handlebar's auth/authz/domain layer against CLAUDE.md invariants 7-8 — result and the two real gaps found
metadata:
  type: project
---

Ran 2026-07-25, once lib/auth.ts, lib/authz.ts, lib/domain/*, app/actions/*,
lib/validation/*, and scripts/create-user.ts existed. This supersedes the
"held over for backend agent" checklist item in [[project-baseline-audit-2026-07]]
— the checklist has now actually been verified against code, not just stated
as a requirement.

**Verdict: authorization and cost-gating are implemented correctly.** Every
server action in app/actions/{catalog,counts,reports}.ts calls
`requireRole`/`requireSession` as its first statement; `lib/authz.ts` re-reads
role AND active fresh from the DB on every call (never trusts
`session.user.role`); cost/margin columns are excluded at the SQL select-list
level for non-owner roles in lib/domain/catalog.ts and lib/domain/counts.ts
(`selectProducts`, `toCountLineRow`), not filtered post-hoc — confirmed by
reading the actual query code, not just the comments claiming this.
lib/action-result.ts's `runAction` correctly collapses any non-domain error to
a generic message and only `console.error`s the real error server-side —
confirmed the mysql2 ER_DUP_ENTRY race-handling branch in
lib/domain/counts.ts's `applyIncrement` re-throws the raw driver error object
on any non-dup-key failure, but that object still only ever reaches
`runAction`'s catch-all branch (never returned to the client). No raw SQL
found outside one safe parameterized `sql\`ifnull(...)\`` template in
db/schema.ts. scripts/create-user.ts is not imported or reachable from any
file under app/ — confirmed via grep — it's CLI-only, invoked through
`package.json`'s `create-user` script.

**Two real (but low-severity, both already partially mitigated) gaps found:**
1. Deactivating a user mid-shift doesn't revoke their *existing* Better Auth
   session row — only blocks new sign-ins (lib/auth.ts's
   `databaseHooks.session.create.before`) and blocks every actual data action
   on the next request (lib/authz.ts's `requireSession` re-checks `active`).
   The residual exposure is narrow: a still-valid session cookie could still
   hit non-data Better Auth endpoints (get-session, sign-out) until natural
   expiry, but not touch any app data. Note for whoever builds the
   (currently nonexistent) deactivate-user / role-change admin action: call
   session revocation (delete that user's `session` rows, or
   `auth.api.revokeUserSessions`) at the same time as flipping `active`.
2. `lib/auth.ts` never sets an explicit `session.expiresIn`/cookie-cache
   config — relying on Better Auth's defaults. Not a vulnerability by itself,
   but worth an explicit decision for a shared bar-floor Android device
   (how long should a scanning session stay valid unattended).

**Dependency audit (`bun audit`, 2026-07-25) — same shape as the 2026-07-24
baseline, re-confirmed:** high-severity postcss (vendored inside `next`,
build-time only) and high-severity `sharp<0.35.0` (dormant —
`images.unoptimized: true` means its code path never runs) are unchanged.
`brace-expansion`/`esbuild` are dev-only transitive deps. Nothing new.

**Confirmed clean:** no CSV-import HTTP endpoint exists (only db/seed.ts, a
build-time script reading local files — not attacker-reachable); no
hardcoded/defaulted `BETTER_AUTH_SECRET` or other credential anywhere in
lib/, app/, scripts/; `.gitignore` still correctly excludes `.env*` except
`.env.example`; `git status` had nothing sensitive staged.
