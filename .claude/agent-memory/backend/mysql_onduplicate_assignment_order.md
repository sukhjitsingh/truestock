---
name: mysql-onduplicate-assignment-order
description: MySQL/MariaDB evaluates UPDATE / ON DUPLICATE KEY UPDATE assignments in the TABLE's declared column order, not the statement's or Drizzle's set{} key order — a single-statement upsert cannot compare a column's old value against a new value on that SAME column within one statement
metadata:
  type: feedback
---

`UPDATE ... SET a = ..., b = ...` and `INSERT ... ON DUPLICATE KEY UPDATE SET a =
..., b = ...` (same row-update machinery in MySQL/MariaDB) evaluate assignments
strictly **left to right, in the target table's declared column order** — never
the order written in the SQL statement, and for Drizzle specifically, never the
key order of the JS `set: {}` object literal. Drizzle's own `buildUpdateSet`
(`mysql-core/dialect.js`) derives assignment order from
`Object.keys(table[Table.Symbol.Columns])` — the schema's declaration order —
filtering only by which keys are present in the caller's `set`, never
reordering by the caller's key order. So `set: { b: ..., a: ... }` on a table
that declares `a` before `b` still emits `SET a = ..., b = ...`.

Concretely, this means a single statement CANNOT compare a "new" value against
a column's "old" (pre-statement) value if that same column is also being
written in the same statement and it happens to be declared BEFORE the
value-computing expression. A later assignment sees the earlier assignment's
*already-applied new value*, not the pre-statement row — this is also why the
`SET col1 = col1 + 1, col2 = col1` idiom exists at all (it relies on this
ordering, doesn't fight it).

**Why:** Discovered building `lib/domain/matching.ts`'s `upsertAliasCore`
(Truestock Phase 2.5 Slice 3, 2026-08-15/16) — a `vendor_alias`
insert-or-reconfirm-or-correct upsert needs to compare the SUBMITTED
`productId` against the alias's CURRENT (pre-write) `productId` to decide
whether to climb `matchConfidence` (reconfirmation) or reset it to 0.500
(correction). The first version tried one `INSERT ... ON DUPLICATE KEY UPDATE`
with `matchConfidence` computed by a SQL `CASE WHEN vendor_alias.product_id =
:new THEN <climb> ELSE 0.500 END`. It always took the climb branch, even on a
genuine productId change — because `db/schema.ts` declares `productId` before
`matchConfidence` on `vendorAlias`, so `product_id` had already been
overwritten to the new value by the time the `CASE` evaluated it. Reordering
the JS `set: {}` literal's own keys (an obvious-looking fix) did NOT help —
proven wrong by a real test run before the schema-order root cause was found
by reading Drizzle's actual `buildUpdateSet` source.

**How to apply:** Never reach for a single `INSERT ... ON DUPLICATE KEY UPDATE`
(or plain multi-column `UPDATE`) when a column's NEW value must be computed
from that SAME column's OLD value elsewhere in the statement, unless you
control (and can verify) the target table's own column declaration order —
and even then, that's fragile against a future schema reorder. Instead follow
this codebase's established `lib/domain/counts.ts` idiom (`upsertCountLineRow`
/ `incrementCountLine`, see [[counts-increment-idempotency]]): try the `INSERT`
first, catch a duplicate-key error via `isDuplicateKeyError`
(`lib/domain/db-errors.ts`), and on catch, `SELECT ... FOR UPDATE` the existing
row, branch/compute the new value in JS against the row you just read, then
issue a plain single-column-safe `UPDATE`. Try INSERT first — never `SELECT
... FOR UPDATE` a possibly-absent row up front — to avoid the gap-lock
deadlock this codebase already hit once for `count_line` (memory:
`truestock-countline-gap-lock-deadlock` in the shared auto-memory). This
pattern generalizes to any future "reconfirm vs. reset" or "increment vs.
initialize" upsert in this codebase, not just `vendor_alias`.
