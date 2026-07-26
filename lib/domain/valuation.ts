/**
 * Pure valuation math. No I/O — spec §8/§9 and CLAUDE.md invariant 2 in one
 * place so every caller (count summary, close-count) computes it identically.
 *
 *   units           = (sealed_case_qty × case_size_at_count)
 *                      + sealed_each_qty
 *                      + sum(partial_fills)
 *   extended_value   = units × unit_cost_at_count
 *
 * Both `unit_cost_at_count` and `case_size_at_count` are nullable on
 * CountLine by deliberate schema decision (db/schema.ts's comment above
 * `count_line`, CLAUDE.md invariant 2): NULL means "unpriced/unsized at
 * count time", and must never be coerced to 0. A line whose value can't be
 * computed is EXCLUDED from any total, never summed as $0 — and the caller
 * is responsible for surfacing how many lines were excluded and why, so an
 * unpriced bottle can never quietly masquerade as a free one.
 */

export interface ValuationLine {
  sealedCaseQty: number;
  sealedEachQty: number;
  partialFills: number[];
  /** DECIMAL(10,4) column — read as a string by drizzle-orm's mysql driver. */
  unitCostAtCount: string | null;
  caseSizeAtCount: number | null;
}

export type UnitsExclusionReason = "missing_case_size";
export type ValueExclusionReason = "missing_cost" | "missing_case_size";

export interface LineValuation {
  /** null when units can't be computed at all (see `unitsExcludedReason`). */
  units: number | null;
  unitsExcludedReason: UnitsExclusionReason | null;
  /** null when a dollar value can't be computed (see `valueExcludedReason`). */
  extendedValue: number | null;
  valueExcludedReason: ValueExclusionReason | null;
}

/**
 * Units from cases are only computable if `case_size_at_count` was
 * snapshotted. If `sealed_case_qty` is 0, the case term is 0 regardless of
 * whether `case_size_at_count` is known — there is no ambiguity in "zero
 * cases of an unknown size." If `sealed_case_qty` is positive and
 * `case_size_at_count` is NULL, the case contribution is genuinely unknown
 * and the whole line's unit count is indeterminate; it must not be treated
 * as 0 cases' worth.
 */
export function computeLineUnits(line: ValuationLine): {
  units: number | null;
  reason: UnitsExclusionReason | null;
} {
  if (line.sealedCaseQty > 0 && line.caseSizeAtCount == null) {
    return { units: null, reason: "missing_case_size" };
  }
  const caseUnits = line.sealedCaseQty * (line.caseSizeAtCount ?? 0);
  const partialUnits = line.partialFills.reduce((sum, f) => sum + f, 0);
  return { units: caseUnits + line.sealedEachQty + partialUnits, reason: null };
}

export function computeLineValuation(line: ValuationLine): LineValuation {
  const { units, reason: unitsExcludedReason } = computeLineUnits(line);

  if (units == null) {
    // Units are indeterminate, so value necessarily is too. Report the
    // units reason as the value reason as well — there's only one root
    // cause here.
    return {
      units: null,
      unitsExcludedReason,
      extendedValue: null,
      valueExcludedReason: "missing_case_size",
    };
  }

  if (line.unitCostAtCount == null) {
    return {
      units,
      unitsExcludedReason: null,
      extendedValue: null,
      valueExcludedReason: "missing_cost",
    };
  }

  const unitCost = Number(line.unitCostAtCount);
  // Round to cents at the point of aggregation into a dollar figure — the
  // snapshot itself stays DECIMAL(10,4) precision; only the display/sum
  // value is money-rounded, matching Count.total_value's DECIMAL(12,2).
  const extendedValue = Math.round(units * unitCost * 100) / 100;

  return {
    units,
    unitsExcludedReason: null,
    extendedValue,
    valueExcludedReason: null,
  };
}

export interface ValuationTotals {
  totalValue: number;
  totalUnits: number;
  pricedLineCount: number;
  /** Lines excluded from totalValue — no cost, no case size, or both. */
  excludedLineCount: number;
}

export function summarizeValuation(lines: ValuationLine[]): ValuationTotals {
  let totalValue = 0;
  let totalUnits = 0;
  let pricedLineCount = 0;
  let excludedLineCount = 0;

  for (const line of lines) {
    const v = computeLineValuation(line);
    if (v.units != null) {
      totalUnits += v.units;
    }
    if (v.extendedValue != null) {
      totalValue += v.extendedValue;
      pricedLineCount += 1;
    } else {
      excludedLineCount += 1;
    }
  }

  return {
    totalValue: Math.round(totalValue * 100) / 100,
    totalUnits,
    pricedLineCount,
    excludedLineCount,
  };
}
