import { cn } from "@/lib/utils";

/**
 * Null-value vocabulary — docs/design-system.md §8 point 5 and §9's
 * "Null-value" spec; docs/plans/phase-2-ui-redesign/ui-spec-web.md §6.
 *
 * "No value here" is not one case. This project has four structurally
 * different reasons a value can be missing, and a single shared word or
 * style for all of them is exactly the defect the audit found (seven
 * strings doing this job, one styling choice — muted + italic + 13px — that
 * made the single most load-bearing semantic in the product the least
 * legible text on screen, P3.4).
 *
 * This component covers the three that are ever a *cell value*:
 *
 *  1. `not-applicable` — the field does not exist for this row's TYPE, by
 *     design (`case_size` on a spirit). Renders `—`. There is nothing to
 *     act on; the field will never be filled for this row.
 *  2. `not-entered` — the field should exist for this row eventually but
 *     hasn't been captured yet (an uncosted product's unit cost, a product
 *     with no par). Renders "Not entered". This is information a manager
 *     acts on — it drives the "needs attention" view — so it renders at the
 *     SAME size as the data around it, never smaller and never italic.
 *  3. `role-gated` — the viewer's role cannot see this value. Renders
 *     NOTHING: no word, no dash, no styled box. An em dash here would leak
 *     "there is a number you can't see", which is its own small leak
 *     (design-system.md §8). Prefer `Money` (components/ui/money.tsx)
 *     directly for money specifically; this case exists here so any other
 *     role-gated field (not just money) has the same contract available.
 *
 * The fourth case — "no basis exists yet to derive this at all" (no count
 * has ever closed) — is never a cell value; it is a full sentence via the
 * `EmptyState` primitive (components/ui/empty-state.tsx), not this one.
 *
 * Case 1 and case 2 are both `text-muted-foreground` but are NOT
 * interchangeable strings: a NULL `case_size` on a spirit is never "Not
 * entered" (nothing will ever be entered there), and a genuinely missing
 * unit cost is never `—` (something should exist and doesn't yet). Callers
 * must classify which case applies — this component does not guess.
 */
export type NullValueReason = "not-applicable" | "not-entered" | "role-gated";

const REASON_TEXT: Record<Exclude<NullValueReason, "role-gated">, string> = {
  "not-applicable": "—",
  "not-entered": "Not entered",
};

export function NullValue({
  reason,
  className,
}: {
  reason: NullValueReason;
  /**
   * Size override for the "not-entered" case — pass the same text-* class
   * the surrounding data uses (e.g. `text-numeral-md` in a stat tile).
   * Never pass `text-caption` for "not-entered" (P3.4's defect); the
   * default (`text-row-subtitle`) is correct for a table cell or card row.
   */
  className?: string;
}) {
  if (reason === "role-gated") return null;
  return (
    <span className={cn("text-row-subtitle text-muted-foreground", className)}>
      {REASON_TEXT[reason]}
    </span>
  );
}
