import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/utils";
import type { ValuationCoverage } from "@/lib/valuation-coverage";

/**
 * The role-gated value primitive (docs/design-system.md §8, CLAUDE.md
 * invariant 8).
 *
 * Renders NOTHING when `value` is undefined — not `$0.00`, not an em-dash,
 * not an empty styled box. This is a correctness rule, not a style rule:
 *
 *  - `$0.00` reads as "this bottle is worthless", which is a wrong number
 *    rather than a hidden one — the plausible-but-wrong failure this whole
 *    app exists to avoid.
 *  - `—` or a blank reserved box still tells the viewer "there is a number
 *    here you aren't allowed to see", which is a small leak of its own.
 *
 * The server omits cost fields entirely for non-owner callers (they arrive
 * `undefined`, never `0`), so this contract holds only because the prop is
 * genuinely absent. If a value is in the DOM for a staff request, that is a
 * server bug — never fix it here with `hidden` or `sr-only`.
 *
 * Callers must also branch their *layout* on presence rather than reserving a
 * blank track — see `MoneyRow` below.
 */
export function Money({
  value,
  className,
}: {
  value?: number | null;
  className?: string;
}) {
  if (value == null) return null;
  return (
    <span className={cn("text-numeral-sm tabular-nums", className)}>{formatMoney(value)}</span>
  );
}

/**
 * A dollar TOTAL together with how much of it is backed by a cost.
 *
 * `Money` is right for a per-line value; a total built from lines needs the
 * caveat or it lies by omission. With no costed line the figure is replaced by
 * a dash — `$0.00` there means "no costs on file", not "worth nothing"
 * (lib/valuation-coverage.ts, phone test DB-1). With some costed it keeps the
 * figure and prints `5 of 7 lines costed` under it in the warning colour, with
 * an icon so the state does not ride on colour alone.
 *
 * Same absence contract as `Money`: renders NOTHING when `value` is undefined.
 * The dash is only reachable for a viewer who is already entitled to the figure,
 * so it leaks nothing — the server omits `value` for everyone else, and the
 * coverage counts are quantities, not dollars (invariant 8).
 */
export function CoveredMoney({
  value,
  coverage,
  className,
  align = "end",
}: {
  value?: number | null;
  coverage: ValuationCoverage;
  className?: string;
  align?: "start" | "end";
}) {
  if (value == null) return null;
  return (
    <span className={cn("flex flex-col", align === "end" ? "items-end" : "items-start")}>
      <span className={cn("text-numeral-sm tabular-nums", className)}>
        {coverage.suppressFigure ? "—" : formatMoney(value)}
      </span>
      {coverage.label ? (
        <span className="flex items-center gap-1 text-caption font-medium text-warning">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          {coverage.label}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A quantity/value pair that collapses to a single left-aligned column when
 * the viewer cannot see the value. A staff row and an owner row are
 * legitimately different layouts for the same product, not one layout with a
 * hidden cell (design-system.md §8.2).
 */
export function MoneyRow({
  quantity,
  value,
  className,
}: {
  quantity: React.ReactNode;
  value?: number | null;
  className?: string;
}) {
  const hasValue = value != null;
  return (
    <div
      className={cn(
        hasValue ? "grid grid-cols-[1fr_auto] items-baseline gap-2" : "grid grid-cols-1",
        className,
      )}
    >
      <span className="text-numeral-sm text-card-foreground">{quantity}</span>
      <Money value={value} />
    </div>
  );
}
