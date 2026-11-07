---
name: project-phase25-slice4-product-cost-history
description: Phase 2.5 Slice 4 schema landed — product_cost_history table, migration 0007, three composite tenant FKs, and the invoice_line composite unique index it required
metadata:
  type: project
---

**Landed 2026-08-16/17** (branch `feat/phase-2.5-slice-4`, migration
`drizzle/0007_yielding_gideon.sql`): `product_cost_history` table, schema/
migration only — no `app/actions/invoices.ts:approveInvoiceAction` or
`lib/domain/cost-derivation.ts` yet, those are a separate (backend) agent's
job on top of this.

**Exact column set is the spec's own INSERT list, nothing added:**
`organization_id`, `product_id`, `source_invoice_id`,
`source_invoice_line_id`, `unit_cost`, `previous_unit_cost`, `effective_at`,
`created_by`. No separate `created_at` — `effective_at` (defaultNow()) plays
that role, since every row is written exactly once, at the instant the
approving transaction runs. Append-only like `count_line_write`: no
`updated_at`, no soft-delete flag.

**Three composite tenant FKs, all bare id columns underneath** (no
single-column FK on `product_id` / `source_invoice_id` /
`source_invoice_line_id` — composite only), covering `product`, `invoice`,
and `invoice_line`. `invoice_line` had NO `(organization_id, id)` composite
unique index before this slice — nothing had needed to reference an
`invoice_line` row by id from another table until now. Added
`invoice_line_organization_id_id_unique`, matching the naming convention
every other `*_organization_id_id_unique` in the file already uses (vendor,
location, product, count, count_line, invoice, extraction_job).

**`UNIQUE(source_invoice_line_id)` is deliberately a PLAIN unique, not
scoped to `organization_id`** — same reasoning as `count_line_write`'s
global `client_line_id`: a `source_invoice_line_id` already identifies one
row in an already-tenant-scoped table, so a per-tenant scope adds nothing.
Per the slice spec [AR-4], this is the idempotency BACKSTOP, not the
primary mechanism — the primary mechanism is the CAS on `invoice.status`
(`reviewed` -> `approved`) in `approveInvoiceAction`, which is supposed to
return success without re-entering the cost-writing loop at all on a
replay. This constraint only ever fires if that CAS logic has a bug — do
not read its presence as license to skip the CAS-first design when building
`approveInvoiceAction`.

**`created_by` is NOT NULL**, deliberately diverging from
`invoice.approvedBy`'s nullable shape even though the task description said
to "follow the exact pattern invoice.approvedBy already uses." Read that as
"same FK shape" (`int` -> `references(user.id, { onDelete: "restrict" })`),
not "same nullability" — `approvedBy` is nullable because it lives on a row
that predates the approval action; `created_by` lives on a row that is
*only ever created during* an approval, so the actor is always known at
insert time, matching `count_line_write.writtenBy`'s NOT NULL shape instead.

**Verification done at this stage:** typecheck clean; migration 0007
applied clean from empty in a throwaway scratch DB (`bun run db:migrate`
against a fresh database, full 0000-0007 chain); cross-tenant `product_id`
insert rejected (1452, `product_cost_history_organization_product_fk`);
replayed `source_invoice_line_id` insert rejected (1062); `vendor` table
confirmed byte-identical (untouched) before/after; reversal SQL
(`DROP TABLE product_cost_history` then
`ALTER TABLE invoice_line DROP INDEX invoice_line_organization_id_id_unique`
— that order, or MariaDB 1553s trying to drop an index a live FK still
needs) verified end-to-end, `invoice_line` byte-identical to its pre-0007
state afterward. None of this proves the backend transaction logic
(CAS-first, `FOR UPDATE` read of `previous_unit_cost`, `withLockRetry`) —
that's the next agent's adversarial tests to write and pass.

See [[project-phase25-slice3-vendor-alias]] for the sibling Slice 3 schema
entry and [[mariadb-composite-index-survives-column-drop]] for the general
reversal gotcha (not triggered this time — no column was dropped, only an
index — but checked for on principle).
