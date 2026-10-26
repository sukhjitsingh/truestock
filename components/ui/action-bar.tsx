import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/utils";
import type { ValuationCoverage } from "@/lib/valuation-coverage";

/**
 * Fixed bottom action bar — docs/design-system.md §9.
 *
 * Content sitting above it must reserve room; use `pb-action-bar` on the
 * scrolling region (see the layouts) rather than letting the bar cover the
 * last row.
 */
export function ActionBar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 flex gap-3 border-t border-border bg-background p-bar-pad",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The primary action button with an optional value line.
 *
 * Two lines (`CLOSE COUNT` / `$5,820.00`) only when the viewer can see cost;
 * otherwise ONE centered line — never a two-line button with a blank second
 * line, which would advertise a number the viewer isn't permitted to see
 * (design-system.md §8.3). The branch is on the layout, not on visibility.
 *
 * `coverage` caveats the figure when not every line is backed by a cost. A bare
 * `$0.00` on the irreversible Close control reads as "this count is worth
 * nothing" when it means "no costs on file yet" — so with no costed line the
 * figure is replaced by the caveat, and with some it gains a third line
 * (`5 of 7 lines costed`). The warning is an icon plus words, not colour alone:
 * the button's background is the primary colour, where warning-coloured text
 * would not hold contrast in both themes.
 */
export function ActionBarPrimary({
  label,
  value,
  coverage,
  className,
  ...props
}: {
  label: string;
  value?: number | null;
  coverage?: ValuationCoverage;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const hasValue = value != null;
  const showFigure = hasValue && !coverage?.suppressFigure;
  const note = hasValue ? (coverage?.label ?? null) : null;
  return (
    <button
      type="button"
      className={cn(
        "min-h-tap-primary flex-1 rounded-md bg-primary text-primary-foreground disabled:opacity-50",
        hasValue
          ? "flex flex-col items-center justify-center gap-0.5 py-2"
          : "flex items-center justify-center",
        className,
      )}
      {...props}
    >
      <span className="text-label uppercase">{label}</span>
      {showFigure ? (
        <span className="text-numeral-sm tabular-nums">{formatMoney(value)}</span>
      ) : null}
      {note ? (
        <span
          className={cn(
            "flex items-center gap-1",
            showFigure ? "text-label" : "text-caption font-semibold",
          )}
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          {note}
        </span>
      ) : null}
    </button>
  );
}
