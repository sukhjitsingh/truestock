"use server";

/**
 * Report server actions — owner/manager only (spec §4: staff "cannot see
 * prices or reports"). lib/domain/reports.ts further redacts dollar figures
 * for a manager caller; see the comment at the top of that file.
 */
import { requireRole } from "@/lib/authz";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as reports from "@/lib/domain/reports";
import { getCountSchema } from "@/lib/validation/counts";

export async function countSummaryAction(
  input: unknown,
): Promise<ActionResult<reports.CountSummary>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    const parsed = getCountSchema.parse(input);
    return reports.countSummary(actor, parsed.countId);
  });
}

export async function reorderListAction(): Promise<ActionResult<reports.ReorderList>> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    return reports.reorderList(actor);
  });
}

/** Dashboard "Last closed count" tile (#14). Owner/manager only. */
export async function lastClosedCountAction(): Promise<
  ActionResult<reports.LastClosedCount | null>
> {
  return runAction(async () => {
    const actor = await requireRole("owner", "manager");
    return reports.getLastClosedCount(actor);
  });
}
