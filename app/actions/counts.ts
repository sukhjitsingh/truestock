"use server";

/**
 * Count server actions. Every export checks session + role itself
 * (CLAUDE.md invariant 7) via lib/authz.ts. All count-line write paths run
 * through lib/domain/counts.ts, which owns invariants 1 (closed counts are
 * immutable), 2 (cost/case-size snapshot), 3/5 (increment + idempotency via
 * the `count_line_write` ledger).
 *
 * READ THIS BEFORE WIRING UP A CLIENT (frontend agent, this means you):
 * every action below that takes a `clientLineId` needs a FRESH UUID PER
 * WRITE ATTEMPT — one per scan, one per typed-quantity submission, one per
 * correction — never one UUID generated once per count line and reused
 * across every write to it. Reusing one id across multiple real writes to
 * the same line makes every write after the first look like a retry of the
 * first, and it will be silently dropped as a no-op — a real second scan
 * that never gets counted. See the doc comment at the top of
 * lib/validation/counts.ts for the full explanation. The one exception is
 * an actual retry: resending the exact same write (e.g. from an IndexedDB
 * queue after a dropped connection) MUST reuse that write's original id —
 * that's what makes the resend safe rather than a duplicate.
 */
import { requireRole } from "@/lib/authz";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as counts from "@/lib/domain/counts";
import {
  openCountSchema,
  incrementCountLineSchema,
  scanCountLineSchema,
  editCountLineFillsSchema,
  setCountLineQuantitiesSchema,
  submitCountSchema,
  reviewCountSchema,
  closeCountSchema,
  getCountSchema,
  getCountTotalsSchema,
  listCountsSchema,
} from "@/lib/validation/counts";

/** Any counting role may open a count (spec §4 — all three roles count). */
export async function openCountAction(
  input: unknown,
): Promise<ActionResult<counts.CountSummaryRow>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    const parsed = openCountSchema.parse(input);
    return counts.openCount(actor, parsed);
  });
}

/**
 * Manual quantity entry (e.g. sealed backstock: "type 3 cases"). Increments
 * the existing line for this (count, product, location) or creates it —
 * never a second row (invariant 3). Idempotent on `clientLineId` via the
 * `count_line_write` ledger (invariant 5) — see lib/domain/counts.ts for
 * exactly how. `input.clientLineId` MUST be a fresh UUID for this specific
 * write — see the file-level comment above.
 */
export async function incrementCountLineAction(
  input: unknown,
): Promise<ActionResult<counts.CountLineRow>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    const parsed = incrementCountLineSchema.parse(input);
    return counts.incrementCountLine(actor, parsed);
  });
}

/**
 * The core scan loop: scan barcode -> resolve product server-side -> apply
 * the scanned quantity to the correct bucket (case vs. each) for this
 * (count, location). This is the primary write path during a live count.
 * `input.clientLineId` MUST be a fresh UUID for THIS scan — scanning the
 * same bottle five times means five different ids, one per scan, not one
 * id shared across all five (see the file-level comment above).
 */
export async function scanCountLineAction(
  input: unknown,
): Promise<ActionResult<counts.CountLineRow>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    const parsed = scanCountLineSchema.parse(input);
    return counts.scanCountLine(actor, parsed);
  });
}

/** Correct a previously recorded open-bottle fill reading. Not a scan/increment. */
export async function editCountLineFillsAction(
  input: unknown,
): Promise<ActionResult<counts.CountLineRow>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    const parsed = editCountLineFillsSchema.parse(input);
    return counts.editCountLineFills(actor, parsed);
  });
}

/**
 * Correct `sealed_case_qty`/`sealed_each_qty` to an absolute value — e.g. a
 * manager who typed 5 cases instead of 3 during a live count. The scan/
 * increment path is additive-only and has no way to walk a quantity back
 * down. Same closed-count guard and lock ordering as every other count-line
 * write, and still records a `count_line_write` ledger entry (see
 * lib/domain/counts.ts's `setCountLineQuantities` for how a SET is
 * represented as a delta there). `input.clientLineId` MUST be a fresh UUID
 * for this specific correction (see the file-level comment above).
 */
export async function setCountLineQuantitiesAction(
  input: unknown,
): Promise<ActionResult<counts.CountLineRow>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    const parsed = setCountLineQuantitiesSchema.parse(input);
    return counts.setCountLineQuantities(actor, parsed);
  });
}

/** Whoever counted marks it done. Any counting role. */
export async function submitCountAction(
  input: unknown,
): Promise<ActionResult<counts.CountSummaryRow>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    const parsed = submitCountSchema.parse(input);
    return counts.submitCount(actor, parsed.countId);
  });
}

/** Supervisory step before closing — owner/manager only. */
export async function reviewCountAction(
  input: unknown,
): Promise<ActionResult<counts.CountSummaryRow>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = reviewCountSchema.parse(input);
    return counts.reviewCount(actor, parsed.countId);
  });
}

/**
 * Locks the count (invariant 1: nothing can write to it after this).
 * Owner/manager only. The response is deliberately role-shaped: a manager
 * gets confirmation + unit/unpriced-line counts, never the dollar total —
 * CLAUDE.md invariant 8 — even though the true total is always computed and
 * stored on `count.total_value` regardless of who closed it.
 */
export async function closeCountAction(input: unknown): Promise<
  ActionResult<{
    count: counts.CountSummaryRow;
    totalUnits: number;
    pricedLineCount: number;
    excludedLineCount: number;
    totalValue?: number;
  }>
> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = closeCountSchema.parse(input);
    const { count: closedCount, totals } = await counts.closeCount(actor, parsed.countId);
    return {
      count: closedCount,
      totalUnits: totals.totalUnits,
      pricedLineCount: totals.pricedLineCount,
      excludedLineCount: totals.excludedLineCount,
      ...(actor.role === "owner" ? { totalValue: totals.totalValue } : {}),
    };
  });
}

/**
 * Read a count with its lines. Any counting role (staff needs to see
 * progress on the count they're working). Cost/value fields are omitted
 * from each line for non-owner callers by lib/domain/counts.ts itself.
 */
export async function getCountAction(
  input: unknown,
): Promise<ActionResult<counts.CountDetail>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    const parsed = getCountSchema.parse(input);
    return counts.getCount(actor, parsed.countId);
  });
}

/**
 * Live progress totals for a count in flight — what the count-session screen
 * prints on the CLOSE COUNT button. Shares one implementation with
 * `closeCount` (lib/domain/counts.ts) so the displayed figure and the figure
 * written to the immutable record cannot disagree. `totalValue` is owner-only
 * here exactly as it is there (invariant 8).
 */
export async function getCountTotalsAction(
  input: unknown,
): Promise<ActionResult<counts.CountTotals>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    const parsed = getCountTotalsSchema.parse(input);
    return counts.getCountTotals(actor, parsed.countId);
  });
}

/**
 * The counting app's entry point: the count currently in flight, or null.
 * All three roles — this is how a staff member joins the count in progress
 * without a back-office list they aren't entitled to (see the domain
 * function for the full reasoning).
 */
export async function getActiveCountAction(): Promise<
  ActionResult<counts.CountSummaryRow | null>
> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager", "staff");
    return counts.getActiveCount(actor);
  });
}

/**
 * The back-office counts list. Owner/manager only — staff is count-only and
 * has no back-office surface (spec §4); a staff member works the count they
 * were handed, not a history of every count taken.
 */
export async function listCountsAction(
  input: unknown = {},
): Promise<ActionResult<counts.CountListRow[]>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = listCountsSchema.parse(input);
    return counts.listCounts(actor, parsed.limit);
  });
}
