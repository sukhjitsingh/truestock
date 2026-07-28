---
name: project-backend-layer-review-2026-07-25
description: First full pass over the backend layer (lib/authz.ts, lib/auth.ts, lib/domain/*, app/actions/*) — invariants 1/2/7/8 all verified sound; two open (non-invariant) gaps left for later
metadata:
  type: project
---

Reviewed 2026-07-25: `lib/authz.ts`, `lib/auth.ts`, `app/api/auth/[...all]/route.ts`,
`lib/domain/{catalog,counts,reports,valuation,errors}.ts`, `lib/validation/{catalog,counts}.ts`,
`lib/action-result.ts`, `app/actions/{catalog,counts,reports}.ts`, `scripts/create-user.ts`.

**Invariant 1 (closed counts immutable) — fully enumerated, holds.** Every write to
`count_line` goes through exactly two entry points: `applyIncrement` (used by both
`incrementCountLine` and `scanCountLine`) and `editCountLineFills`, both in
`lib/domain/counts.ts`. Both call `assertCountWritable(tx, countId)` — a `SELECT status
... FOR UPDATE` that throws `ClosedCountError` on `status === "closed"` — as the first
thing inside their transaction, before any row lock or write on `count_line`. No other
`.insert(countLine)`/`.update(countLine)` call exists anywhere in `lib/` or `app/` (verified
by grep). Note the domain intentionally only blocks `closed`, not `submitted`/`reviewed` —
that matches `docs/spec.md` §5 ("Once Closed, the count is immutable") verbatim, not a gap.

**Invariant 8 (cost/margin gated by role) — traced end-to-end, holds.** Every query that can
touch `product.currentUnitCost` or `countLine.unitCostAtCount` checks `canSeeCost(role)`
(owner-only, per `lib/authz.ts`) *in the query itself* (`lib/domain/catalog.ts`'s
`selectProducts` doesn't even select the column for non-owners) and again in the response
shape (`lib/domain/counts.ts`'s `toCountLineRow`, `lib/domain/reports.ts`'s `countSummary`).
`app/actions/reports.ts` additionally gates the whole report at `requireRole("owner",
"manager")` — staff can't reach it at all. No leak found via error messages either — all
domain errors (`lib/domain/errors.ts`) carry role-agnostic, generic text.

**Two open gaps found, neither an invariant violation, left for a future pass:**
1. `lib/domain/counts.ts:349-357` — the `draft -> in_progress` auto-promotion on first
   line write runs as a second, unawaited-into-the-transaction `UPDATE ... WHERE
   status='draft'` *after* the line-write transaction commits, not inside it. It's
   self-healing (idempotent WHERE clause, and any subsequent write to the same count
   retries it) and doesn't threaten invariant 1, but if this specific statement throws
   (e.g. a dropped connection right after commit), the caller sees a failed
   `ActionResult` even though the count-line write already succeeded and persisted —
   a false-negative response on an already-successful write. Low severity; worth a
   comment or a retry wrapper if it comes up in practice.
2. There is no "set"/decrement path for `sealedCaseQty`/`sealedEachQty` — only
   `applyIncrement`'s non-negative deltas. `editCountLineFills` gives `partialFills` a
   full-replace correction path; sealed quantities have no equivalent, so a mis-typed
   "5 cases" instead of "3" during an *open* (not yet closed) count has no in-app
   correction mechanism today. May be deliberate MVP scope (spec's adjustment-record
   mechanism is explicitly a post-close concept), but flag if the frontend agent asks
   for a correction UI and finds no backend action to call.

See [[project-product-name-not-unique]] for a related, smaller finding (duplicate-key
error handling in `catalog.ts`) from the same review.
