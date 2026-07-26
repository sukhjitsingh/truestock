---
name: project-migration-regenerated-pre-launch
description: The 0000_* initial migration has been deleted and regenerated fresh more than once (most recently 2026-07-24) rather than stacked as 0001/0002 — only valid because nothing has ever been applied to a real database yet
metadata:
  type: project
---

No MySQL server exists in this dev environment, and as of 2026-07-24 nothing
has ever been applied to a real Handlebar database anywhere. On code-review
feedback about the schema (nullable snapshot columns, new unique index on
`product(name, size_ml)`, etc.), the coordinator explicitly authorized
deleting `drizzle/0000_*.sql` + `drizzle/meta/` and regenerating a single
clean initial migration instead of adding `0001_*` on top. Current file:
`drizzle/0000_gigantic_microbe.sql` (filename changes each regen — drizzle-kit
picks a random adjective-noun tag; check `drizzle/meta/_journal.json` for the
current one rather than trusting a remembered filename).

**Why:** with zero real deployments, there's no rollback history to protect —
regenerating a clean 0000 keeps the migration history readable instead of
carrying "fix the fix" migrations from a schema that was still being reviewed.

**How to apply:** this is a **pre-launch-only** practice. The moment a
migration is actually applied to any real database (even a local dev one
someone starts using), stop regenerating 0000 in place — from that point on,
every schema change is a new migration file, full stop, per the standing
"migrations go through drizzle-kit, never hand-edited once applied" rule in
CLAUDE.md and the database agent's own brief. If a future session is asked to
change the schema, check whether a real DB now exists (ask, don't assume)
before deciding whether to regenerate or add a new migration.
