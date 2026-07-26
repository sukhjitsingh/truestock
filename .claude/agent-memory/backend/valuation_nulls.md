---
name: valuation-nulls
description: How CountLine's nullable unit_cost_at_count/case_size_at_count are handled in valuation math (lib/domain/valuation.ts) — read before touching count summary, reorder, or close-count math
metadata:
  type: project
---

`count_line.unit_cost_at_count` and `case_size_at_count` are nullable by
deliberate schema decision (most of the seeded catalog has no cost, none has
a case size). Invariant 2 (CLAUDE.md): NULL must never be coerced to 0 — a
line whose value can't be computed is excluded from any total, never summed
as $0, and the exclusion count must be surfaced separately.

`lib/domain/valuation.ts` is the single place this math lives (used by
`lib/domain/counts.ts`'s `closeCount`/`getCount` and `lib/domain/reports.ts`'s
`countSummary`/`reorderList` — all four import the same functions rather
than reimplementing the formula):

- `units = sealed_case_qty × case_size_at_count + sealed_each_qty +
  sum(partial_fills)` — BUT if `sealed_case_qty > 0` and `case_size_at_count`
  is NULL, units are indeterminate for the whole line (not "0 cases' worth"),
  distinct from `sealed_case_qty === 0` where the case term is unambiguously
  0 regardless of an unknown case size.
- `extended_value = units × unit_cost_at_count`, null if either units or cost
  is null.
- `summarizeValuation()` returns `totalValue`, `totalUnits`,
  `pricedLineCount`, `excludedLineCount` — the last one is what a report
  surfaces as "N lines counted but unpriced."

Reorder list (`lib/domain/reports.ts`) treats an indeterminate-units line as
contributing 0 to on-hand — a documented, deliberate choice to understate
stock rather than guess, since that's the safer direction to be wrong in for
a beverage program (avoidable reorder suggestion vs. missed stockout).

Money is rounded to cents (`Math.round(x * 100) / 100`) only at the point of
aggregating into a dollar figure — the DECIMAL(10,4) snapshot itself is never
rounded early.
