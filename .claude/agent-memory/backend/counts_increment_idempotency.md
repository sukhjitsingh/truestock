---
name: counts-increment-idempotency
description: The resolved (2026-07-25, second iteration) design for count_line write idempotency via the count_line_write ledger — read before changing scan/increment/correction logic
metadata:
  type: project
---

**Superseded design, kept for context:** the first iteration (2026-07-24)
treated `count_line.client_line_id` (a single mutable column, overwritten on
every increment) as "the id of the most recently applied write to that row."
Code review (2026-07-25) found the flaw: that only catches a retry of the
*immediately preceding* write. An out-of-order replay — write A applies, its
ack is lost, write B applies and overwrites the stored id with B's, then A
retries off the client's queue — fails the equality check and silently
double-applies A. Exactly CLAUDE.md's named worst failure mode. Do not
resurrect this design.

**Current design:** `client_line_id` was removed from `count_line` entirely
and moved to a new append-only ledger table, `count_line_write`, where it's
UNIQUE — one permanent row per write, not per line. A duplicate-key
violation inserting into the ledger *is* the "already applied" signal,
enforced by the database across a line's *whole* history.

Two unique constraints are now on two different tables and must not be
conflated — they mean opposite things:
- `count_line`'s composite `(count_id, product_id, location_id)` colliding =
  "a line for this target already exists" = genuine second scan = increment.
  Handled entirely inside `upsertCountLineRow` in `lib/domain/counts.ts`,
  recovered without ever leaving the transaction.
- `count_line_write`'s `client_line_id` colliding = "this exact write was
  already applied" = replay = no-op. Only detectable AFTER the ledger
  insert, deliberately NOT caught inside the transaction — letting it
  propagate rolls back the count_line increment too. Caught by the *caller*
  (`applyIncrement`/`setCountLineQuantities`), after rollback, which then
  re-reads whatever an earlier write already committed and returns THAT as
  an ordinary success — a replaying client must never see an error.

Required write order in one transaction: (1) insert-or-increment
`count_line` first — resolves `count_line.id`; (2) insert the ledger row
referencing it. An unlocked pre-check (`findReplayedLine`, before opening
the transaction) short-circuits the common retry case for performance; it
is NOT the correctness mechanism — the unique index + rollback is.

Lock ordering unchanged from before: every write path locks `count` before
`count_line` (`assertCountWritable` first, then the row). Applies to
`editCountLineFills` and the new `setCountLineQuantities` too.

**New in this round:** absolute-set correction action for sealed quantities
(`setCountLineQuantities`) — the scan/increment path is additive-only and had
no way to walk a mistyped quantity back down. It still goes through the same
ledger-protected pattern (naturally-idempotent-at-the-row-level does NOT mean
idempotent-at-the-ledger-level, since the delta depends on state at apply
time). How a SET represents itself in a delta-shaped ledger: `delta = target
- current` (computed under the row lock), so "sum the ledger's deltas
reconstructs current state" stays true for corrections too, not just
increments — a correction is indistinguishable in the ledger from a
well-timed real increment, which is exactly what preserves that property.

**CLOSED 2026-08-20 (docs/open-items.md #2):** `editCountLineFills` now writes
a ledger entry too, matching the pattern above rather than inventing a new
one. The schema half added a discriminator column,
`count_line_write.write_type` (`countLineWriteTypeEnum = ["scan",
"fill_correction"]`, db/enums.ts — NOT NULL DEFAULT `'scan'`, so every
pre-existing row backfills correctly with no data migration), plus two new
nullable columns, `partial_fills_before` / `partial_fills_after`. The
domain-logic half (`lib/domain/counts.ts`) then did three things:
1. Added the SAME `findReplayedLine` pre-check + try/catch-duplicate-
   key-fallback-to-replay shape `setCountLineQuantities` uses — it never had
   this before because it never wrote a ledger row, so there was nothing to
   replay-detect. Now that it does, a legitimate retry needed the same
   protection or it would throw a raw duplicate-key error instead of
   returning the earlier result. `applyIncrement` and `setCountLineQuantities`
   are the templates to copy for any THIRD write path this table ever grows.
2. Captured `partialFillsBefore = line.partialFills` under the same
   `SELECT ... FOR UPDATE` row lock as the update, `partialFillsAfter =
   input.partialFills` (what's being written) — not from the client's belief
   of the prior state.
3. Inserted the ledger row with `writeType: "fill_correction"`,
   `sealedCaseDelta: 0`, `sealedEachDelta: 0`, `partialFillsDelta: []` (that
   column stays meaningless/default on this write type — do not repurpose it
   to carry the new array), plus the before/after pair. Ledger insert still
   goes SECOND, uncaught inside the transaction, same reasoning as every
   other write path here.

Chose before/after-array storage over a delta representation because a
full-array REPLACE has no meaningful decomposition into
`partial_fills_delta`'s additive-append shape — this was the schema decision
this memory used to flag as undecided; it's now made and lives in
db/schema.ts's comment above `countLineWrite`.

Mutation-checked: temporarily deleting the ledger insert from
`editCountLineFills` and re-running `tests/count-write-path.test.ts -t "fill
corrections"` fails exactly the two ledger-shape assertions (row count and
replay-doesn't-duplicate) and leaves the writeType-default test passing —
confirms the new tests actually exercise the write, not just the count_line
side-effect.

See [[valuation-nulls]] for the (unrelated, still current) valuation-math memory.
