import { formatUnits, formatMoney } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import type { CountTotals } from "@/lib/domain/counts";

/**
 * Live progress for a count in flight. Every figure here comes from
 * `getCountTotals`, which shares one implementation with `closeCount` — so
 * the number shown here and the number written to the immutable record
 * cannot disagree (docs/open-items.md item 8).
 *
 * `totalValue` is absent, not zero, for anyone but an owner. The whole
 * value row is therefore omitted rather than rendered blank.
 */
export function ProgressCard({ totals }: { totals: CountTotals }) {
  return (
    <Card>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-numeral-md text-card-foreground">{totals.lineCount}</div>
          <div className="text-caption text-muted-foreground">Lines counted</div>
        </div>
        <div>
          <div className="text-numeral-md text-card-foreground">
            {formatUnits(totals.totalUnits)}
          </div>
          <div className="text-caption text-muted-foreground">Total units</div>
        </div>
      </div>

      {totals.totalValue != null ? (
        <div className="mt-3.5 flex items-baseline justify-between border-t border-border pt-3.5">
          <span className="text-caption text-muted-foreground">Total value</span>
          <span className="text-numeral-md tabular-nums text-card-foreground">
            {formatMoney(totals.totalValue)}
          </span>
        </div>
      ) : null}

      {/*
        Unpriced lines are stated plainly, as an ordinary fact rather than an
        error. Most of the catalog has no cost yet (only the 9 draft kegs do),
        so on a real count today this number will be large — and a warning
        tone on something that is both expected and not the counter's fault
        trains people to ignore warnings.
      */}
      {totals.excludedLineCount > 0 ? (
        <p className="mt-2 text-caption text-muted-foreground">
          {totals.pricedLineCount} priced &middot; {totals.excludedLineCount} excluded from
          valuation (no cost or case size on file yet — normal at this stage of the catalog)
        </p>
      ) : null}
    </Card>
  );
}
