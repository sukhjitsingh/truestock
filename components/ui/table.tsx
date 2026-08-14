import { ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Table primitive set — docs/design-system.md §9 "Table", "Pagination",
 * "Sort control"; docs/plans/phase-2-ui-redesign/ui-spec-web.md §1.
 *
 * Presentation only. These render into whatever `@tanstack/react-table`
 * model the back-office agent builds — no table state (sorting, pagination,
 * filtering) lives here. The one exception is `SortableTableHead`'s own
 * `aria-sort` bookkeeping, which is a rendering concern (matching the
 * attribute to the caller-supplied direction), not state.
 *
 * **Columns are still a per-role array built at call time by the caller —
 * this file has no opinion on which columns exist.** `columnVisibility`
 * must never be used to hide a role-gated column; that keeps the column in
 * the table model, so the wrongness is invisible in the DOM (the exact P0.5
 * defect this project bans). See docs/design-system.md §9's Table spec.
 */

/** Horizontal-scroll wrapper — the office density rule (§6/§10): below a
 * density breakpoint a table gains scroll inside its own container rather
 * than the page blocking pinch-zoom to preserve a fixed layout. */
export function TableContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("w-full overflow-x-auto", className)}>{children}</div>;
}

export function Table({
  children,
  className,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table className={cn("w-full min-w-max border-collapse text-body", className)} {...props}>
      {children}
    </table>
  );
}

/**
 * The table's accessible name — sr-only, never silent. e.g. "Catalog, 99
 * active products". Every table gets one; this is not optional polish
 * (design-system.md §9, "An accessible name via `<caption>`").
 */
export function TableCaption({ children }: { children: React.ReactNode }) {
  return <caption className="sr-only">{children}</caption>;
}

export function TableHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <thead className={cn("border-b border-border", className)}>{children}</thead>;
}

/** A real empty state belongs inside this when there are no rows — never an
 * absent `<tbody>`. See components/ui/empty-state.tsx, rendered inside a
 * single full-width `<td>`. */
export function TableBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <tbody className={className}>{children}</tbody>;
}

/**
 * `interactive` (default true) applies `hover:bg-muted` — the one binding
 * hover treatment for a genuinely interactive row (a row with an Edit
 * button). Pass `interactive={false}` for a non-interactive summary/total
 * row, which gets no hover treatment (the same principle as a passive
 * card getting no hover — design-system.md §9's Hover spec).
 *
 * `h-row-office` / `min-h-row-office` is the one row-height token, ending
 * the 57px/48px/52px drift the audit found. Cell padding is never zero
 * vertical — pair with `py-2` on `TableCell`/`TableHead` (already applied
 * there by default).
 */
export function TableRow({
  children,
  className,
  interactive = true,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }) {
  return (
    <tr
      className={cn(
        "h-row-office min-h-row-office border-b border-border last:border-b-0",
        interactive && "hover:bg-muted",
        className,
      )}
      {...props}
    >
      {children}
    </tr>
  );
}

/** A non-sortable header cell. `scope="col"` on every `<th>`, unconditionally. */
export function TableHead({
  children,
  className,
  numeric,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "px-card-pad py-2 text-left text-label uppercase text-muted-foreground",
        numeric && "num",
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function TableCell({
  children,
  className,
  numeric,
  title,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        "px-card-pad py-2 text-row-subtitle text-card-foreground",
        numeric && "num",
        className,
      )}
      title={title}
      {...props}
    >
      {children}
    </td>
  );
}

export type SortDirection = "asc" | "desc" | false;

function ariaSortValue(direction: SortDirection): "ascending" | "descending" | "none" {
  if (direction === "asc") return "ascending";
  if (direction === "desc") return "descending";
  return "none";
}

function SortIcon({ direction }: { direction: SortDirection }) {
  if (direction === "asc") return <ChevronUp className="size-3.5" aria-hidden="true" />;
  if (direction === "desc") return <ChevronDown className="size-3.5" aria-hidden="true" />;
  return <ChevronsUpDown className="size-3.5" aria-hidden="true" />;
}

/**
 * A sortable header cell: a real `<button>` — never a decorative
 * `<span aria-hidden="true">` with `cursor: pointer` and no handler — with
 * `aria-sort` on the `<th>` itself (the only element ARIA permits it on;
 * `columnheader`/`th`/`table`), updated live to match the button's own
 * state. Every column that plausibly benefits from sorting gets this, not
 * an inconsistent subset.
 */
export function SortableTableHead({
  children,
  direction,
  onSort,
  numeric,
  className,
}: {
  children: React.ReactNode;
  direction: SortDirection;
  onSort: () => void;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <th
      scope="col"
      aria-sort={ariaSortValue(direction)}
      className={cn(
        "px-card-pad py-2 text-left text-label uppercase text-muted-foreground",
        numeric && "num",
        className,
      )}
    >
      <button
        type="button"
        onClick={onSort}
        className={cn(
          "inline-flex items-center gap-1 text-label uppercase text-foreground",
          numeric && "flex-row-reverse",
        )}
      >
        {children}
        <SortIcon direction={direction} />
      </button>
    </th>
  );
}

/**
 * Required on every table, not optional polish — TanStack Table's
 * pagination row model wires into this. `disabled` (never a click handler
 * that silently no-ops) plus `disabled:opacity-40` for the boundary case.
 */
export function TablePagination({
  rangeLabel,
  page,
  pageCount,
  onPreviousPage,
  onNextPage,
  className,
}: {
  /** e.g. "Showing 1–20 of 99" */
  rangeLabel: string;
  page: number;
  pageCount: number;
  onPreviousPage: () => void;
  onNextPage: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-t border-border px-card-pad py-3",
        className,
      )}
    >
      <p className="text-caption text-muted-foreground">{rangeLabel}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Previous page"
          onClick={onPreviousPage}
          disabled={page <= 1}
          className="flex h-9 min-w-9 items-center justify-center rounded-md border border-input px-2 text-caption text-foreground disabled:opacity-40"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <span className="text-caption text-foreground">
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          aria-label="Next page"
          onClick={onNextPage}
          disabled={page >= pageCount}
          className="flex h-9 min-w-9 items-center justify-center rounded-md border border-input px-2 text-caption text-foreground disabled:opacity-40"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
