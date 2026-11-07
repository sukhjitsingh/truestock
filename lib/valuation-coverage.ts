/**
 * How much of a dollar total is actually backed by a cost.
 *
 * A valuation only sums lines that carry a cost and a case size snapshot;
 * the rest are excluded, never valued at zero (invariant 2, lib/domain/valuation.ts).
 * That makes a bare `$0.00` ambiguous: it can mean "worth nothing" or "no
 * costs on file yet", and on a fresh catalog it is always the second. A
 * plausible-but-wrong figure on the Close count button — the one irreversible
 * control — is the failure AGENTS.md ranks worst (phone test 2026-10-25, DB-1).
 *
 * Every place that prints a valuation figure asks this module how to caveat it,
 * so the wording and the thresholds exist once.
 *
 *   empty    no lines at all — a total of $0.00 is simply true; no caveat
 *   none     lines exist and none is costed — the total is not a value at all
 *   partial  some lines costed — the total is real but understated
 *   full     every line costed — no caveat
 */
export type CoverageState = "empty" | "none" | "partial" | "full";

export interface ValuationCoverage {
  state: CoverageState;
  pricedLineCount: number;
  excludedLineCount: number;
  totalLineCount: number;
  /** Caveat to print beside the figure; null when there is nothing to caveat. */
  label: string | null;
  /** True when the figure is not backed by every line — drives warning colour. */
  incomplete: boolean;
  /** Show a dash instead of the figure: no line is costed, so it is not a value. */
  suppressFigure: boolean;
}

export function describeValuationCoverage(totals: {
  pricedLineCount: number;
  excludedLineCount: number;
}): ValuationCoverage {
  const priced = Math.max(0, totals.pricedLineCount);
  const excluded = Math.max(0, totals.excludedLineCount);
  const total = priced + excluded;

  const base = {
    pricedLineCount: priced,
    excludedLineCount: excluded,
    totalLineCount: total,
  };

  if (total === 0) {
    return { ...base, state: "empty", label: null, incomplete: false, suppressFigure: false };
  }
  if (priced === 0) {
    return {
      ...base,
      state: "none",
      label: "No costs on file",
      incomplete: true,
      suppressFigure: true,
    };
  }
  if (excluded > 0) {
    return {
      ...base,
      state: "partial",
      // partial means at least one costed and one excluded line, so total >= 2.
      label: `${priced} of ${total} lines costed`,
      incomplete: true,
      suppressFigure: false,
    };
  }
  return { ...base, state: "full", label: null, incomplete: false, suppressFigure: false };
}
