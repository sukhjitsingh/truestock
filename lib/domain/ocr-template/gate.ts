/**
 * The verification gate for a deterministic OCR extraction. A template that
 * "found some lines" has proven nothing; this decides whether what it found
 * is trustworthy enough to skip Claude Vision. When it says no, the caller
 * escalates — that is the designed outcome, not an error.
 *
 * Stricter than the extraction pipeline's `arithmeticCheck`
 * (`lib/domain/extraction-pipeline.ts`), on purpose:
 *   - `arithmeticCheck` PASSES when the header total is null ("an absence of
 *     a claim, not a contradiction"). Here a missing printed total FAILS:
 *     a template has no second opinion (unlike Vision), so without the
 *     invoice's own total there is nothing to check the lines against.
 *   - `arithmeticCheck` EXCLUDES a line with no `rawGross` from the sum and
 *     passes anyway. Here a missing `rawGross` fails, because the sum is only
 *     meaningful over every line.
 *   - It also checks each line's own qty x unit cost == extended (a line
 *     with an unread quantity, unit cost or extension fails rather than being
 *     skipped), and that deposit credits are negative — a flipped digit in a
 *     quantity moves no total, so the sum alone cannot see it.
 *
 * All comparisons are integer arithmetic (see `money.ts`). Never throws.
 */
import type { DraftInvoiceLine } from "@/lib/domain/invoice-lines";
import { formatCents, parseDecimalUnits } from "./money";
import type { OcrGateFailure, OcrGateResult, OcrTemplateHeader } from "./types";

/**
 * Per-line qty x unit cost vs extended slack: one cent, the rounding a
 * printed extension can carry.
 */
const LINE_TOLERANCE_USD = 0.01;

/**
 * Sum-of-lines vs printed total slack. Duplicated from
 * `ARITHMETIC_TOLERANCE_USD` in `lib/domain/extraction-pipeline.ts` rather
 * than imported: that module imports the database client, and this one must
 * stay pure. Keep the two equal.
 */
const TOTAL_TOLERANCE_USD = 0.02;

/** Working scale for every comparison: units of 10^-4 dollars. */
const SCALE = 4;
const UNITS_PER_DOLLAR = 10 ** SCALE;
const LINE_TOLERANCE_UNITS_E8 = Math.round(LINE_TOLERANCE_USD * UNITS_PER_DOLLAR) * UNITS_PER_DOLLAR;
const TOTAL_TOLERANCE_UNITS = Math.round(TOTAL_TOLERANCE_USD * UNITS_PER_DOLLAR);

/** Line types whose printed total must never be negative. */
const NON_NEGATIVE_TYPES: ReadonlySet<DraftInvoiceLine["lineType"]> = new Set([
  "product",
  "deposit",
  "freight",
  "tax",
  "fee",
]);

function unitsToCents(units: number): number {
  return Math.round(units / (UNITS_PER_DOLLAR / 100));
}

export function verifyOcrExtraction(header: OcrTemplateHeader, lines: DraftInvoiceLine[]): OcrGateResult {
  const failedChecks: OcrGateFailure[] = [];
  let sumGross: string | null = null;
  let printedTotal: string | null = null;
  let diff: string | null = null;

  try {
    const printedUnits = parseDecimalUnits(header.totalGross, SCALE);
    if (printedUnits == null) {
      failedChecks.push({
        check: "printed-total-missing",
        detail: "The invoice's printed total was not read, so there is nothing to verify the lines against.",
      });
    } else {
      printedTotal = formatCents(unitsToCents(printedUnits), 2);
    }

    if (lines.length === 0) {
      failedChecks.push({ check: "no-lines", detail: "No invoice lines were extracted." });
    }

    let sumUnits = 0;
    let everyLineHasGross = true;

    for (const line of lines) {
      const grossUnits = parseDecimalUnits(line.rawGross, SCALE);
      if (grossUnits == null) {
        everyLineHasGross = false;
        failedChecks.push({
          check: "line-gross-missing",
          lineNumber: line.lineNumber,
          detail: "The line has no readable gross amount, so the sum over all lines is meaningless.",
        });
      } else {
        sumUnits += grossUnits;
        if (line.lineType === "deposit_return" && grossUnits >= 0) {
          failedChecks.push({
            check: "line-sign",
            lineNumber: line.lineNumber,
            detail: "A deposit credit must carry a negative amount.",
          });
        } else if (NON_NEGATIVE_TYPES.has(line.lineType) && grossUnits < 0) {
          failedChecks.push({
            check: "line-sign",
            lineNumber: line.lineNumber,
            detail: `A ${line.lineType} line must not carry a negative amount.`,
          });
        }
      }

      // A line whose quantity, unit cost or extended cost was not read cannot
      // be verified, and a template that "passes" must have verified every
      // line. The OCR drops a lone quantity digit at some resolutions; the
      // engine leaves it null rather than guess, so it is refused here.
      if (line.quantity == null || line.unitCost == null || line.extendedCost == null) {
        failedChecks.push({
          check: "line-arithmetic",
          lineNumber: line.lineNumber,
          detail: "Quantity, unit cost or extended cost was not read, so the line cannot be verified.",
        });
      } else {
        const quantity = parseDecimalUnits(line.quantity, SCALE);
        const unitCost = parseDecimalUnits(line.unitCost, SCALE);
        const extended = parseDecimalUnits(line.extendedCost, SCALE);
        if (quantity == null || unitCost == null || extended == null) {
          failedChecks.push({
            check: "line-arithmetic",
            lineNumber: line.lineNumber,
            detail: "Quantity, unit cost or extended cost is not a readable decimal.",
          });
        } else {
          // (q / 1e4) * (u / 1e4) vs e / 1e4  ->  q*u vs e*1e4, in 1e-8 units.
          const product = quantity * unitCost;
          const expected = extended * UNITS_PER_DOLLAR;
          if (!Number.isSafeInteger(product) || Math.abs(product - expected) > LINE_TOLERANCE_UNITS_E8) {
            failedChecks.push({
              check: "line-arithmetic",
              lineNumber: line.lineNumber,
              detail: "Quantity x unit cost does not equal the extended cost.",
            });
          }
        }
      }
    }

    if (everyLineHasGross && lines.length > 0) {
      sumGross = formatCents(unitsToCents(sumUnits), 2);
    }

    if (printedUnits != null && everyLineHasGross && lines.length > 0) {
      const diffUnits = sumUnits - printedUnits;
      diff = formatCents(unitsToCents(diffUnits), 2);
      if (Math.abs(diffUnits) > TOTAL_TOLERANCE_UNITS) {
        failedChecks.push({
          check: "gross-sum-mismatch",
          detail: `Sum of all line gross amounts (${sumGross}) does not match the printed total (${printedTotal}).`,
        });
      }
    }
  } catch (error) {
    failedChecks.push({
      check: "gate-internal-error",
      detail: `The gate could not run: ${error instanceof Error ? error.name : "unknown error"}.`,
    });
  }

  return { pass: failedChecks.length === 0, failedChecks, sumGross, printedTotal, diff };
}
