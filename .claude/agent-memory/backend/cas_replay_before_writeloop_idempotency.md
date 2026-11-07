---
name: cas-replay-before-writeloop-idempotency
description: Slice 4 (invoice approval / cost flow) idempotency pattern — a status CAS returning zero-rows-affected short-circuits BEFORE re-entering a per-line write loop, rather than relying on a UNIQUE constraint to swallow a duplicate-key replay
metadata:
  type: project
---

`lib/domain/invoice-approval.ts:approveInvoice` (Phase 2.5, Slice 4 — "reviewed
-> approved" writes `product.current_unit_cost` + an append-only
`product_cost_history` row per matched line) uses a DIFFERENT idempotency
shape than the two existing documented patterns
([[counts-increment-idempotency]], [[vendor-alias-matching-design]]).

**The pattern:** the transaction's own `SELECT ... FOR UPDATE` + branch on
`invoice.status` is the PRIMARY idempotency mechanism, not the table's
`UNIQUE` constraint:
- `status === "approved"` already -> return the current row as success
  (`costLinesApplied: 0`) and never touch the per-line write loop at all.
  This is what makes both a sequential replay AND a real concurrent race
  (`Promise.all` of two `approveInvoice` calls — the loser's `FOR UPDATE`
  blocks until the winner commits, then observes `approved`) apply costs
  exactly once.
- `product_cost_history`'s `UNIQUE(source_invoice_line_id)` is a BACKSTOP
  against a bug in that CAS re-entering the loop — not the mechanism itself.
  It's deliberately a plain (non-tenant-scoped) unique, same reasoning as
  `count_line_write.client_line_id`: a `source_invoice_line_id` already
  identifies exactly one row in a tenant-scoped table, so a per-tenant scope
  adds nothing.

**Why this shape and not `lib/domain/matching.ts:upsertAliasCore`'s
"insert first, catch 1062, recover with `SELECT ... FOR UPDATE`" idiom:** the
04-slices.md spec is explicit — "Zero rows affected means it was already
approved — return the original success, not an error. This CAS is the
concurrency gate; everything below only runs if it won." The alias idiom
recovers from an expected duplicate-key collision; this pattern prevents ever
reaching the write attempt on a replay in the first place.

**Also distinct from `lib/domain/invoices.ts:updateInvoiceStatusTx`** (the
general-purpose CAS every other invoice transition uses): that function
treats ANY status mismatch — including "already at the target status" — as a
`ConflictError`. `approveInvoice` does NOT call it directly; it duplicates the
`SELECT ... FOR UPDATE` + branch shape itself so it can special-case
`status === "approved"` as success rather than a conflict. Worth remembering
before assuming every CAS in this codebase shares one function.

**How to apply:** reach for this shape (not the alias-recovery idiom) for any
future write where "the action already happened" should be a silent success
rather than a recoverable duplicate-key error — e.g. a future audit-packet
generation step that also derives+writes downstream rows from a one-way
status transition.
