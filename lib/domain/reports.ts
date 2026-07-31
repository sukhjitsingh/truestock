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
import { and, desc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import { count, countLine, location, product, productPar, vendor } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import { canSeeCost } from "@/lib/authz";
import { NotFoundError } from "@/lib/domain/errors";
import { getOnHandSnapshot } from "@/lib/domain/on-hand";
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

/**
 * A category or location rollup. `value` is owner-only, mirroring the
 * per-line gate — a rollup is just a sum of the same figures, so leaving it
 * ungated would hand a manager the dollar total the line gate exists to
 * withhold (invariant 8).
 */
export interface SummaryGroup {
  key: string;
  label: string;
  lineCount: number;
  units: number;
  /** Lines in this group excluded from valuation. */
  excludedLineCount: number;
  /** Owner only. */
  value?: number;
}

/** The previous closed count this one is compared against (spec §9.1). */
export interface PreviousCountComparison {
  countId: number;
  closedAt: Date | null;
  totalUnits: number;
  unitsDelta: number;
  /** Owner only — both figures, since a delta alone would leak the total. */
  totalValue?: number;
  valueDelta?: number;
}

export interface CountSummary {
  countId: number;
  status: (typeof count.$inferSelect)["status"];
  totalUnits: number;
  pricedLineCount: number;
  /** Lines counted but excluded from valuation — no cost and/or no case size snapshot. */
  excludedLineCount: number;
  lines: CountSummaryLine[];
  byCategory: SummaryGroup[];
  byLocation: SummaryGroup[];
  /** Null when this is the first closed count, or when none precedes it. */
  previous: PreviousCountComparison | null;
  /** Owner only — matches Count.total_value once the count is closed. */
  totalValue?: number;
}

export async function countSummary(actor: Actor, countId: number): Promise<CountSummary> {
  // Tenant scoping is part of the lookup, so a count belonging to another
  // organization is indistinguishable from one that doesn't exist. That is
  // deliberate: a distinct "forbidden" answer would confirm the id is real.
  const [countRow] = await db
    .select()
    .from(count)
    .where(and(eq(count.id, countId), eq(count.organizationId, actor.organizationId)))
    .limit(1);
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
      locationName: location.name,
    })
    .from(countLine)
    .innerJoin(
      product,
      and(
        eq(product.id, countLine.productId),
        eq(product.organizationId, actor.organizationId),
      ),
    )
    // See the same join in lib/domain/counts.ts's getCount — the tenant
    // predicate belongs on the join, so a cross-tenant location can never
    // surface its name here.
    .innerJoin(
      location,
      and(
        eq(location.id, countLine.locationId),
        eq(location.organizationId, actor.organizationId),
      ),
    )
    .where(
      and(
        eq(countLine.organizationId, actor.organizationId),
        eq(countLine.countId, countId),
      ),
    );

  const showCost = canSeeCost(actor.role);
  const totals = summarizeValuation(rows.map(toValuationLine));

  // Aggregate server-side rather than letting the client do it (the reason
  // docs/open-items.md item 8 listed this): the prototype derived these in
  // the browser, which both duplicates the exclusion rules and would put an
  // ungated dollar sum in a manager's payload for the UI to hide. Value is
  // gated here, in the shape, exactly as the per-line figures are.
  const categoryGroups = new Map<string, SummaryGroup>();
  const locationGroups = new Map<string, SummaryGroup>();

  function addTo(
    groups: Map<string, SummaryGroup>,
    key: string,
    label: string,
    units: number | null,
    value: number | null,
  ): void {
    let group = groups.get(key);
    if (!group) {
      group = { key, label, lineCount: 0, units: 0, excludedLineCount: 0 };
      if (showCost) group.value = 0;
      groups.set(key, group);
    }
    group.lineCount += 1;
    group.units += units ?? 0;
    if (value == null) {
      group.excludedLineCount += 1;
    } else if (showCost) {
      group.value = Math.round(((group.value ?? 0) + value) * 100) / 100;
    }
  }

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
    addTo(categoryGroups, r.category, r.category, v.units, v.extendedValue);
    addTo(locationGroups, String(r.locationId), r.locationName, v.units, v.extendedValue);
    return line;
  });

  const byUnitsDesc = (a: SummaryGroup, b: SummaryGroup) =>
    b.units - a.units || a.label.localeCompare(b.label);

  const summary: CountSummary = {
    countId,
    status: countRow.status,
    totalUnits: totals.totalUnits,
    pricedLineCount: totals.pricedLineCount,
    excludedLineCount: totals.excludedLineCount,
    lines,
    byCategory: [...categoryGroups.values()].sort(byUnitsDesc),
    byLocation: [...locationGroups.values()].sort(byUnitsDesc),
    previous: await previousCountComparison(actor, showCost, countRow, totals),
  };
  if (showCost) {
    summary.totalValue = totals.totalValue;
  }
  return summary;
}

