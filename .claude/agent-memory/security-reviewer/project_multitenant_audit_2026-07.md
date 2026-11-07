---
name: project-multitenant-audit-2026-07
description: Tenant-boundary audit after single->multi-tenant conversion — one real cross-tenant IDOR found (locationId), everything else (product/count/vendor/barcode scoping, composite FKs, idempotency ledger, auth additionalFields) verified correct
metadata:
  type: project
---

Ran 2026-07-27 against the multi-tenant conversion (organization table added,
user.organization_id NOT NULL, lib/authz.ts Actor.organizationId re-read from
DB every call). This supersedes nothing in [[project-backend-auth-audit-2026-07]]
(role/cost gating) — that verdict still holds — this audit adds the tenant
dimension specifically.

**One real, exploitable finding: `locationId` is never validated against the
caller's organization on the count-line write path.**
`lib/domain/counts.ts`'s `upsertCountLineRow` (~line 285-407) validates
`productId` against `actor.organizationId` before first-insert (line
326-338), but never does the equivalent check for `locationId` — it's used
directly in the WHERE/INSERT with no `eq(location.organizationId, ...)`
anywhere. The schema doesn't backstop this either:
`drizzle/0000_elite_nightmare.sql:197`'s `count_line_location_id_location_id_fk`
is a plain single-column FK to `location.id` (existence only), unlike the
composite `(organization_id, count_id)` FK that correctly makes cross-tenant
`count` linkage impossible. Exploit: an authenticated user of org A (any
role, since staff can call `incrementCountLineAction`/`scanCountLineAction`)
passes their own valid `countId` but a `locationId` belonging to org B (ids
are global autoincrement, so guessable/enumerable). The write succeeds,
creating a `count_line` row correctly stamped `organization_id = A` but
pointing at an org-B `location` row. Two consequences: (1) info disclosure —
`getCount` (counts.ts ~line 1029) and `countSummary`
(lib/domain/reports.ts ~line 124) both `innerJoin(location, ...)` with no
org predicate on the join, so org B's location `name` leaks into org A's
count detail/summary responses; (2) an existence oracle — a `locationId`
belonging to ANY tenant returns success, one belonging to no tenant at all
throws an FK violation (generic error), letting org A distinguish "exists
somewhere" from "exists nowhere" across the whole system. Does NOT let org A
write to or corrupt org B's actual count data (count_line.organization_id is
always hardcoded from the actor, and the composite FK holds that boundary) —
scoped this as high, not critical. Fix: add `and(eq(location.id,
params.locationId), eq(location.organizationId, params.organizationId))`
to the lookup in `upsertCountLineRow` (mirroring the existing product check),
and add org predicates to the two location joins above. Same pattern should
be grepped for elsewhere before considering this closed — `locationId` is the
only client-supplied FK-only id in the schema without a composite tenant FK;
`productId`, `vendorId`, `countId`, `countLineId` all either have one or are
explicitly re-validated in application code.

**Everything else checked out real, not just commented as correct:**
- `lib/domain/catalog.ts`'s `selectProducts` centralizes the org filter for
  every product read (including barcode resolution); `createProduct`/
  `updateProduct`/`deactivateProduct` all scope writes by
  `actor.organizationId` and turn a cross-tenant write into `NotFoundError`
  via `affectedRows === 0`, not a silent write to someone else's row.
- The composite FKs actually work as documented: confirmed in the generated
  SQL (`count_line_organization_count_fk`,
  `count_line_write_organization_line_fk`) — cross-tenant `count`/`count_line`
  linkage is structurally impossible, verified against SQL not just the
  Drizzle schema comments.
- `count_line_write_client_line_id_unique` being GLOBAL (not per-tenant) is
  correctly reasoned: it's a client-generated UUIDv4, collision risk is
  negligible, and `findReplayedLine` (counts.ts ~line 237) filters by
  `organizationId` on the read side regardless, so even a hypothetical
  collision couldn't hand back another tenant's line.
- Error shape is a clean oracle-resistant NotFound everywhere EXCEPT the
  location bug above — `lib/action-result.ts` collapses all non-domain
  errors to a generic message server-side, and every cross-tenant lookup in
  catalog/counts/reports throws the same `NotFoundError` a truly-missing id
  would.
- `lib/auth.ts`: confirmed by reading
  `node_modules/better-auth/dist/db/schema.mjs`'s `parseInputData` (not just
  assumed from the config comment) that `additionalFields` with `input:
  false` throws `FIELD_NOT_ALLOWED` if a caller tries to set
  `organizationId`/`role`/`active` through ANY Better Auth endpoint
  (update-user included, not just sign-up). Sign-up is genuinely dead
  (`disableSignUp: true`, no carve-out in the catch-all route). The inactive-
  organization check in `requireSession`/`getCurrentUser` is real (both
  inner-join `organization` and check `.active`), so a suspended tenant is
  fully locked out, not just gated on writes.
- `db/seed.ts` and `scripts/create-user.ts` both resolve the organization
  explicitly by slug and fail loudly if it doesn't exist — neither can
  produce a user with a dangling/wrong `organization_id`.
- Dependency audit unchanged from [[project-backend-auth-audit-2026-07]]'s
  baseline (postcss vendored in next, dormant sharp CVE, dev-only
  esbuild/brace-expansion) — nothing new.
