import { formatUnits, formatMoney } from "@/lib/utils";
import type { CountTotals } from "@/lib/domain/counts";

/**
 * Live progress for a count in flight (`ProgressCard`, Target 10).
 *
 * Every figure here comes from `getCountTotals`, which shares one implementation
 * with `closeCount`. `totalValue` is absent, not zero, for anyone but an owner (Invariant 8).
 */
export function ProgressCard({ totals }: { totals: CountTotals }) {
  const totalTracked = totals.pricedLineCount + totals.excludedLineCount;
  const pricedPercent = totalTracked > 0 ? Math.round((totals.pricedLineCount / totalTracked) * 100) : 0;

  return (
    <div className="glass-card p-card-pad">
      {/* 2-Column Metrics Grid */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-numeral-md font-bold text-card-foreground">{totals.lineCount}</div>
          <div className="text-caption text-muted-foreground">Lines counted</div>
        </div>
        <div>
          <div className="text-numeral-md font-bold text-card-foreground">
            {formatUnits(totals.totalUnits)}
          </div>
          <div className="text-caption text-muted-foreground">Total units</div>
        </div>
      </div>

      {/* Role-Gated Total Valuation (Owner only) */}
      {totals.totalValue != null ? (
        <div className="mt-3.5 flex items-baseline justify-between border-t border-border/80 pt-3.5">
          <span className="text-caption text-muted-foreground">Total valuation</span>
          <span className="text-numeral-md font-bold tabular-nums text-card-foreground">
            {formatMoney(totals.totalValue)}
          </span>
        </div>
      ) : null}

      {/* Visual Progress / Valuation Coverage Bar */}
      {totalTracked > 0 ? (
        <div className="mt-3.5">
          <div className="flex items-center justify-between text-caption text-muted-foreground mb-1.5">
            <span>Valuation coverage</span>
            <span className="tabular-nums">{totals.pricedLineCount} of {totalTracked} priced ({pricedPercent}%)</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${pricedPercent}%` }}
              role="progressbar"
              aria-valuenow={pricedPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
        </div>
      ) : null}

      {/* Honest Catalog Status Note */}
      {totals.excludedLineCount > 0 ? (
        <p className="mt-2.5 text-caption text-muted-foreground">
          <strong className="text-foreground">{totals.pricedLineCount} priced</strong> &middot;{" "}
          {totals.excludedLineCount} excluded from valuation (no cost or case size on file yet — normal at this stage of catalog enrollment)
        </p>
      ) : null}
    </div>
  );
}

