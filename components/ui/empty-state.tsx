import { cn } from "@/lib/utils";

/**
 * Empty state — docs/plans/phase-2-ui-redesign/ui-spec-web.md §13
 * ("Component names this spec adds") and its own "Empty state" subsection;
 * docs/design-system.md §9.
 *
 * One pattern, reused everywhere a table or a derived figure has nothing to
 * show — a table's empty `<tbody>`, and the §8-point-5 / §6 "no basis exists
 * yet" null-value case (`asOfCountId === null`: no count has ever closed, so
 * on-hand/valuation isn't a cell value at all, it's a full sentence here).
 *
 * `py-section-gap` (24px) — not 64px, which is disproportionate to every
 * other spacing value in the system (a real defect one prototype shipped).
 * `message` must be a short sentence stating WHY, not just "no results";
 * `action` renders a primary action where one genuinely exists ("Start a
 * count", "Add a location", "Set a par level").
 *
 * `action` takes a full node rather than a label+href/onClick pair on
 * purpose — this primitive doesn't know whether the caller needs a
 * `<button>` (an in-place action) or a `next/link` `<Link>` (navigation),
 * and guessing wrong would violate the "explicit control, never an implicit
 * one" rule this whole redesign is built around. `EmptyStateAction` below is
 * the matching plain-button styling for callers that just need a `<button>`.
 */
export function EmptyState({
  message,
  action,
  className,
}: {
  message: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2 py-section-gap text-center", className)}>
      <p className="text-row-subtitle text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}

/**
 * The literal class string from the spec's empty-state action button, for
 * callers whose action is an in-place `<button>` rather than navigation.
 * A `Link`-based action composes its own element with this same class
 * string rather than using this component.
 */
export function EmptyStateAction({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "mt-2 inline-flex h-9 items-center rounded-md bg-primary px-4 text-label uppercase text-primary-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
