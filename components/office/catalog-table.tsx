"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useEffect, useState, useMemo, useCallback, useTransition } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type PaginationState,
} from "@tanstack/react-table";
import { cn, formatCostForInput } from "@/lib/utils";
import { Money } from "@/components/ui/money";
import { StatusPill } from "@/components/ui/status-pill";
import { Button, buttonVariants } from "@/components/ui/button";
import { NullValue } from "@/components/ui/null-value";
import { FilterPill } from "@/components/ui/filter-pill";
import { EmptyState } from "@/components/ui/empty-state";
import { StockCell } from "@/components/ui/stock-cell";
import {
  TableContainer,
  Table,
  TableCaption,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  SortableTableHead,
  TablePagination,
} from "@/components/ui/table";
import { assignVendorToProductsAction, updateProductAction } from "@/app/actions/catalog";
import type { ProductSummary, ProductIncompleteReason, VendorSummary } from "@/lib/domain/catalog";
import { unitCostSchema } from "@/lib/validation/catalog";
import { isCountedByCase } from "@/lib/pack-level";

const REASON_LABEL: Record<ProductIncompleteReason, string> = {
  needs_producer: "Needs producer",
  needs_case_size: "Needs case size",
  needs_cost: "Needs cost",
  // Attached by `attachStock`, so it only appears where stock was asked for —
  // which is this table. A product with no par can never reach the reorder
  // list, and nothing else anywhere says so.
  needs_par: "Needs par",
};

/** Columns whose values are genuinely numeric — `.num` alignment only, per
 * ui-spec-web.md §1 ("never on an actions column"). */
const NUMERIC_COLUMN_IDS = new Set(["onHand", "unitCost", "caseSize"]);

/**
 * The catalog table — migrated to `@tanstack/react-table` v8
 * (ui-spec-web.md §1, "adopted for the catalog table first").
 *
 * The cost column is built per role — a manager's `columns` array does not
 * contain it, rather than containing it filtered or hidden (design-system.md,
 * binding rule; `columnVisibility` is never used). The server already omits
 * `currentUnitCost` from their payload, so this is the matching half of a
 * gate that is enforced twice.
 *
 * "Needs attention" is a derived predicate computed server-side
 * (lib/domain/catalog.ts), not a stored flag and not something this table
 * re-invents from category plus a null brand the way the prototype did.
 *
 * Bulk vendor assignment is owner/manager only (staff gets no checkboxes or
 * action bar at all — CLAUDE.md invariant 7, gated in page, not just in button
 * disabled state). Visible when one or more products are selected.
 *
 * Row-level Edit is an explicit button (styled from the shared `Button`
 * variant classes for visual parity with `locations-table.tsx` /
 * `vendors-list.tsx`), never the product name doubling as a bare link — the
 * name is plain text now.
 */
