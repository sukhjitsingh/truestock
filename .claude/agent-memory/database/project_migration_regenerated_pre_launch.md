---
name: project-migration-regenerated-pre-launch
description: RESOLVED 2026-08-12 — a real seeded dev DB now exists and migrations stack normally (0000-0003 applied); regenerating 0000 in place is no longer valid
metadata:
  type: project
---

**RESOLVED (2026-08-12).** The pre-launch practice this memory used to
describe (deleting and regenerating `drizzle/0000_*.sql` in place instead of
stacking `0001`/`0002`) ended once a real dev database existed. Confirmed
2026-08-12 while building Slice 2 of `docs/plans/phase-1-to-1.5/`: the local
Docker MariaDB (`docker-compose.yml`) has migrations 0000-0002 already
applied, a seeded catalog (97 products) and 6 real locations, and a normal
stacked `0003_lovely_gertrude_yorkes.sql` (adds `location.active` +
`location_organization_active_idx`) applied cleanly on top via `drizzle-kit
migrate` with no regeneration.

**Why this matters going forward:** every schema change from here on is a
new migration file, full stop — never a hand-edit of an applied migration,
never a regenerated 0000. This is the normal, permanent state described in
`AGENTS.md`'s "Migrations go through drizzle-kit" rule; there is no more
pre-launch exception to reach for. A future session does not need to ask
whether a real DB exists — it does, and has for a while.

Keeping this file (rather than deleting it) as the record of when the
pre-launch practice was in effect and when it ended, since a future session
reading old commit history around 0000's regenerations would otherwise have
no context for why that was ever acceptable.
