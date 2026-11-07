---
name: mariadb-composite-index-survives-column-drop
description: MariaDB narrows a composite index instead of dropping it when ALTER TABLE DROP COLUMN removes only one of its columns — reversal SQL must DROP INDEX explicitly first
metadata:
  type: project
---

Discovered 2026-08-15 verifying migration `0006_colorful_pretty_boy.sql`'s
reversal SQL (`vendor_alias` / `invoice_line.matched_vendor_alias_id`,
Phase 2.5 Slice 3) against real MariaDB 11.8.8.

**The gotcha:** `ALTER TABLE t DROP COLUMN c` where `c` is one column of a
multi-column index does NOT drop that index. MariaDB silently narrows it to
whichever columns remain instead — e.g. dropping `matched_vendor_alias_id`
left `invoice_line_organization_matched_vendor_alias_idx`, originally
`(organization_id, matched_vendor_alias_id)`, behind as a single-column
`(organization_id)` index. No error, no warning. The first draft of this
migration's reversal SQL (`DROP FOREIGN KEY` + `DROP COLUMN`, mirroring
`0005`'s reversal in `db/README.md`) looked complete and produced a schema
that looked fine on casual inspection — it was only caught by diffing
`SHOW CREATE TABLE` output against the pre-migration baseline byte-for-byte,
which is exactly the verification `db/README.md`'s "Migrations" section
already asks for on every entry and is why that diff matters instead of
being a formality.

**How to apply:** any migration reversal that drops a column participating
in a composite index (not just its own single-column index) must
`DROP INDEX <name>` explicitly, before or in the same statement batch as
the `DROP COLUMN`. Check this every time a reversal is written by hand for
`db/README.md` — don't assume `DROP COLUMN` alone is sufficient just
because it was for a single-column index in an earlier migration (`0005`'s
reversal happened not to hit this because none of its dropped columns were
part of a multi-column index).
