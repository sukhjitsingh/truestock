/**
 * Reports (spec §9): Count Summary with valuation, and the Reorder List.
 * Both are owner/manager only — spec §4's role table says staff "cannot see
 * prices or reports" at all, so these are gated at the action layer with
 * `requireRole("owner", "manager")` before any of this runs (defence in
 * depth: even if that gate were ever missed, the manager-shaped response
 * here still never includes a dollar figure — see below).
 *
 * CLAUDE.md invariant 8 inside a report specifically: a manager can review
 * counts and reorder needs, so they get real *quantities* (units counted,
 * how many lines are missing a price), but never a dollar total, per-line
 * cost, or extended value. Only `owner` gets those. This is decided in the
 * query/response shape here, not left to the UI to hide.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { count, countLine, product, productPar, vendor } from "@/db/schema";
import type { Role } from "@/lib/authz";
import { canSeeCost } from "@/lib/authz";
import { NotFoundError } from "@/lib/domain/errors";
import { computeLineValuation, summarizeValuation, type ValuationLine } from "@/lib/domain/valuation";

// Accepts any select result that carries at least these columns — every
// query in this file selects a different superset (joined with product,
// grouped, etc.), so this is intentionally structural rather than pinned to
// `typeof countLine.$inferSelect`.
function toValuationLine(row: ValuationLine): ValuationLine {
  return {
    sealedCaseQty: row.sealedCaseQty,
    sealedEachQty: row.sealedEachQty,
    partialFills: row.partialFills,
    unitCostAtCount: row.unitCostAtCount,
    caseSizeAtCount: row.caseSizeAtCount,
  };
}

// ---------------------------------------------------------------------------
// Count summary
// ---------------------------------------------------------------------------

export interface CountSummaryLine {
  productId: number;
  productName: string;
  category: string;
  locationId: number;
  units: number;
  /** Owner only. */
  extendedValue?: number;
}

export interface CountSummary {
  countId: number;
  status: (typeof count.$inferSelect)["status"];
  totalUnits: number;
  pricedLineCount: number;
  /** Lines counted but excluded from valuation — no cost and/or no case size snapshot. */
  excludedLineCount: number;
  lines: CountSummaryLine[];
  /** Owner only — matches Count.total_value once the count is closed. */
  totalValue?: number;
}

