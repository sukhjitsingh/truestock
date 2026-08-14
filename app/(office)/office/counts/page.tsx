import Link from "next/link";
import { requireOfficeUser } from "@/lib/current-user";
import { listCountsAction } from "@/app/actions/counts";
import { PageHeader } from "@/components/office/page-header";
import { StatusPill, countStatusTone, countStatusLabel } from "@/components/ui/status-pill";
import { Money } from "@/components/ui/money";
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
  const columnCount = showValue ? 6 : 5;

  return (
    <div>
      <PageHeader
        title="Counts"
        action={
          <Link
            href="/count"
            className="flex min-h-tap-min items-center rounded-md bg-primary px-4 text-label uppercase text-primary-foreground"
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
        <TableContainer className="mt-6">
          <Table>
            <TableCaption>Counts, {counts.length} total</TableCaption>
            <TableHeader>
              <TableRow interactive={false}>
                <TableHead>Count</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Opened by</TableHead>
                <TableHead>Closed by</TableHead>
                {showValue ? <TableHead numeric>Value</TableHead> : null}
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
                  // Not interactive as a row: the only control is the `#id`
                  // link inside the first cell. A row-wide hover would promise
                  // whole-row tap-ability that does not exist.
                  <TableRow key={count.id} interactive={false}>
                    <TableCell>
                      <Link href={`/office/counts/${count.id}`} className="text-foreground underline">
                        #{count.id}
                      </Link>
                      <span className="ml-2 text-caption text-muted-foreground">
                        {count.type.replace(/_/g, " ")}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={countStatusTone(count.status)}>
                        {countStatusLabel(count.status)}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(count.startedAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {count.openedByName ?? <NullValue reason="not-applicable" />}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {/* Null while the count is open — will be filled in at
                          close, same as the Value column below. */}
                      {count.closedByName ?? <NullValue reason="not-entered" />}
                    </TableCell>
                    {showValue ? (
                      <TableCell numeric>
                        {/* Null here means the count isn't closed, so no
                            value has been locked in — distinct from a value
                            being withheld by role. */}
                        {count.totalValue == null ? (
                          <NullValue reason="not-entered" />
                        ) : (
                          <Money value={count.totalValue} />
                        )}
                      </TableCell>
                    ) : null}
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
