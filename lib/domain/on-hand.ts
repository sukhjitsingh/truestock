/**
 * On-hand quantities derived from the most recently *closed* count.
 *
 * This exists because two callers need the identical figure and must not
 * compute it two different ways: `reorderList()` (spec §9.3) compares on-hand
 * against par, and the back-office catalog table shows a stock cell with a
 * par-relative bar. `docs/open-items.md` item 8 flagged exactly this — the
 * catalog read needed the same join reorderList already performed, and the
 * wrong fix would have been to reimplement it beside it.
 *
 * Why the latest *closed* count and not the latest count: an in-progress
 * count is a partial picture by definition — half the bar is not yet walked,
 * so every unvisited product reads as zero. Reordering against that would
 * order the entire catalog. Closed counts are also immutable (invariant 1),
 * so this figure is stable rather than shifting under a reader mid-count.
 *
 * The known limitation, carried deliberately: a line whose units are
 * indeterminate (sealed cases counted with no `case_size_at_count` snapshot —
 * see lib/domain/valuation.ts) contributes 0 rather than a guess. That can
 * understate on-hand and suggest an avoidable reorder, which is the safer
 * direction to be wrong in for a beverage program than silently overstating
 * stock. Callers that display on-hand should surface `indeterminateProductIds`
 * so a zero that means "unknown" is distinguishable from a zero that means
 * "none left" — the whole point of the nullable snapshot columns.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { count, countLine } from "@/db/schema";
import { computeLineUnits } from "@/lib/domain/valuation";

export interface OnHandSnapshot {
  /** The closed count these figures come from; null when none exist yet. */
  asOfCountId: number | null;
  asOfClosedAt: Date | null;
  /** product_id -> units on hand, summed across every location. */
  byProduct: Map<number, number>;
  /**
   * Products whose on-hand figure is incomplete because at least one of
   * their lines had indeterminate units. Their entry in `byProduct` is a
   * floor, not a total.
   */
  indeterminateProductIds: Set<number>;
}

const EMPTY: OnHandSnapshot = {
  asOfCountId: null,
  asOfClosedAt: null,
  byProduct: new Map(),
  indeterminateProductIds: new Set(),
};

export async function getOnHandSnapshot(organizationId: number): Promise<OnHandSnapshot> {
  const [latestClosed] = await db
    .select({ id: count.id, closedAt: count.closedAt })
    .from(count)
    .where(and(eq(count.organizationId, organizationId), eq(count.status, "closed")))
    .orderBy(desc(count.closedAt))
    .limit(1);

  if (!latestClosed) {
    // A fresh install with no closed count yet: every caller must treat this
    // as "unknown", never as "everything is at zero". `asOfCountId: null` is
    // the signal to do that — reorderList returns no items rather than
    // proposing an order for the entire catalog.
    return { ...EMPTY, byProduct: new Map(), indeterminateProductIds: new Set() };
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
    // Redundant with the count filter above (the count was already resolved
    // within this organization), and kept anyway: count_line carries its own
    // organization_id held true by a composite foreign key, so filtering on
    // it directly costs nothing and means this query is tenant-safe when read
    // in isolation rather than only in context.
    .where(
      and(
        eq(countLine.organizationId, organizationId),
        eq(countLine.countId, latestClosed.id),
      ),
    );

  const byProduct = new Map<number, number>();
  const indeterminateProductIds = new Set<number>();

  for (const line of lines) {
    const { units } = computeLineUnits(line);
    if (units == null) {
      indeterminateProductIds.add(line.productId);
    }
    byProduct.set(line.productId, (byProduct.get(line.productId) ?? 0) + (units ?? 0));
  }

  return {
    asOfCountId: latestClosed.id,
    asOfClosedAt: latestClosed.closedAt,
    byProduct,
    indeterminateProductIds,
  };
}