export async function countSummary(role: Role, countId: number): Promise<CountSummary> {
  const [countRow] = await db.select().from(count).where(eq(count.id, countId)).limit(1);
  if (!countRow) {
    throw new NotFoundError("Count");
  }

  const rows = await db
    .select({
      productId: countLine.productId,
      locationId: countLine.locationId,
      sealedCaseQty: countLine.sealedCaseQty,
      sealedEachQty: countLine.sealedEachQty,
      partialFills: countLine.partialFills,
      unitCostAtCount: countLine.unitCostAtCount,
      caseSizeAtCount: countLine.caseSizeAtCount,
      productName: product.name,
      category: product.category,
    })
    .from(countLine)
    .innerJoin(product, eq(product.id, countLine.productId))
    .where(eq(countLine.countId, countId));

  const showCost = canSeeCost(role);
  const totals = summarizeValuation(rows.map(toValuationLine));

  const lines: CountSummaryLine[] = rows.map((r) => {
    const v = computeLineValuation(toValuationLine(r));
    const line: CountSummaryLine = {
      productId: r.productId,
      productName: r.productName,
      category: r.category,
      locationId: r.locationId,
      units: v.units ?? 0,
    };
    if (showCost) {
      line.extendedValue = v.extendedValue ?? undefined;
    }
    return line;
  });

  const summary: CountSummary = {
    countId,
    status: countRow.status,
    totalUnits: totals.totalUnits,
    pricedLineCount: totals.pricedLineCount,
    excludedLineCount: totals.excludedLineCount,
    lines,
  };
  if (showCost) {
    summary.totalValue = totals.totalValue;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Reorder list (spec §9.3): on-hand (from the most recently *closed* count)
// vs. par/reorder point, grouped by vendor. No cost data involved at all —
// par levels and quantities are the only inputs — so there is nothing to
// gate by role beyond the action-layer owner/manager check.
// ---------------------------------------------------------------------------

export interface ReorderItem {
  productId: number;
  productName: string;
  category: string;
  onHand: number;
  parLevel: number;
  reorderPoint: number | null;
  suggestedOrderQty: number;
  vendorId: number | null;
  vendorName: string | null;
}

export interface ReorderList {
  /** The closed count on-hand figures are computed from; null if none exist yet. */
  asOfCountId: number | null;
  items: ReorderItem[];
}

export async function reorderList(): Promise<ReorderList> {
  const [latestClosed] = await db
    .select({ id: count.id })
    .from(count)
    .where(eq(count.status, "closed"))
    .orderBy(desc(count.closedAt))
    .limit(1);

  if (!latestClosed) {
    return { asOfCountId: null, items: [] };
  }

  const lines = await db
    .select({
      productId: countLine.productId,
      sealedCaseQty: countLine.sealedCaseQty,
      sealedEachQty: countLine.sealedEachQty,
      partialFills: countLine.partialFills,
      unitCostAtCount: countLine.unitCostAtCount,
      caseSizeAtCount: countLine.caseSizeAtCount,
    })
    .from(countLine)
    .where(eq(countLine.countId, latestClosed.id));

  // Sum on-hand units per product across all locations. A line whose units
  // are indeterminate (sealed cases counted but no case_size snapshot —
  // see lib/domain/valuation.ts) contributes 0 rather than being guessed —
  // documented limitation: this can understate on-hand and trigger an
  // avoidable reorder suggestion, which is the safer direction to be wrong
  // in for a beverage program versus silently overstating stock.
  const onHandByProduct = new Map<number, number>();
  for (const line of lines) {
    const v = computeLineValuation(toValuationLine(line));
    const prev = onHandByProduct.get(line.productId) ?? 0;
    onHandByProduct.set(line.productId, prev + (v.units ?? 0));
  }

  // MVP only ever writes overall par rows (location_id IS NULL) — spec §8.
  const parRows = await db
    .select({
      productId: productPar.productId,
      parLevel: productPar.parLevel,
      reorderPoint: productPar.reorderPoint,
    })
    .from(productPar)
    .innerJoin(product, eq(product.id, productPar.productId))
    .where(and(eq(product.active, true), isNull(productPar.locationId)));

  if (parRows.length === 0) {
    return { asOfCountId: latestClosed.id, items: [] };
  }

  const productIds = parRows.map((p) => p.productId);
  const products = await db
    .select({
      id: product.id,
      name: product.name,
      category: product.category,
      vendorId: product.vendorId,
    })
    .from(product)
    .where(inArray(product.id, productIds));
  const productById = new Map(products.map((p) => [p.id, p]));

  const vendors = await db.select({ id: vendor.id, name: vendor.name }).from(vendor);
  const vendorById = new Map(vendors.map((v) => [v.id, v.name]));

  const items: ReorderItem[] = [];
  for (const par of parRows) {
    const p = productById.get(par.productId);
    if (!p) continue;

    const onHand = onHandByProduct.get(par.productId) ?? 0;
    const parLevel = Number(par.parLevel);
    const reorderPoint = par.reorderPoint == null ? null : Number(par.reorderPoint);
    const threshold = reorderPoint ?? parLevel;

    if (onHand > threshold) continue;

    const suggestedOrderQty = Math.max(parLevel - onHand, 0);
    items.push({
      productId: p.id,
      productName: p.name,
      category: p.category,
      onHand,
      parLevel,
      reorderPoint,
      suggestedOrderQty,
      vendorId: p.vendorId,
      vendorName: p.vendorId != null ? (vendorById.get(p.vendorId) ?? null) : null,
    });
  }

  // Group by vendor for display (spec §9.3: "grouped by vendor") — sort so
  // items with the same vendor are adjacent; the action layer / frontend can
  // bucket this list by `vendorId` directly.
  items.sort((a, b) => {
    const av = a.vendorName ?? "";
    const bv = b.vendorName ?? "";
    if (av !== bv) return av.localeCompare(bv);
    return a.productName.localeCompare(b.productName);
  });

  return { asOfCountId: latestClosed.id, items };
}
