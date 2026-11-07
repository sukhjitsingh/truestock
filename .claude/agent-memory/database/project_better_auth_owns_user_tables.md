---
name: project-better-auth-owns-user-tables
description: Resolved 2026-07-24 — Better Auth owns user/session/account/verification with integer PKs via generateId:"serial"; the backend agent MUST set that config or inserts break
metadata:
  type: project
---

Resolved the earlier open question (was
`project_better_auth_user_schema_mismatch.md`, now superseded/deleted).
Coordinator decision: Better Auth owns `user`, `session`, `account`,
`verification` tables outright (option (c) from the original three options),
with the twist that solves its main cost — configuring Better Auth to use
integer autoincrement ids instead of its default string ids, so
`count.opened_by`, `count.closed_by`, `count_line.counted_by` stay plain int
FKs with no repointing.

**The actual config key, verified by reading the installed source
(`better-auth@1.6.25`, `@better-auth/core@1.6.25`,
`@better-auth/drizzle-adapter@1.6.25` — check `node_modules/better-auth/package.json`
if versions may have moved on):**

```ts
advanced: { database: { generateId: "serial" } }
```

**Why this matters:** the coordinator's first guess was
`advanced.database.useNumberId` — that option does not exist in this
version. The real mechanism is `generateId: "serial"` (also accepts
`false`, `"uuid"`, or a custom function). `"serial"` specifically tells
Better Auth to let MySQL's `AUTO_INCREMENT` generate the id, and the Drizzle
adapter reads it back via `LAST_INSERT_ID()`
(`node_modules/@better-auth/drizzle-adapter/dist/index.mjs`). This is a
runtime config, not something expressible in the schema — `db/schema.ts`
only defines the tables with `int autoincrement primary key`; nothing in
the database itself enforces that Better Auth was told to use them that way.

**How to apply:** when the backend agent constructs the Better Auth server
instance, this setting is load-bearing, not optional — without it, either
inserts fail against the int id/FK columns, or Better Auth falls back to
generating its own string ids that don't fit the column type. If a future
session finds auth writes failing with a type mismatch on `user.id` /
`session.user_id` / `account.user_id`, check this setting first. Field
shapes for all four tables were taken directly from
`getAuthTables()` in `@better-auth/core`'s source
(`node_modules/@better-auth/core/dist/db/get-tables.mjs`) — if a
`better-auth` upgrade changes that function's output, re-diff it against
`db/schema.ts` rather than assuming the shape is still current.