export function CatalogTable({
  products,
  query,
  view,
  canSeeCost,
  canEditCost,
  vendors,
  userRole,
}: {
  products: ProductSummary[];
  query: string;
  view: "all" | "attention";
  canSeeCost: boolean;
  /** Owner-only, same predicate as `canSeeCost` today — gates whether the
   * cost cell renders as an editable input or read-only Money (Gate 3
   * "changed props"). Case-size edit ability reuses `canManage` below. */
  canEditCost: boolean;
  vendors: VendorSummary[];
  userRole: "owner" | "manager" | "staff";
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState(query);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectedVendorId, setSelectedVendorId] = useState<number | null | undefined>(undefined);
  const [assignPending, setAssignPending] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignSuccess, setAssignSuccess] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  // Three states, not two: `undefined` = no subcategory filter, a string =
  // that subcategory, and `null` = the "Unspecified" pill, which is a real
  // filter selecting rows whose subcategory IS null. Collapsing null and
  // undefined into one value would make "Unspecified" unclickable.
  const [subcategoryFilter, setSubcategoryFilter] = useState<string | null | undefined>(undefined);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 20 });

  /**
   * A client-owned copy of `products`, patched one row at a time from a
   * cell's saved response (Amendment 2, 2026-08-12). This is what NOT calling
   * `router.refresh()` per cell requires: the table's own state, not the
   * server-rendered prop, is what a cell save updates. Re-synced from
   * `products` whenever a real navigation (search, view, or an explicit
   * refresh) hands down a fresh array — see the effect below.
   */
  const [rows, setRows] = useState<ProductSummary[]>(products);
  // Adjust state on a prop change during render, per React's own guidance —
  // NOT in a `useEffect`, which would cascade an extra render for the same
  // update (react-hooks/set-state-in-effect). `prevProducts` is the "value
  // from a previous render" marker that makes this reset conditional rather
  // than unconditional.
  const [prevProducts, setPrevProducts] = useState(products);
  if (products !== prevProducts) {
    setPrevProducts(products);
    setRows(products);
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }

  /** Bubbled up from an editable cell on a successful save — patches only that row. */
  const patchRow = useCallback((updated: ProductSummary) => {
    setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
  }, []);

  const canManage = userRole === "owner" || userRole === "manager";

  const categories = useMemo(
    () => Array.from(new Set(rows.map((p) => p.category))).sort(),
    [rows],
  );

  /**
   * Subcategories of the CURRENTLY SELECTED category only — "Whiskey, Vodka,
   * Tequila, Gin, Rum" under Spirits, "Bottle, Draft, Cider" under Beer.
   *
   * Deliberately a second level rather than a flat list of every subcategory
   * in the catalog. Flat, this bar would be twelve pills wide and would mix
   * "Draft" with "Tequila" — two facets of different parents presented as
   * peers, which is exactly how a counter ends up filtering to an empty
   * intersection and concluding the catalog is missing products.
   *
   * `subcategory` is nullable in the schema, and a null is shown as its own
   * pill rather than dropped. A product with no subcategory is invisible under
   * every subcategory filter, so silently omitting the pill would make those
   * rows unreachable once the user starts drilling down — and unreachable
   * looks identical to "we don't stock it".
   */
  const subcategories = useMemo(() => {
    if (!categoryFilter) return [];
    const seen = new Set<string | null>();
    for (const p of rows) {
      if (p.category === categoryFilter) seen.add(p.subcategory ?? null);
    }
    return Array.from(seen).sort((a, b) => {
      if (a === null) return 1; // "Unspecified" sorts last — it is not a type.
      if (b === null) return -1;
      return a.localeCompare(b);
    });
  }, [rows, categoryFilter]);

  /**
   * This array is `useReactTable`'s `data`, and TanStack v8 watches it BY
   * REFERENCE: `getCoreRowModel`/`getSortedRowModel` rebuild their row models
   * whenever the reference changes. Built inline, it was a new array on every
   * render, so every render re-derived all 99 rows' models and re-ran the
   * column definitions closed over it.
   *
   * **This is an optimization, not a correctness fix — say so plainly, because
   * an earlier version of this comment claimed otherwise.** It was written as
   * the cure for the catalog page hanging, on a theory that the unstable
   * reference drove `_autoResetPageIndex` → `setPagination` → re-render in a
   * closed loop. That theory is wrong and was disproven twice on 2026-08-13:
   * render instrumentation showed this component never renders more than three
   * times, and the un-memoized original measured 151–710 ms per category-pill
   * click with every click completing. The actual hang was Drizzle reaching
   * the client bundle — see the header of db/enums.ts.
   *
   * What the memoization is worth, measured on the same five clicks in a fresh
   * tab against the dev server: 308/638/315/114/350 ms memoized vs
   * 396/710/439/151/445 ms inline. Consistent, roughly 20%, and not a fix for
   * anything. Keep it on those terms.
   */
  const filteredRows = useMemo(() => {
    let out = rows;
    if (categoryFilter) out = out.filter((p) => p.category === categoryFilter);
    if (subcategoryFilter !== undefined) {
      out = out.filter((p) => (p.subcategory ?? null) === subcategoryFilter);
    }
    return out;
  }, [rows, categoryFilter, subcategoryFilter]);

  /**
   * Changing the category always clears the subcategory. "Spirits + Whiskey"
   * then switching to Beer would otherwise leave a Whiskey filter applied to
   * beer and show an empty table — the filter bar would be telling the truth
   * while the screen said the bar stocks no beer.
   */
  function setCategory(next: string | null) {
    setCategoryFilter(next);
    setSubcategoryFilter(undefined);
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }

  function setSubcategory(next: string | null | undefined) {
    setSubcategoryFilter(next);
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }

  // Track which products are currently visible (matching search/view/category
  // filters) — a derived check rather than a stored list so the UI stays in
  // sync. "Visible" is filter-scoped, not page-scoped: selecting all is a
  // statement about everything matching the current filters, not just the
  // rows on the current pagination page.
  const visibleIds = useMemo(() => new Set(filteredRows.map((p) => p.id)), [filteredRows]);

  // When the product list changes (search query, view filter, category
  // filter, navigation), prune selectedIds to only include products still
  // visible. This prevents a bulk vendor write from applying to off-screen
  // products — a silent failure where the manager sees a count for rows they
  // believe they selected, but the ids actually belong to products that are
  // no longer displayed.
  const visibleSelectedIds = useMemo(
    () => new Set(Array.from(selectedIds).filter((id) => visibleIds.has(id))),
    [selectedIds, visibleIds],
  );

  // Ref for the "select all" checkbox to manage indeterminate state (CSS has
  // no way to set it; it must be done in JS via the property).
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      const allSelected = visibleIds.size > 0 && visibleSelectedIds.size === visibleIds.size;
      const someSelected = visibleSelectedIds.size > 0 && visibleSelectedIds.size < visibleIds.size;
      selectAllRef.current.checked = allSelected;
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [visibleSelectedIds, visibleIds]);

  function navigate(next: { q?: string; view?: string }, mode: "push" | "replace" = "push") {
    const search = new URLSearchParams(params.toString());
    for (const [key, v] of Object.entries(next)) {
      if (v) search.set(key, v);
      else search.delete(key);
    }
    const url = `/office/catalog?${search.toString()}`;
    if (mode === "replace") router.replace(url);
    else router.push(url);
  }

  /**
   * Type-ahead search. The query lives in the URL and the actual filtering
   * happens server-side (`searchProducts`), so every keystroke would otherwise
   * be a round trip and a history entry. Two things make that behave:
   *
   *  - **Debounced 250 ms.** Typing "tequila" fires one request, not seven.
   *  - **`router.replace`, not `push`.** Otherwise a seven-letter search leaves
   *    seven entries in history and the back button walks the user backwards
   *    one character at a time instead of returning to where they came from.
   *
   * `useTransition` is what keeps the input responsive while the RSC payload
   * is in flight — without it, React would block on the pending navigation and
   * the field would stutter mid-word, which is the exact feel the user was
   * asking to be rid of. `isSearching` drives the visible "Searching…" note so
   * a slow query looks like a slow query rather than a dropped keystroke.
   *
   * Enter still works and is not merely tolerated: it cancels the pending
   * debounce and searches immediately, which is the right escape hatch for
   * someone who has already finished typing.
   */
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isSearching, startSearchTransition] = useTransition();

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  function runSearch(next: string) {
    startSearchTransition(() => {
      navigate({ q: next, view: view === "attention" ? "attention" : undefined }, "replace");
    });
  }

  function onSearchChange(next: string) {
    setValue(next);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => runSearch(next), 250);
  }

  // These three are `useCallback` because the column definitions below close
  // over them, and `columns` is memoized — see the note on `filteredRows`.
  // `toggleProduct` reads the previous selection through the functional
  // updater rather than closing over `selectedIds`, which is what lets it stay
  // referentially stable across a selection change.
  const toggleProduct = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setAssignError(null);
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelectedIds(new Set(visibleIds));
    setAssignError(null);
  }, [visibleIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setAssignError(null);
  }, []);

  async function submitAssignVendor() {
    if (visibleSelectedIds.size === 0) return;

    // Deduplicate and check the 500 product limit.
    const uniqueIds = Array.from(new Set(visibleSelectedIds));
    if (uniqueIds.length > 500) {
      setAssignError(
        `Cannot assign to more than 500 products at once. ${uniqueIds.length} selected.`,
      );
      return;
    }

    setAssignPending(true);
    setAssignError(null);
    setAssignSuccess(false);

    try {
      const result = await assignVendorToProductsAction({
        productIds: uniqueIds,
        vendorId: selectedVendorId ?? null,
      });

      if (result.ok) {
        setAssignSuccess(true);
        setSelectedIds(new Set());
        setSelectedVendorId(undefined);
        // Refresh to show updated vendor assignments.
        router.refresh();
        // Clear success message after 3 seconds.
        setTimeout(() => setAssignSuccess(false), 3000);
      } else {
        setAssignError(result.error.message);
      }
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      setAssignPending(false);
    }
  }

  // Column arrays are built conditionally, per role, at call time —
  // `columnVisibility` is never used (ui-spec-web.md §1's binding rule).
  //
  // Memoized for the same reason `filteredRows` is: `useReactTable` compares
  // `columns` by reference too, and rebuilding it every render throws away and
  // reconstructs the entire column and row model on each pass.
  const columns = useMemo<ColumnDef<ProductSummary>[]>(() => {
    const cols: ColumnDef<ProductSummary>[] = [];

    if (canManage) {
      cols.push({
        id: "select",
        header: () => (
          <input
            ref={selectAllRef}
            type="checkbox"
            onChange={(e) => (e.currentTarget.checked ? selectAllVisible() : clearSelection())}
            aria-label={`Select all ${visibleIds.size} visible products`}
            className="h-4 w-4 cursor-pointer"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={selectedIds.has(row.original.id)}
            onChange={() => toggleProduct(row.original.id)}
            aria-label={`Select ${row.original.name}`}
            className="h-4 w-4 cursor-pointer"
          />
        ),
        enableSorting: false,
      });
    }

    cols.push({
      id: "product",
      accessorKey: "name",
      header: "Product",
      cell: ({ row }) => {
        const product = row.original;
        return (
          <div>
            <span
              className="block max-w-[16rem] truncate text-row-subtitle font-semibold text-foreground"
              title={product.name}
            >
              {product.name}
            </span>
            <span className="block text-caption text-muted-foreground">
              {product.unitType === "keg" ? "Keg" : `${product.sizeMl}ml`}
              {product.brand ? ` · ${product.brand}` : ""}
            </span>
            {product.incomplete.length > 0 ? (
              <span className="mt-1.5 flex flex-wrap gap-1.5">
                {product.incomplete.map((reason) => (
                  <StatusPill key={reason} tone="warning">
                    {REASON_LABEL[reason]}
                  </StatusPill>
                ))}
              </span>
            ) : null}
          </div>
        );
      },
    });

    cols.push({
      id: "category",
      // Sorts by the pair, so Spirits rows group by type rather than
      // interleaving Whiskey and Vodka under one "Spirits" heading.
      accessorFn: (row) => `${row.category} ${row.subcategory ?? ""}`,
      header: "Category",
      cell: ({ row }) => (
        <span className="text-row-subtitle text-muted-foreground">
          {row.original.category}
          {row.original.subcategory ? (
            <span className="block text-caption">{row.original.subcategory}</span>
          ) : null}
        </span>
      ),
    });

    cols.push({
      id: "onHand",
      accessorFn: (row) => row.stock?.onHand ?? -1,
      header: "On hand",
      cell: ({ row }) => {
        const stock = row.original.stock;
        if (!stock) return null;
        // No closed count yet — "never counted" is not "zero on hand", and
        // showing a 0 here would read as an urgent stockout across the whole
        // catalog.
        if (stock.onHand == null) {
          return <span className="text-row-subtitle text-muted-foreground">no closed count</span>;
        }
        return (
          <div className="flex flex-col items-end">
            <StockCell
              onHand={stock.onHand}
              par={stock.parLevel}
              isPartial={stock.onHandIsPartial}
            />
          </div>
        );
      },
    });

    if (canSeeCost) {
      cols.push({
        id: "unitCost",
        accessorFn: (row) => (row.currentUnitCost != null ? Number(row.currentUnitCost) : -1),
        header: "Unit cost",
        cell: ({ row }) => {
          const product = row.original;
          if (canEditCost) {
            return (
              <EditableProductCell
                productId={product.id}
                field="currentUnitCost"
                // DECIMAL(10,4) arrives as "144.0000" — see formatCostForInput.
                value={formatCostForInput(product.currentUnitCost)}
                placeholder="Enter cost"
                ariaLabel={`Unit cost for ${product.name}`}
                onSaved={patchRow}
              />
            );
          }
          return product.currentUnitCost ? (
            <Money value={Number(product.currentUnitCost)} />
          ) : (
            <NullValue reason="not-entered" />
          );
        },
      });
    }

    if (canManage) {
      cols.push({
        id: "caseSize",
        accessorFn: (row) => row.caseSize ?? -1,
        header: "Case size",
        cell: ({ row }) => {
          const product = row.original;
          if (isCountedByCase(product)) {
            return (
              <EditableProductCell
                productId={product.id}
                field="caseSize"
                value={product.caseSize == null ? "" : String(product.caseSize)}
                placeholder="Case size"
                ariaLabel={`Case size for ${product.name}`}
                onSaved={patchRow}
              />
            );
          }
          return (
            <span
              className="inline-flex"
              aria-label={`Case size is not applicable for ${product.name} — not counted by the case`}
            >
              <NullValue reason="not-applicable" />
            </span>
          );
        },
      });

      cols.push({
        id: "edit",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={`/office/catalog/${row.original.id}`}
            aria-label={`Edit ${row.original.name}`}
            className={cn(buttonVariants({ variant: "outline", size: "tap" }), "whitespace-nowrap")}
          >
            Edit
          </Link>
        ),
      });
    }

    return cols;
  }, [
    canManage,
    canSeeCost,
    canEditCost,
    selectedIds,
    visibleIds,
    selectAllVisible,
    clearSelection,
    toggleProduct,
    patchRow,
  ]);

  const table = useReactTable({
    data: filteredRows,
    columns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const headerGroup = table.getHeaderGroups()[0];
  const bodyRows = table.getRowModel().rows;
  const pageSize = table.getState().pagination.pageSize;
  const pageIndex = table.getState().pagination.pageIndex;
  const totalRows = filteredRows.length;
  const rangeStart = totalRows === 0 ? 0 : pageIndex * pageSize + 1;
  const rangeEnd = Math.min(totalRows, (pageIndex + 1) * pageSize);
  const rangeLabel = `Showing ${rangeStart}–${rangeEnd} of ${totalRows}`;

  const emptyMessage =
    rows.length === 0
      ? view === "attention"
        ? "Nothing needs attention."
        : "No products match that search."
      : subcategoryFilter !== undefined
        ? `No ${subcategoryFilter ?? "unspecified"} products in ${categoryFilter}.`
        : `No products in ${categoryFilter}.`;

  return (
    <div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // Enter means "now" — drop the pending debounce rather than
            // letting it fire a second, identical navigation 250 ms later.
            if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
            runSearch(value);
          }}
          method="get"
          className="flex min-w-[16rem] flex-1 items-center gap-2 rounded-md border border-input bg-card px-4 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50"
        >
          <input
            type="search"
            value={value}
            onChange={(e) => onSearchChange(e.target.value)}
            // Names what it actually matches. `searchProducts` gained
            // subcategory when the type filter shipped, and a placeholder that
            // still said "name or brand" made "tequila" look like a search that
            // had failed rather than one the user was never told to try.
            placeholder="Search name, brand or type"
            aria-label="Search catalog"
            className="min-h-tap-min min-w-0 flex-1 bg-transparent text-body text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          {/* A live region, so a screen reader hears that results are being
              fetched — the sighted cue is this same text. `aria-hidden` on a
              spinner would leave that user with no signal at all. */}
          <span
            role="status"
            aria-live="polite"
            className="shrink-0 text-caption text-muted-foreground"
          >
            {isSearching ? "Searching…" : ""}
          </span>
        </form>

        {/* View tabs — active gets underline + bold, never a color change
            (ui-spec-web.md §2, mirrors the counting app's tab-bar rule). */}
        <nav aria-label="View" className="flex gap-4 border-b border-border">
          {(
            [
              { key: "all", label: "All" },
              { key: "attention", label: "Needs attention" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => navigate({ q: value, view: tab.key === "all" ? undefined : tab.key })}
              aria-current={view === tab.key ? "true" : undefined}
              className={cn(
                "min-h-tap-min border-b-2 px-1 text-label uppercase",
                view === tab.key
                  ? "border-foreground font-semibold text-foreground"
                  : "border-transparent text-muted-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {categories.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {categories.map((category) => (
            <FilterPill
              key={category}
              applied={categoryFilter === category}
              onClick={() => setCategory(categoryFilter === category ? null : category)}
            >
              Category: {category}
            </FilterPill>
          ))}
        </div>
      ) : null}

      {/* The second level, shown only once a category is chosen and only when
          that category actually splits — a lone "Type: Liqueur" pill under
          Liqueur is a control that cannot change anything. Indented and
          labelled so it reads as narrowing the row above rather than as a
          second, independent filter bar. */}
      {subcategories.length > 1 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-l-2 border-border pl-3">
          <span className="text-label uppercase text-muted-foreground">Within {categoryFilter}</span>
          {subcategories.map((sub) => (
            <FilterPill
              key={sub ?? "__unspecified__"}
              applied={subcategoryFilter === sub}
              onClick={() => setSubcategory(subcategoryFilter === sub ? undefined : sub)}
            >
              Type: {sub ?? "Unspecified"}
            </FilterPill>
          ))}
        </div>
      ) : null}

      {assignSuccess && (
        <p
          className="mt-6 rounded-md bg-success-bg px-3 py-2 text-caption text-success"
          role="status"
        >
          Vendor assignment updated.
        </p>
      )}

      {assignError && (
        <p className="mt-6 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {assignError}
        </p>
      )}

      <TableContainer className="mt-6">
        <Table>
          <TableCaption>
            Catalog, {totalRows} {totalRows === 1 ? "product" : "products"}
            {view === "attention" ? " needing attention" : ""}
          </TableCaption>
          <TableHeader>
            <tr className="border-b border-border">
              {headerGroup.headers.map((header) => {
                const numeric = NUMERIC_COLUMN_IDS.has(header.column.id);
                const label = flexRender(header.column.columnDef.header, header.getContext());
                if (!header.column.getCanSort()) {
                  return (
                    <TableHead key={header.id} numeric={numeric}>
                      {label}
                    </TableHead>
                  );
                }
                return (
                  <SortableTableHead
                    key={header.id}
                    direction={header.column.getIsSorted()}
                    numeric={numeric}
                    onSort={() => header.column.toggleSorting()}
                  >
                    {label}
                  </SortableTableHead>
                );
              })}
            </tr>
          </TableHeader>
          <TableBody>
            {bodyRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <EmptyState message={emptyMessage} />
                </td>
              </tr>
            ) : (
              bodyRows.map((row) => (
                // Staff get neither the select checkbox nor the Edit column
                // (both gated on `canManage`), so for that role the row holds
                // no control at all and must not advertise hover.
                <TableRow key={row.id} interactive={canManage}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      numeric={NUMERIC_COLUMN_IDS.has(cell.column.id)}
                      className="align-top"
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {totalRows > 0 ? (
        <TablePagination
          rangeLabel={rangeLabel}
          page={pageIndex + 1}
          pageCount={Math.max(1, table.getPageCount())}
          onPreviousPage={() => table.previousPage()}
          onNextPage={() => table.nextPage()}
        />
      ) : null}

      {canManage && visibleSelectedIds.size > 0 && (
        <VendorAssignmentBar
          selectedCount={visibleSelectedIds.size}
          vendors={vendors}
          selectedVendorId={selectedVendorId}
          onVendorChange={setSelectedVendorId}
          onSubmit={submitAssignVendor}
          pending={assignPending}
          onClear={clearSelection}
        />
      )}
    </div>
  );
}

function VendorAssignmentBar({
  selectedCount,
  vendors,
  selectedVendorId,
  onVendorChange,
  onSubmit,
  pending,
  onClear,
}: {
  selectedCount: number;
  vendors: VendorSummary[];
  selectedVendorId: number | null | undefined;
  onVendorChange: (id: number | null | undefined) => void;
  onSubmit: () => void;
  pending: boolean;
  onClear: () => void;
}) {
  // Build the consequence string. Derive it from the RESOLVED vendorId, not which
  // control the user touched. Both null (explicitly "No vendor") and undefined (dropdown
  // untouched) mean "clear to null", so they must produce the same, correct string.
  // If we checked selectedVendorId === undefined for the action name, selecting "No
  // vendor" (which resolves to null) would say "Set vendor" when it should say "Clear
  // vendor"—a deliberate action being less informative than the accidental one.
  const vendorName =
    selectedVendorId === null || selectedVendorId === undefined
      ? ""
      : vendors.find((v) => v.id === selectedVendorId)?.name;
  const isClearing = selectedVendorId === null || selectedVendorId === undefined;
  const actionName = isClearing ? "Clear vendor for" : "Set vendor for";
  const consequence = isClearing
    ? `${actionName} ${selectedCount} ${selectedCount === 1 ? "product" : "products"}`
    : `${actionName} ${selectedCount} ${selectedCount === 1 ? "product" : "products"} → ${vendorName}`;

  return (
    <div className="sticky bottom-0 left-0 right-0 z-10 mt-4 flex flex-col gap-3 rounded-md border border-b-0 border-border bg-muted p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <label htmlFor="vendor-select" className="text-label text-muted-foreground">
          Vendor:
        </label>
        <select
          id="vendor-select"
          value={selectedVendorId === undefined ? "" : selectedVendorId ?? "null"}
          onChange={(e) => {
            if (e.target.value === "") {
              onVendorChange(undefined);
            } else if (e.target.value === "null") {
              onVendorChange(null);
            } else {
              onVendorChange(Number(e.target.value));
            }
          }}
          className="rounded-md border border-input bg-card px-2 py-1.5 text-body text-foreground focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">— Select vendor —</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
          <option value="null">No vendor</option>
        </select>
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={onClear}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          onClick={onSubmit}
          disabled={pending || selectedVendorId === undefined}
          className="whitespace-nowrap"
        >
          {pending ? "Updating…" : consequence}
        </Button>
      </div>
    </div>
  );
}

type EditableField = "currentUnitCost" | "caseSize";

/**
 * One inline cost or case-size cell — Slice 4
 * (docs/plans/phase-1-to-1.5/mockups/catalog-inline-cost.html has every
 * state this renders). One `updateProductAction` call per commit, reused
 * VERBATIM (Gate 2 Decision 7) — this component adds no new endpoint.
 *
 * Cells commit on blur/Enter, one at a time, and on a successful save patch
 * ONLY this row via `onSaved`, from the ACTION'S RETURNED value — never from
 * the locally-typed string (Risk 6/Amendment 2, 02-architecture.md). That
 * matters twice: the server is the authority on normalization (a leading-zero
 * or over-precise entry settles on the DB's stored string), and if a
 * non-owner request ever reached here with cost silently stripped, the cell
 * would visibly snap back instead of showing a value that was never saved.
 * No `router.refresh()` anywhere in this component.
 */
function EditableProductCell({
  productId,
  field,
  value,
  placeholder,
  ariaLabel,
  onSaved,
}: {
  productId: number;
  field: EditableField;
  /** The server's last-known value for this field, "" for null/empty. */
  value: string;
  placeholder: string;
  ariaLabel: string;
  onSaved: (updated: ProductSummary) => void;
}) {
  const [text, setText] = useState(value);
  const [status, setStatus] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-sync from the server-confirmed value when it changes underneath this
  // cell — e.g. a fresh `products` prop after real navigation (Amendment 2:
  // that's the only time a full refresh happens). Adjusted during render per
  // React's guidance (not a `useEffect`, which would cost an extra cascaded
  // render for the same update), and skipped while the cell is mid-edit so an
  // in-flight keystroke or save is never clobbered.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue && status !== "dirty" && status !== "saving") {
    setPrevValue(value);
    setText(value);
    setStatus("idle");
    setErrorMsg(null);
  }

  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
    };
  }, []);

  function handleChange(next: string) {
    setText(next);
    setErrorMsg(null);
    setStatus(next === value ? "idle" : "dirty");
  }

  async function commit() {
    if (status !== "dirty") return;

    const trimmed = text.trim();
    // Empty is honest; never coerce to 0/"" reaching the database (AGENTS.md
    // "Draft beer" note on plausible-but-wrong defaults; Risk 5).
    let payloadValue: string | number | null;

    if (trimmed === "") {
      payloadValue = null;
    } else if (field === "currentUnitCost") {
      // Same regex the server enforces (lib/validation/catalog.ts) for
      // instant feedback — the server call remains the source of truth.
      if (!unitCostSchema.safeParse(trimmed).success) {
        setStatus("error");
        setErrorMsg("Enter a dollar amount, like 21.50");
        return;
      }
      payloadValue = trimmed;
    } else {
      if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
        setStatus("error");
        setErrorMsg("Case size must be a positive whole number");
        return;
      }
      payloadValue = Number(trimmed);
    }

    setStatus("saving");
    setErrorMsg(null);

    try {
      const payload: Record<string, unknown> = { productId };
      payload[field] = payloadValue;
      const result = await updateProductAction(payload);

      if (!result.ok) {
        setStatus("error");
        setErrorMsg(result.error.fieldErrors?.[field] ?? result.error.message);
        setText(value); // revert to the last known-good value on a server-side refusal
        return;
      }

      onSaved(result.data);
      // Formatted the same way the incoming `value` prop is, or the cell would
      // snap from "21.50" to "21.5000" the moment it saved successfully.
      const settled =
        field === "currentUnitCost"
          ? formatCostForInput(result.data.currentUnitCost)
          : result.data.caseSize == null
            ? ""
            : String(result.data.caseSize);
      setText(settled);
      setStatus("saved");
      savedTimeoutRef.current = setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setText(value);
    }
  }

  const errorId = errorMsg ? `cell-error-${field}-${productId}` : undefined;

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <input
        type="text"
        inputMode={field === "currentUnitCost" ? "decimal" : "numeric"}
        value={text}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={status === "error" ? true : undefined}
        aria-describedby={errorId}
        disabled={status === "saving"}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className={cn(
          "min-h-tap-min w-28 rounded-md border border-input bg-card px-2 text-right text-body text-foreground placeholder:italic placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent",
          status === "dirty" && "border-accent",
          status === "saving" && "bg-muted text-muted-foreground",
          status === "error" && "border-negative",
        )}
      />
      {status === "dirty" ? (
        <span className="text-caption text-accent">Unsaved</span>
      ) : status === "saving" ? (
        <span className="text-caption text-muted-foreground">Saving…</span>
      ) : status === "saved" ? (
        <span className="text-caption text-muted-foreground">Saved</span>
      ) : status === "error" && errorMsg ? (
        <span id={errorId} role="alert" className="max-w-[9rem] text-right text-caption text-negative">
          {errorMsg}
        </span>
      ) : null}
    </div>
  );
}
