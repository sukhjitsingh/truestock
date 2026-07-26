---
name: project-snapshot-columns-vs-null-catalog
description: RESOLVED 2026-07-25 — CountLine.unit_cost_at_count/case_size_at_count are now nullable and the backend (valuation.ts, counts.ts, reports.ts) correctly excludes NULL from totals rather than coercing to 0. Kept for history/context only.
metadata:
  type: project
---

**RESOLVED as of the backend-layer review on 2026-07-25.** Re-read `db/schema.ts`'s
`countLine` table: `unitCostAtCount`/`caseSizeAtCount` are now nullable (not NOT NULL as
originally flagged), matching `docs/spec.md`'s data-model section verbatim ("Both are
nullable on CountLine... NULL means unpriced at count time"). `lib/domain/valuation.ts`
implements this correctly end-to-end: `computeLineValuation`/`computeLineUnits` never
coerce NULL to 0, a `sealedCaseQty > 0` with NULL `caseSizeAtCount` is treated as
genuinely indeterminate (not "0 cases"), and `summarizeValuation` returns a distinct
`excludedLineCount` alongside `totalValue`/`pricedLineCount` so an unpriced line is
visibly excluded, not invisibly zeroed. `lib/domain/counts.ts`'s `applyIncrement` snapshots
`currentUnitCost`/`caseSize` from `product` at insert time and never re-reads live.
`lib/domain/reports.ts`'s `countSummary`/`reorderList` both use the same
`computeLineValuation` path — no separate/divergent valuation logic exists anywhere. No
further action needed here; re-verify only if `db/schema.ts` or `lib/domain/valuation.ts`
changes again.

---

Original finding (2026-07-24, first DB-layer commit — kept for context):

Found 2026-07-24 reviewing the first DB-layer commit (`db/schema.ts`,
`db/seed.ts`, `drizzle/0000_slim_johnny_storm.sql`).

`count_line.unit_cost_at_count` (decimal(10,4)) and `count_line.case_size_at_count`
(int) are both `NOT NULL`, correctly implementing invariant 2 (snapshot, never
join live). But `db/seed.ts` deliberately leaves `product.current_unit_cost`
and `product.case_size` NULL for 88 of the 97 seeded products (only the 9 keg
products get a real cost, from `draft-economics.csv`; case_size is NULL for
*all* 97 — it's blank in `products.csv` for every row). No product in the
current catalog has case_size set at all.

**Why this matters:** with the schema as landed, a CountLine cannot be
inserted for ~everything in the catalog without the (not-yet-written) backend
inventing a sentinel value (e.g. `0.0000` cost, `1` case size) to satisfy the
NOT NULL constraint. A silent `0.0000` cost is exactly the "looks plausible,
is wrong" failure mode CLAUDE.md calls out — it makes a real, counted bottle
contribute $0 to `total_value`, and once real costs land later there's no way
to distinguish "counted before pricing existed" from "actually free." This
would also concretely block or corrupt the very first count, which is the
highest-risk moment in the product (scan-to-enroll speed).

**How to apply:** when the `backend` agent's server actions for count-line
writes land, check how they resolve a product with NULL current_unit_cost/
case_size. Acceptable resolutions: (a) make these columns nullable and treat
NULL as "priced later, excluded from total_value until corrected" — safer
than a sentinel; (b) require cost/case_size entry as a hard gate before a
product can be counted (a UI/workflow decision, not just a schema one). Don't
let a `0.0000`/`1` sentinel ship silently — that's the bug this note exists
to catch. Re-verify this is still true by rereading `db/schema.ts`'s
`countLine` table and `db/seed.ts`'s `seedProducts`/`seedKegCosts` before
citing it — this is describing the schema as of the initial commit, not
necessarily today's.
