---
name: parallel-dev-stale-contract-and-shared-docker-stack
description: Two lessons from building Phase 2.5 Slice 2's invoice review screen in parallel with the backend agent that landed its own actions/validation/domain files concurrently
metadata:
  type: feedback
---

Two things that mattered when the frontend and backend agents worked the same
slice concurrently, each in their own reserved files (Phase 2.5 Slice 2,
2026-08-15).

**1. A provisional contract handed in the task brief can go stale mid-task —
verify it directly against the reserved files, don't keep coding against the
brief.** The original brief described `lines: {id, rawGross?: number|null,
...}[]`; the backend actually landed `corrections` (not `lines`) with
money fields as **regex-validated strings**, not `number|null`
(`lib/validation/invoices.ts`'s `moneyStringSchema`). Caught by directly
reading `app/actions/invoices.ts` / `lib/validation/invoices.ts` /
`lib/domain/invoice-lines.ts` (reserved-but-readable) rather than trusting the
brief's shape. Once confirmed, reused the server's own Zod schemas
client-side (`lineCorrectionSchema.safeParse()`, `rejectInvoiceSchema.safeParse()`)
instead of hand-rolling parallel validation — this makes client/server drift
structurally impossible rather than something to keep back in sync by hand.
**How to apply:** whenever a task brief for parallel work gives a "provisional"
contract, treat it as a starting guess, not ground truth — re-derive the real
shape from the other agent's files once they exist, ideally by importing and
reusing their exported schemas/types rather than redeclaring them.

**2. A docker-compose stack shared with a concurrently-running backend agent
can disappear mid-session without warning, once that agent finishes and tears
its own stack down.** Built a full browser-verification setup (isolated
`truestock-app-slice1`/`truestock-mariadb-slice1` stack, seeded fixtures, two
throwaway accounts, a socat proxy to reach the unpublished app port) — then
the entire stack, its volumes, and its network vanished between one tool call
and the next, because the backend agent's own `docker compose down -v` ran as
part of its completion. Recovered by recreating the same compose file from
scratch (see [[testing-parallel-worktree-docker-and-migration-race]] in the
backend agent-memory dir for the isolated-stack pattern itself — distinct
`container_name`s, distinct volumes, distinct `-p` project, no published
ports) and re-seeding. **How to apply:** don't assume a docker stack built
earlier in a parallel-agent session is still there — `docker ps -a` / `docker
volume ls` before reusing it, and be ready to rebuild the whole thing cheaply
rather than debugging why containers you remember starting aren't running.

Also: hand-seeding fixture invoice rows via raw SQL (rather than through the
real upload+extraction pipeline) must include `retention_until` —
`reviewInvoiceAction`'s CAS refuses `needs_review -> reviewed` with a plain
"missing: retentionUntil" error if it's NULL, since in production it's always
computed from `invoice_date` at extraction time and the domain layer assumes
that already happened. This surfaced as a real, correctly-rendered error
banner (not a bug) — the fixture was wrong, not the UI. Backfill it
(`invoice_date + INTERVAL 2 YEAR`, per spec §10's 2-year retention) whenever
hand-seeding an invoice fixture for browser testing.
