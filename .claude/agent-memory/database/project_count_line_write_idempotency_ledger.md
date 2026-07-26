---
name: project-count-line-write-idempotency-ledger
description: count_line.client_line_id was removed 2026-07-25 and replaced by an append-only count_line_write ledger table — a single mutable idempotency column can't survive out-of-order retries against a row that gets incremented many times
metadata:
  type: project
---

Code review (coordinator, 2026-07-25) found that the original design —
`count_line.client_line_id`, a single mutable UNIQUE column overwritten on
every increment — was insufficient. A count line is incremented many times
over a count's life (every scan of the same product+location adds to the
existing row, per the `(count_id, product_id, location_id)` unique
constraint), so "remember the most recent write's id" can only catch a
retry of that one write. An earlier write, retried after a later one has
already landed (ack lost, then retried off the IndexedDB queue on
reconnect), doesn't match the stored id and silently re-applies —
double-counting `partial_fills` while the total still looks plausible.
Fixed by adding `count_line_write`: one permanent row per write, keyed by
that write's `client_line_id`, UNIQUE, with the delta it applied
(`sealed_case_delta`, `sealed_each_delta`, `partial_fills_delta`). A
duplicate-key violation on insert is the "already applied" signal — the
database enforces idempotency, not a column. `count_line.client_line_id`
was dropped entirely (not kept as a non-unique cache) — see
`db/README.md`'s "Idempotency ledger" section and the large comment above
`countLineWrite` in `db/schema.ts` for full reasoning, including the
required write order (count_line insert-or-increment MUST happen before the
count_line_write insert, same transaction, so a duplicate-key rollback
undoes both).

**Why this matters for future sessions:** at the time this fix landed,
`lib/domain/counts.ts` (backend agent's file, pre-existing) already
implemented the OLD single-column design and became a known, expected
typecheck/build failure — the database agent was explicitly told not to
touch `lib/` or `app/` when making this change. If a future session finds
`lib/domain/counts.ts` failing typecheck against `count_line`/`countLineWrite`,
check whether it's already been updated to the ledger design before
assuming something is broken.

**How to apply:** any future schema change to the counting write path should
preserve the "ledger row insert happens after and in the same transaction
as the count_line write" ordering — it's load-bearing, not incidental.