/**
 * "vs. previous count" (spec §9.1). Compares against the most recent count
 * closed *before this one started* — not simply the previous row by id.
 *
 * Two deliberate choices. Only closed counts are candidates, because an
 * abandoned draft is not a measurement and comparing against one would show
 * an enormous fictional drop. And the cutoff is the current count's
 * `startedAt`, not its own close time, so a count that was left open for a
 * week still compares against the state of the bar when it began rather than
 * against another count taken and closed in the middle of it.
 *
 * The previous count's figures come from its stored `total_value` snapshot
 * (invariant 2 — never re-valued from current product data), and its units
 * are recomputed from its own snapshot columns, which are immutable once
 * closed.
 */
async function previousCountComparison(
  actor: Actor,
  showCost: boolean,
  countRow: typeof count.$inferSelect,
  totals: ReturnType<typeof summarizeValuation>,
): Promise<PreviousCountComparison | null> {
  const [prev] = await db
    .select({ id: count.id, closedAt: count.closedAt, totalValue: count.totalValue })
    .from(count)
    .where(
      and(
        eq(count.organizationId, actor.organizationId),
        eq(count.status, "closed"),
        ne(count.id, countRow.id),
        lt(count.closedAt, countRow.startedAt),
      ),
    )
    .orderBy(desc(count.closedAt))
    .limit(1);

  if (!prev) {
    return null;
  }

  const prevLines = await db
    .select({
      sealedCaseQty: countLine.sealedCaseQty,
      sealedEachQty: countLine.sealedEachQty,
      partialFills: countLine.partialFills,
      unitCostAtCount: countLine.unitCostAtCount,
      caseSizeAtCount: countLine.caseSizeAtCount,
    })
    .from(countLine)
    .where(
      and(
        eq(countLine.organizationId, actor.organizationId),
        eq(countLine.countId, prev.id),
      ),
    );

  const prevTotals = summarizeValuation(prevLines.map(toValuationLine));

  const comparison: PreviousCountComparison = {
    countId: prev.id,
    closedAt: prev.closedAt,
    totalUnits: prevTotals.totalUnits,
    unitsDelta: Math.round((totals.totalUnits - prevTotals.totalUnits) * 100) / 100,
  };

  if (showCost) {
    // The stored snapshot is the authority for a closed count's value
    // (invariant 2). Falling back to the recomputed figure only covers a
    // count closed before total_value was ever written.
    const prevValue = prev.totalValue == null ? prevTotals.totalValue : Number(prev.totalValue);
    comparison.totalValue = prevValue;
    comparison.valueDelta = Math.round((totals.totalValue - prevValue) * 100) / 100;
  }

  return comparison;
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
  /**
   * How many active products have an overall par at all.
   *
   * Reported because zero items means two completely different things and the
   * screen cannot otherwise tell them apart: "everything is well stocked" and
   * "no product has a par, so this list is structurally incapable of ever
   * showing a row". The second read as the first for as long as par levels
   * were unwritable — a finished-looking screen confidently reporting that
   * all is well.
   */
  productsWithPar: number;
}

export async function reorderList(actor: Actor): Promise<ReorderList> {
  // On-hand comes from the shared snapshot in lib/domain/on-hand.ts, which
  // the back-office catalog's stock cell also reads. Two screens showing two
  // different on-hand numbers for the same bottle is the kind of quiet
  // disagreement this codebase spends most of its comments avoiding.
  const { asOfCountId, byProduct: onHandByProduct } = await getOnHandSnapshot(
    actor.organizationId,
  );

  if (asOfCountId == null) {
    return { asOfCountId: null, items: [], productsWithPar: 0 };
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
    .where(
      and(
        eq(productPar.organizationId, actor.organizationId),
        eq(product.active, true),
        isNull(productPar.locationId),
      ),
    );

  if (parRows.length === 0) {
    return { asOfCountId, items: [], productsWithPar: 0 };
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
    .where(
      and(eq(product.organizationId, actor.organizationId), inArray(product.id, productIds)),
    );
  const productById = new Map(products.map((p) => [p.id, p]));

  const vendors = await db
    .select({ id: vendor.id, name: vendor.name })
    .from(vendor)
    .where(eq(vendor.organizationId, actor.organizationId));
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

  return { asOfCountId, items, productsWithPar: parRows.length };
}
