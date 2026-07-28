import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/utils";

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
 */
export function ActionBarPrimary({
  label,
  value,
  className,
  ...props
}: {
  label: string;
  value?: number | null;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const hasValue = value != null;
  return (
    <button
      type="button"
      className={cn(
        "min-h-tap-primary flex-1 rounded-md bg-primary text-primary-foreground disabled:opacity-50",
        hasValue
          ? "flex flex-col items-center justify-center gap-0.5"
          : "flex items-center justify-center",
        className,
      )}
      {...props}
    >
      <span className="text-label uppercase">{label}</span>
      {hasValue ? (
        <span className="text-numeral-sm tabular-nums">{formatMoney(value)}</span>
      ) : null}
    </button>
  );
}
