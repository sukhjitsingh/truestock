---
name: project-shelf-life-schema-delta
description: Product.shelf_life_days and CountLine.opened_at exist in db/schema.ts but are not yet documented in docs/spec.md — a spec-doc gap, not a code gap
metadata:
  type: project
---

On 2026-07-24, during initial schema build-out, the parent task instructed
adding `shelf_life_days INT NULL` on `Product` and `opened_at` (nullable
DATE) on `CountLine`, explicitly "decided this session." These are real
columns in `db/schema.ts` and the initial migration
(`drizzle/0000_slim_johnny_storm.sql`), but as of this writing they exist
**only** in code comments — `docs/spec.md` §8's data model listing and
CLAUDE.md's "schema delta" section (which does document `waste_factor`)
don't mention them.

**Why:** the columns were added deliberately narrow-scope — no UI, no
discard-date computation, no read path anywhere in the MVP. They exist so a
future shelf-life feature is a UI change, not a migration + recount. That's
sound, but it means the written record of *why these columns exist* currently
lives only in schema comments, not in the docs that are supposed to be the
source of truth.

**How to apply:** if asked to update docs/spec.md or CLAUDE.md, add
`shelf_life_days` / `opened_at` to their schema deltas section (same
treatment as `waste_factor`) so the doc and the code don't drift apart. If a
future session finds spec.md §8 doesn't mention these columns and wonders
whether they're stray/accidental, they aren't — check `db/schema.ts`'s
comments on `Product.shelfLifeDays` and `CountLine.openedAt` first.
