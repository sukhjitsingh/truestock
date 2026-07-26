---
name: project-better-auth-user-schema-mismatch
description: Unresolved conflict between spec.md §8's User table shape and how Better Auth actually stores credentials/ids — needs a decision before the backend agent wires up auth
metadata:
  type: project
---

docs/spec.md §8 spec's `User` as `id, email, password_hash, role, active` with a
plain autoincrement int `id` (per spec's stated convention: "everything else
uses integer primary keys"). Built faithfully as `db/schema.ts`'s `user` table
on 2026-07-24, per the database agent's "implement faithfully, flag rather than
deviate" mandate.

This does not match how Better Auth (the chosen auth library, CLAUDE.md) really
works:
- Better Auth's credential provider stores the password hash in its own
  `account` table (keyed by provider), not as a `password_hash` column on
  `user`.
- Better Auth's Drizzle adapter/schema generator defaults to string ids
  (nanoid-style) for `user`/`session`/`account`, not autoincrement ints, unless
  explicitly configured otherwise (`advanced.database.useNumberId` or similar
  in newer versions).
- Better Auth also typically wants a few extra columns on `user`
  (`emailVerified`, `image`, timestamps) if you point its schema generator at
  this table directly.

**Why:** the database agent's brief was explicit — implement spec.md as
written, and flag disagreements rather than silently changing the data model.
This is exactly that kind of disagreement.

**How to apply:** before the backend agent wires up Better Auth, this needs a
real decision: (a) keep `user` as spec'd and hand-roll the password_hash
check instead of using Better Auth's credential provider, (b) let Better
Auth own its own `user`/`session`/`account`/`verification` tables (via its
CLI schema generator) and treat spec's `User` table as a separate
"business profile" table joined by id/email, or (c) reshape `user` to match
what Better Auth expects (string id, drop password_hash, add its columns) —
which is a schema change to `db/schema.ts` requiring a new migration. Do not
assume (c) and just migrate; check with the user first, since this changes
the agreed data model in spec.md §8.
