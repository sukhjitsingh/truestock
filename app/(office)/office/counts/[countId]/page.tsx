import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOfficeUser } from "@/lib/current-user";
import { countSummaryAction } from "@/app/actions/reports";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { StatusPill, countStatusTone, countStatusLabel } from "@/components/ui/status-pill";
import { formatUnits, formatDate } from "@/lib/utils";
import type { SummaryGroup } from "@/lib/domain/reports";

export const metadata = { title: "Count summary · Truestock" };

/**
 * Count Summary (spec §9.1): totals, category and location rollups, and the
 * comparison against the previous count.
 *
 * Every aggregate here is computed server-side. The prototype derived them in
 * the browser, which both duplicates the valuation exclusion rules and would
 * put an ungated dollar sum into a manager's payload for the UI to hide.
 */
export default async function CountSummaryPage({
  params,
}: {
  params: Promise<{ countId: string }>;
}) {
  await requireOfficeUser();
  const countId = Number((await params).countId);
  if (!Number.isInteger(countId) || countId <= 0) notFound();

  const result = await countSummaryAction({ countId });
  if (!result.ok) notFound();
  const summary = result.data;

  return (
    <div>
      <Link href="/office" className="text-caption text-muted-foreground underline">
        ← All counts
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-header-title">Count #{summary.countId}</h1>
        <StatusPill tone={countStatusTone(summary.status)}>
          {countStatusLabel(summary.status)}
        </StatusPill>
      </div>

      {/* Two tiles for a manager, three for an owner — the grid follows the
          role rather than leaving an empty cell where a value would be. */}
      <div
        className={`mt-6 grid gap-card-gap ${
          summary.totalValue != null ? "sm:grid-cols-3" : "sm:grid-cols-2"
        }`}
      >
        <Stat label="Lines" value={String(summary.lines.length)} />
        <Stat label="Total units" value={formatUnits(summary.totalUnits)} />
        {summary.totalValue != null ? (
          <Stat label="Total value" value={<Money value={summary.totalValue} className="text-numeral-md" />} />
        ) : null}
      </div>

      {summary.excludedLineCount > 0 ? (
        <p className="mt-3 text-caption text-muted-foreground">
          {summary.pricedLineCount} priced &middot; {summary.excludedLineCount} excluded from
          valuation — no cost or case size on file. Excluded lines are left out of the total
          rather than counted as free.
        </p>
      ) : null}

      {summary.previous ? (
        <Card className="mt-6">
          <p className="text-label uppercase text-muted-foreground">
            vs. count #{summary.previous.countId}
            {summary.previous.closedAt ? ` (closed ${formatDate(summary.previous.closedAt)})` : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-8">
            <Delta
              label="Units"
              current={formatUnits(summary.totalUnits)}
              previous={formatUnits(summary.previous.totalUnits)}
              delta={summary.previous.unitsDelta}
              format={formatUnits}
            />
            {/*
              All three of these are gated by the same `showCost` boolean in
              lib/domain/reports.ts, so they are present together or absent
              together. Checking all three rather than rendering a fallback
              for a missing one keeps design-system.md §8 intact: there is no
              branch here that can print a placeholder where a hidden value
              would have gone.
            */}
            {summary.totalValue != null &&
            summary.previous.totalValue != null &&
            summary.previous.valueDelta != null ? (
              <Delta
                label="Value"
                current={`$${summary.totalValue.toFixed(2)}`}
                previous={`$${summary.previous.totalValue.toFixed(2)}`}
                delta={summary.previous.valueDelta}
                format={(n) => `$${n.toFixed(2)}`}
              />
            ) : null}
          </div>
        </Card>
      ) : null}

      <div className="mt-8 grid gap-section-gap lg:grid-cols-2">
        <Rollup title="By category" groups={summary.byCategory} />
        <Rollup title="By location" groups={summary.byLocation} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card>
      <p className="text-label uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-numeral-md text-card-foreground">{value}</p>
    </Card>
  );
}

function Delta({
  label,
  current,
  previous,
  delta,
  format,
}: {
  label: string;
  current: string;
  previous: string;
  delta: number;
  format: (n: number) => string;
}) {
  // No color on the direction. Inventory going down between counts is normal
  // (it was sold); going up is normal (a delivery landed). Painting one green
  // and the other red would assert a judgement the data doesn't support —
  // and green/red are status tokens, not sentiment (design-system.md §3).
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  return (
    <div>
      <p className="text-label uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-numeral-sm tabular-nums text-foreground">
        {previous} → {current}
      </p>
      <p className="text-caption tabular-nums text-muted-foreground">
        {sign}
        {format(Math.abs(delta))}
      </p>
    </div>
  );
}

function Rollup({ title, groups }: { title: string; groups: SummaryGroup[] }) {
  return (
    <section>
      <h2 className="mb-3 text-label uppercase text-muted-foreground">{title}</h2>
      {groups.length === 0 ? (
        <p className="text-row-subtitle text-muted-foreground">Nothing counted.</p>
      ) : (
        <table className="w-full border-collapse text-left">
          <tbody>
            {groups.map((group) => (
              <tr key={group.key} className="border-b border-border">
                <td className="py-2 text-row-subtitle text-foreground">{group.label}</td>
                <td className="py-2 text-right text-row-subtitle tabular-nums text-muted-foreground">
                  {formatUnits(group.units)} units
                  {group.excludedLineCount > 0 ? (
                    <span className="ml-2 text-caption">({group.excludedLineCount} excl.)</span>
                  ) : null}
                </td>
                {group.value != null ? (
                  <td className="py-2 pl-4 text-right">
                    <Money value={group.value} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
