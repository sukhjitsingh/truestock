import Link from "next/link";
import { requireOfficeUser } from "@/lib/current-user";
import { listCountsAction } from "@/app/actions/counts";
import { PageHeader } from "@/components/office/page-header";
import { StatusPill, countStatusTone, countStatusLabel } from "@/components/ui/status-pill";
import { CoveredMoney } from "@/components/ui/money";
import { NullValue } from "@/components/ui/null-value";
import { EmptyState } from "@/components/ui/empty-state";
import {
  TableContainer,
  Table,
  TableCaption,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import { describeValuationCoverage } from "@/lib/valuation-coverage";

export const metadata = { title: "Counts · Truestock" };

/**
 * The counts list. Moved here from `/office` when the dashboard took over
 * that route — this screen's own logic is otherwise unchanged.
 *
 * Columns are built PER ROLE — a manager's table does not contain a value
 * column at all, rather than containing one that is hidden
 * (docs/design-system.md, binding rule). `listCounts` already omits
 * `totalValue` from a manager's payload, so there is nothing in the DOM to
 * hide even if this got it wrong.
 */
export default async function CountsListPage() {
  const user = await requireOfficeUser();
  const result = await listCountsAction({});
  const counts = result.ok ? result.data : [];
  const showValue = user.role === "owner";
  const columnCount = showValue ? 7 : 6;

  return (
    <div>
      <PageHeader
        title="Counts"
        subtitle={
          <p className="text-row-subtitle text-muted-foreground">
            Audit-ready count session records, immutable snapshots, and verified valuations.
          </p>
        }
        action={
          <Link
            href="/count"
            className="flex min-h-tap-min items-center rounded-md bg-primary px-4 text-label uppercase text-primary-foreground font-semibold shadow-xs hover:bg-primary/90"
          >
            Start a count
          </Link>
        }
      />

      {!result.ok ? (
        <p className="mt-6 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {result.error.message}
        </p>
      ) : (
        <TableContainer className="mt-6 glass-card">
          <Table>
            <TableCaption>Counts, {counts.length} total</TableCaption>
            <TableHeader>
              <TableRow interactive={false}>
                <TableHead>Count</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Opened by</TableHead>
                <TableHead>Closed by</TableHead>
                {showValue ? <TableHead numeric>Snapshot Value</TableHead> : null}
                <TableHead numeric>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {counts.length === 0 ? (
                <tr>
                  <td colSpan={columnCount}>
                    <EmptyState message="No counts yet. The first one builds most of the catalog as it goes." />
                  </td>
                </tr>
              ) : (
                counts.map((count) => (
                  <TableRow key={count.id} interactive={false}>
                    <TableCell>
                      <div className="flex items-baseline gap-2">
                        <span className="font-semibold text-card-foreground">#{count.id}</span>
                        <span className="text-caption text-muted-foreground">
                          {count.type.replace(/_/g, " ")}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={countStatusTone(count.status)}>
                        {count.status === "closed" ? "✓ Closed & Locked" : countStatusLabel(count.status)}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(count.startedAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {count.openedByName ?? <NullValue reason="not-applicable" />}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {count.closedByName ?? <NullValue reason="not-entered" />}
                    </TableCell>
                    {showValue ? (
                      <TableCell numeric>
                        {count.totalValue == null ? (
                          <NullValue reason="not-entered" />
                        ) : (
                          <CoveredMoney
                            value={count.totalValue}
                            coverage={describeValuationCoverage(
                              count.valuationCoverage ?? { pricedLineCount: 0, excludedLineCount: 0 },
                            )}
                            className="font-semibold text-card-foreground"
                          />
                        )}
                      </TableCell>
                    ) : null}
                    <TableCell numeric>
                      <Link
                        href={`/office/counts/${count.id}`}
                        className="inline-flex items-center gap-1 text-caption text-accent font-semibold hover:underline"
                        aria-label={`View audit report for count #${count.id}`}
                      >
                        {count.status === "closed" ? "Audit report →" : "View detail →"}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </div>
  );
}
