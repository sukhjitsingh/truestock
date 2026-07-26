import Link from "next/link";
import { requireOfficeUser } from "@/lib/current-user";
import { listCountsAction } from "@/app/actions/counts";
import { StatusPill, countStatusTone, countStatusLabel } from "@/components/ui/status-pill";
import { Money } from "@/components/ui/money";
import { formatDateTime } from "@/lib/utils";

export const metadata = { title: "Counts · Handlebar" };

/**
 * The counts list. Columns are built PER ROLE — a manager's table does not
 * contain a value column at all, rather than containing one that is hidden
 * (docs/design-system.md, binding rule). `listCounts` already omits
 * `totalValue` from a manager's payload, so there is nothing in the DOM to
 * hide even if this got it wrong.
 */
export default async function CountsListPage() {
  const user = await requireOfficeUser();
  const result = await listCountsAction({});
  const counts = result.ok ? result.data : [];
  const showValue = user.role === "owner";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-header-title">Counts</h1>
        <Link
          href="/count"
          className="flex min-h-tap-min items-center rounded-md bg-primary px-4 text-label uppercase text-primary-foreground"
        >
          Start a count
        </Link>
      </div>

      {!result.ok ? (
        <p className="mt-6 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {result.error.message}
        </p>
      ) : counts.length === 0 ? (
        <p className="mt-6 text-row-subtitle text-muted-foreground">
          No counts yet. The first one builds most of the catalog as it goes.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-border">
                <Th>Count</Th>
                <Th>Status</Th>
                <Th>Started</Th>
                <Th>Opened by</Th>
                <Th>Closed by</Th>
                {showValue ? <Th align="right">Value</Th> : null}
              </tr>
            </thead>
            <tbody>
              {counts.map((count) => (
                <tr key={count.id} className="border-b border-border">
                  <Td>
                    <Link href={`/office/counts/${count.id}`} className="text-foreground underline">
                      #{count.id}
                    </Link>
                    <span className="ml-2 text-caption text-muted-foreground">
                      {count.type.replace(/_/g, " ")}
                    </span>
                  </Td>
                  <Td>
                    <StatusPill tone={countStatusTone(count.status)}>
                      {countStatusLabel(count.status)}
                    </StatusPill>
                  </Td>
                  <Td className="text-muted-foreground">{formatDateTime(count.startedAt)}</Td>
                  <Td className="text-muted-foreground">{count.openedByName ?? "—"}</Td>
                  <Td className="text-muted-foreground">{count.closedByName ?? "—"}</Td>
                  {showValue ? (
                    <Td align="right">
                      {/* Null here means the count isn't closed, so no value has
                          been locked in — distinct from a value being withheld. */}
                      {count.totalValue == null ? (
                        <span className="text-caption text-muted-foreground">not closed</span>
                      ) : (
                        <Money value={count.totalValue} />
                      )}
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      scope="col"
      className={`py-2 text-label uppercase text-muted-foreground ${align === "right" ? "text-right" : ""}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  className,
}: {
  children: React.ReactNode;
  align?: "right";
  className?: string;
}) {
  return (
    <td
      className={`py-3 text-row-subtitle ${align === "right" ? "text-right" : ""} ${className ?? ""}`}
    >
      {children}
    </td>
  );
}
