---
name: project-open-item-2-fill-correction-ledger-schema
description: migration 0008 (open-items.md #2, schema half) — count_line_write gains write_type + partial_fills_before/after so editCountLineFills can be given a ledger entry; backend half (the actual insert) is NOT done
metadata:
  type: project
---

Closed open item #2 ("editCountLineFills writes no ledger entry") on the
schema side only, branch `feat/phase-2.5-open-items-2-32-33`, migration
`drizzle/0008_lyrical_romulus.sql`. Three new columns on `count_line_write`:

- `write_type` — new `countLineWriteTypeEnum` in `db/enums.ts`,
  `["scan", "fill_correction"] as const`. NOT NULL DEFAULT `'scan'` (every
  pre-existing row genuinely was a scan/increment/quantity-correction write,
  since `editCountLineFills` never wrote a ledger row before this).
- `partial_fills_before` / `partial_fills_after` — nullable JSON
  (`longtext` on MariaDB), `.$type<number[]>()`. NULL on `scan` rows.

**Why this shape and not reusing `partial_fills_delta`:** that column is
modelled for additive appends — summing every row's delta reconstructs a
line's current `partial_fills` from scratch (see [[project_count_line_write_idempotency_ledger]]
and the big comment above `countLineWrite` in `db/schema.ts`).
`editCountLineFills` REPLACES the whole array, which has no delta
representation in that shape (unlike `setCountLineQuantities`'s scalar
`target - current` trick, which stays fine because subtraction is
well-defined for a scalar but not for "which tenths readings changed").
`partial_fills_delta` stays `[]` on `fill_correction` rows on purpose —
repurposing it to carry the after-array would make delta-summation silently
wrong for any code that still treats every row as a `scan` append.

**Scope boundary — deliberately schema only.** The actual ledger INSERT
inside `editCountLineFills`'s existing transaction (right where
`partialFills: input.partialFills` sits in the `tx.update(countLine)...set`,
`lib/domain/counts.ts`) is backend work and was explicitly NOT done here.
Whoever picks that up next needs to: capture `partialFillsBefore` from the
row already locked via `.for("update")` just above (the `line` variable, its
`.partialFills`), set `partialFillsAfter: input.partialFills`, and
`writeType: "fill_correction"` — same transaction, ledger insert can go
either before or after the countLine update since (unlike the scan path)
there's no separate duplicate-key-triggers-rollback ordering requirement
noted for this path in the code today, but check that assumption before
writing it.

Verified against MariaDB 11.8.8 in an isolated throwaway stack
(`docker-compose.worktree-test.yml -p truestock-openitem2-test`, db on host
port 3309, torn down after): full chain `0000`→`0008` applies clean from
empty, `DESCRIBE count_line_write` shows the three columns with expected
type/null/default, and `SHOW CREATE TABLE` before/after a manual
add-then-drop-then-readd round trip is byte-identical at each step. No
`DROP INDEX` needed on reversal — none of these three columns are indexed,
so [[mariadb-composite-index-survives-column-drop]] doesn't apply here.
`bun run typecheck` clean. Rollback SQL documented in `db/README.md`
following the existing per-migration convention (see its `0005`-`0007`
entries for the pattern).
