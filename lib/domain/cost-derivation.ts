/**
 * Unit-cost derivation — Phase 2.5, Slice 4 (cost flow).
 * `docs/plans/phase-2.5-invoice-automation/04-slices.md`, "Slice 4 — Cost
 * Flow + Alerts": `deriveUnitCost(line) -> raw_net / qty / pack_size`.
 *
 * Pure, synchronous, no I/O — every caller (today: `lib/domain/invoice-
 * approval.ts:approveInvoice`) supplies the line fields it already has in
 * hand from a tenant-scoped read; this file never touches the database or an
 * `Actor` itself.
 *
 * ## "Never guess" — every input either fully determines the answer or the
 * answer is `null`
 *
 * Matches this codebase's standing rule (AGENTS.md's "plausible-but-wrong
 * default" section, and `db/schema.ts`'s own `invoiceLine.packSize` comment:
 * "NULL means 'not determinable,' never 1"). `deriveUnitCost` never coerces
 * a missing quantity or pack size into `1`, never treats a missing `rawNet`
 * as `0`, and never rounds a division-by-zero into anything but `null`. A
 * line this function cannot confidently price is a SKIPPED line in the
 * approval loop (`approveInvoice`'s own comment), not a plausible-looking
 * cost written to the product catalog.
 *
 * `deposit` / `deposit_return` lines always return `null`, unconditionally —
 * `db/schema.ts`'s `invoiceLineTypeEnum` comment is explicit that a keg
 * deposit or its return is real money on the invoice but must never be
 * averaged into a product's unit cost. This function does not even look at
 * the other fields on a deposit line before refusing it.
 *
 * ## Precision
 *
 * Returns a string formatted to 4 decimal places — `product.current_unit_cost`
 * and `product_cost_history.unit_cost` are both `DECIMAL(10,4)`, and this
 * file's usual convention (`lib/domain/matching.ts:computeReconfirmedConfidence`
 * is the closest precedent) is to do the arithmetic in JS `Number` and format
 * the result to the column's own scale with `toFixed`, rather than pull in a
 * decimal-arithmetic library for a single division. `quantity` and `rawNet`
 * arrive as DECIMAL-as-string (this codebase's usual convention — see
 * `db/schema.ts`'s file header) and are converted to `Number` only for this
 * one arithmetic step, never stored or returned as a JS number.
 */

import type { InvoiceLineType } from "@/lib/domain/invoice-lines";

/**
 * The subset of an `invoice_line` row `deriveUnitCost` needs. Deliberately
 * narrower than `InvoiceLineRow` (lib/domain/invoice-lines.ts) — this
 * function has no use for `description`, `exceptionFlags`, review metadata,
 * etc., and a narrow input type documents exactly what the formula depends
 * on.
 */
export interface DerivableCostLine {
  lineType: InvoiceLineType;
  /** `DECIMAL(12,3)` as a string, or `null` if extraction couldn't determine it. */
  quantity: string | null;
  /** Units per case, or `null` if not determinable from the pack description. */
  packSize: number | null;
  /** `DECIMAL(12,2)` as a string, or `null` if extraction couldn't determine it. */
  rawNet: string | null;
}

/**
 * `raw_net / qty / pack_size`, or `null` if the line is a deposit/deposit-
 * return, or any of the three inputs is missing, zero, or not a finite
 * number. Never throws.
 */
export function deriveUnitCost(line: DerivableCostLine): string | null {
  if (line.lineType === "deposit" || line.lineType === "deposit_return") {
    return null;
  }
  if (line.rawNet == null || line.quantity == null || line.packSize == null) {
    return null;
  }

  const rawNet = Number(line.rawNet);
  const quantity = Number(line.quantity);
  const packSize = line.packSize;

  // `Number("")` is 0, not NaN, so an explicit finiteness check is required
  // rather than relying on NaN propagation alone. Zero (and negative — never
  // a real quantity or pack size) are refused outright: dividing by them
  // either throws away information (division by zero -> Infinity, guarded
  // below) or produces a sign-flipped, meaningless "cost."
  if (!Number.isFinite(rawNet)) return null;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (!Number.isFinite(packSize) || packSize <= 0) return null;

  const unitCost = rawNet / quantity / packSize;
  if (!Number.isFinite(unitCost)) return null;

  return unitCost.toFixed(4);
}
