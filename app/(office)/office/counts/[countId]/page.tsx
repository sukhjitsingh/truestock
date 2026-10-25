import { notFound } from "next/navigation";
import { requireOfficeUser } from "@/lib/current-user";
import { countSummaryAction } from "@/app/actions/reports";
import { PageHeader } from "@/components/office/page-header";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { StatusPill, countStatusTone, countStatusLabel } from "@/components/ui/status-pill";
import {
  TableContainer,
  Table,
  TableCaption,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
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
      <PageHeader
        title={`Count #${summary.countId}`}
        breadcrumb={{ label: "← All counts", href: "/office/counts" }}
        subtitle={
          <p className="text-row-subtitle text-muted-foreground">
            {summary.status === "closed"
              ? "Permanent immutable audit record. Unit costs and case sizes are stamped snapshot values."
              : "Active count session summary."}
          </p>
        }
        pills={
          <StatusPill tone={countStatusTone(summary.status)}>
            {summary.status === "closed" ? "✓ Closed & Locked" : countStatusLabel(summary.status)}
          </StatusPill>
        }
      />

      {/* Two tiles for a manager, three for an owner — the grid follows the
          role rather than leaving an empty cell where a value would be. */}
      <div
        className={`mt-6 grid gap-card-gap ${
          summary.totalValue != null ? "sm:grid-cols-3" : "sm:grid-cols-2"
        }`}
      >
        <Stat label="Count Lines" value={String(summary.lines.length)} subtext="recorded lines" />
        <Stat label="Total Units" value={formatUnits(summary.totalUnits)} subtext="on-hand volume" />
        {summary.totalValue != null ? (
          <Stat
            label="Snapshot Valuation"
            value={<Money value={summary.totalValue} className="text-numeral-md font-bold text-card-foreground" />}
            subtext="costed when each line was first counted"
          />
        ) : null}
      </div>

      {summary.excludedLineCount > 0 ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning-bg/80 p-4 text-warning backdrop-blur-md">
          <p className="text-row-subtitle">
            <strong className="font-semibold">{summary.pricedLineCount} priced</strong> &middot;{" "}
            <strong className="font-semibold">{summary.excludedLineCount} excluded</strong> from
            valuation (missing unit cost or case size snapshot). Excluded lines are omitted from monetary totals,
            never valued at zero.
          </p>
        </div>
      ) : null}

      {summary.previous ? (
        <Card className="mt-6 glass-card">
          <p className="text-label uppercase text-muted-foreground font-semibold">
            Comparison vs. Count #{summary.previous.countId}
            {summary.previous.closedAt ? ` (closed ${formatDate(summary.previous.closedAt)})` : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-8">
            <Delta
              label="Units Variance"
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
                label="Valuation Variance"
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
        <Rollup title="Rollup by Category" groups={summary.byCategory} showCost={summary.totalValue != null} />
        <Rollup title="Rollup by Location" groups={summary.byLocation} showCost={summary.totalValue != null} />
      </div>
    </div>
  );
}

function Stat({ label, value, subtext }: { label: string; value: React.ReactNode; subtext?: string }) {
  return (
    <Card className="glass-card">
      <p className="text-label uppercase text-muted-foreground font-semibold">{label}</p>
      <p className="mt-1 text-numeral-md font-bold text-card-foreground">{value}</p>
      {subtext ? <p className="mt-0.5 text-caption text-muted-foreground">{subtext}</p> : null}
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
      <p className="text-label uppercase text-muted-foreground font-semibold">{label}</p>
      <p className="mt-1 text-numeral-sm font-semibold tabular-nums text-foreground">
        {previous} &rarr; {current}
      </p>
      <p className="text-caption tabular-nums text-muted-foreground">
        {sign}
        {format(Math.abs(delta))}
      </p>
    </div>
  );
}

function Rollup({ title, groups, showCost }: { title: string; groups: SummaryGroup[]; showCost?: boolean }) {
  return (
    // min-w-0: a grid item defaults to `min-width: auto`, i.e. as wide as its
    // content. The table inside is `min-w-max`, so without this the section
    // grows to the table's width, the container's own `overflow-x-auto` never
    // has anything to clip, and the whole page scrolls sideways at phone width.
    <section className="min-w-0">
      <h2 className="mb-3 text-label uppercase text-muted-foreground font-semibold">{title}</h2>
      <TableContainer className="glass-card">
        <Table>
          <TableCaption>{title}, {groups.length} groups</TableCaption>
          <TableBody>
            {groups.length === 0 ? (
              <tr>
                <td colSpan={showCost ? 3 : 2}>
                  <EmptyState message="Nothing counted." />
                </td>
              </tr>
            ) : (
              groups.map((group) => (
                <TableRow key={group.key} interactive={false}>
                  <TableCell className="max-w-[16rem] truncate font-medium" title={group.label}>
                    {group.label}
                  </TableCell>
                  <TableCell numeric className="text-muted-foreground tabular-nums">
                    {formatUnits(group.units)} units
                    {group.excludedLineCount > 0 ? (
                      <span className="ml-2 text-caption text-warning">({group.excludedLineCount} excl.)</span>
                    ) : null}
                  </TableCell>
                  {group.value != null ? (
                    <TableCell numeric>
                      <Money value={group.value} className="font-semibold tabular-nums text-card-foreground" />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </section>
  );
}
