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

import type { InvoiceLineType, InvoiceLineUom } from "@/lib/domain/invoice-lines";

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
 *
 * A net of exactly 0 (free goods) or below 0 (a credit) also means "no cost":
 * neither is a price the supplier charged for the product, so neither may
 * become `current_unit_cost`. Owner decision, 2026-11-06 QA run (F5). A blank
 * net is covered too, because `Number("")` is 0. Note these lines are still
 * skipped silently by the approval loop; reporting them is F1.
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
  // a real quantity or pack size) are refused outright, and a zero or negative
  // net (free goods, a credit) the same way: dividing by them
  // either throws away information (division by zero -> Infinity, guarded
  // below) or produces a sign-flipped, meaningless "cost."
  if (!Number.isFinite(rawNet) || rawNet <= 0) return null;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (!Number.isFinite(packSize) || packSize <= 0) return null;

  const unitCost = rawNet / quantity / packSize;
  if (!Number.isFinite(unitCost)) return null;

  return unitCost.toFixed(4);
}

/** Largest units-per-case a reviewer may enter. Shared by the Zod schema and the domain check. */
export const MAX_PACK_SIZE = 9999;

/** Whole number 1..MAX_PACK_SIZE. Zero, negative, decimal, NaN and over-range are all refused. */
export function isValidPackSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PACK_SIZE;
}

/** Why a line does not post a cost. First match wins, in this order. */
export type PostingSkipReason =
  | "not_product_line"
  | "not_matched"
  | "no_net"
  | "free_goods"
  | "credit"
  | "no_quantity"
  | "no_units_per_case";

export interface PostingCandidateLine extends DerivableCostLine {
  uom: InvoiceLineUom | null;
  matchedProductId: number | null;
}

export type LinePosting =
  | { posts: true; unitCost: string; packSizeUsed: number }
  | { posts: false; reason: PostingSkipReason };

/** `each` and `keg` give 1 and ignore any parsed pack size. Anything else gives line.packSize, which may be null. */
export function effectivePackSize(line: Pick<PostingCandidateLine, "uom" | "packSize">): number | null {
  if (line.uom === "each" || line.uom === "keg") return 1;
  return line.packSize;
}

/**
 * Whether a line would post a cost, and why not if it would not. First match
 * wins, in the order of `PostingSkipReason`. Reuses `deriveUnitCost` for the
 * arithmetic; never reads product.case_size.
 */
export function classifyLineForPosting(line: PostingCandidateLine): LinePosting {
  if (line.lineType !== "product") return { posts: false, reason: "not_product_line" };
  if (line.matchedProductId == null) return { posts: false, reason: "not_matched" };

  const netText = line.rawNet == null ? "" : line.rawNet.trim();
  const net = netText === "" ? Number.NaN : Number(netText);
  if (!Number.isFinite(net)) return { posts: false, reason: "no_net" };
  if (net === 0) return { posts: false, reason: "free_goods" };
  if (net < 0) return { posts: false, reason: "credit" };

  const qtyText = line.quantity == null ? "" : line.quantity.trim();
  const qty = qtyText === "" ? Number.NaN : Number(qtyText);
  if (!Number.isFinite(qty) || qty <= 0) return { posts: false, reason: "no_quantity" };

  const pack = effectivePackSize(line);
  if (pack == null || !Number.isFinite(pack) || pack <= 0) {
    return { posts: false, reason: "no_units_per_case" };
  }

  const unitCost = deriveUnitCost({ ...line, packSize: pack });
  // Unreachable for finite positive inputs short of overflow; refuse rather than guess.
  if (unitCost == null) return { posts: false, reason: "no_net" };
  return { posts: true, unitCost, packSizeUsed: pack };
}
