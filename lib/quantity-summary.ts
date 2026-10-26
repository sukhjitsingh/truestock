/**
 * The two summary lines on the sealed-quantity editor ("This write adds" /
 * "Correction delta"), as pure functions so every branch is unit-testable
 * (tests/quantity-summary.test.ts).
 *
 * The rule both enforce: a line whose case size is unknown has an unknown number
 * of units whenever it holds cases. Printing a number there — `+0 units`, or
 * `1 units` for one case of unknown size — is a plausible-but-wrong figure on
 * the screen the counter uses to decide whether their input is right.
 */
import { formatUnits } from "@/lib/utils";

export const UNITS_UNKNOWN = "units unknown — no case size";

/**
 * ADD mode: what this write adds. Cases of an unknown size are an unknown
 * number of units, not 1 each. Zero cases is unambiguously zero (same rule as
 * `computeLineUnits`).
 */
export function describeAddedUnits(args: {
  cases: number;
  eaches: number;
  caseSize: number | null;
}): string {
  const { cases, eaches, caseSize } = args;
  if (caseSize == null && cases > 0) return UNITS_UNKNOWN;
  return `${formatUnits(cases * (caseSize ?? 0) + eaches)} units`;
}

/**
 * SET mode: the change versus the recorded line, in units. `null` means one
 * side of the subtraction is unknown (a case size is missing) — say so rather
 * than render it as "+0 units".
 */
export function describeUnitDelta(delta: number | null): string {
  if (delta == null) return UNITS_UNKNOWN;
  const magnitude = formatUnits(Math.abs(delta));
  // A delta that rounds to zero at display precision is "no change", not "+0".
  if (Number(magnitude.replace(/,/g, "")) === 0) return "no change";
  return `${delta > 0 ? "+" : "−"}${magnitude} units`;
}
