---
name: project-phase25-slice3-vendor-alias
description: Phase 2.5 Slice 3 schema landed — vendor_alias table + invoice_line.matched_vendor_alias_id, migration 0006, tenant-FK and delete-behavior choices
metadata:
  type: project
---

**Landed 2026-08-15** (branch `feat/phase-2.5-slice-3`, migration
`drizzle/0006_colorful_pretty_boy.sql`): `vendor_alias` table +
`invoice_line.matched_vendor_alias_id` column, schema/migration only — no
`lib/domain/matching.ts` yet, that's a separate agent's job on top.

**Table name is `vendor_alias`**, per `04-slices.md` and `00-status.md`'s
AR-2 second-pass finding — NOT `vendor_item_alias`, which is what
`db/enums.ts`'s comment above `invoiceMatchMethodEnum` still says (stale,
left untouched since it wasn't in this change's scope; worth fixing next
time that file is touched).

**Tenant-FK asymmetry within the same table, deliberate:** `vendor_id` gets
a composite tenant FK `(organization_id, vendor_id)` -> `vendor`'s own
`(organization_id, id)` — the specific gap AR-2's second pass named ("the
one table whose bad rows persist and re-apply to every future invoice from
that vendor"). `product_id` stays a bare single-column FK, matching
`invoice_line.matched_product_id`'s existing precedent: both are
human-picked ids checked at the app layer (the review screen's "map to
product" action), not standing rules the way `vendor_id` is. Don't
"complete" this by making `product_id` composite too — the asymmetry is the
point, not an oversight.

`invoice_line.matched_vendor_alias_id` is also a bare FK (not composite) —
it's set by `matchLinesToProducts`, an internal domain function with an
already-tenant-scoped `vendorId` in hand, never a raw client payload.
`ON DELETE SET NULL` (not RESTRICT like `reviewed_by`'s FK to `user`):
`vendor_alias` has no soft-delete flag, so a bad mapping may need outright
deletion, and SET NULL means that correction doesn't block on every
`invoice_line` that ever matched through it.

`match_confidence DECIMAL(4,3)` defaults to `0.500` on row creation
(advisory convention documented in `db/schema.ts`'s comment, not enforced —
whoever builds `matching.ts` should move it toward `1.000` per confirmation,
never coerce it to a flat "confirmed vs not").

See [[mariadb-composite-index-survives-column-drop]] for the migration-
reversal gotcha this slice's verification caught.
