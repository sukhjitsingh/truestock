---
name: project-db-enums-split-from-schema
description: db/enums.ts holds the schema's string enums Drizzle-free; lib/validation/*.ts must import from there, not db/schema.ts, or Drizzle ships to the browser
metadata:
  type: project
---

`db/enums.ts` (added on `feat/phase-2-ui-redesign`, 2026-08-13) holds every
schema string enum (`userRoleEnum`, `productUnitTypeEnum`, `countStatusEnum`,
etc.) as plain `as const` tuples, with zero imports. `db/schema.ts` re-exports
all of them so server code can keep importing from either module.

**Why this split is load-bearing, not tidiness — check it on every future
diff that touches `lib/validation/*.ts` or adds a new enum.** `lib/validation/`
is shared with client components by design (e.g.
`components/office/catalog-table.tsx` imports `unitCostSchema`). A **value**
import reaches through to wherever the export is actually defined — so when
the enums lived in `db/schema.ts`, any client component that imported a
validation schema pulled `drizzle-orm/mysql-core` and the full table
definitions into the browser bundle. The failure was silent and expensive to
diagnose: the catalog page server-rendered fine and looked normal, but every
click did nothing for tens of seconds in dev because Turbopack had to compile
Drizzle for the browser on demand. Same failure class as the CSP/hydration
incident already in AGENTS.md — a 200 / a normal-looking paint proves nothing
about whether the page actually works.

**How to apply in review:** grep any new or touched file under
`lib/validation/` for `from "@/db/schema"` — that import path pulling in an
enum (rather than `from "@/db/enums"`) is the regression to flag. Also watch
`db/enums.ts` itself for a stray import ever being added to it — the file's
own header comment says to keep it import-free, and that's the whole
invariant.

Verified during a full read of `lib/domain/catalog.ts` and
`lib/validation/{catalog,counts}.ts` on 2026-08-13 (branch
`feat/phase-2-ui-redesign` vs `main`): the split is applied consistently,
`db/schema.ts`'s own diff is a pure re-export refactor with no DDL change (no
migration needed), and `tsc --noEmit` / `eslint` / the new unit tests all pass
clean.
