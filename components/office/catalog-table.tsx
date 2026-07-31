"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useEffect, useMemo, useState } from "react";
import { cn, formatUnits } from "@/lib/utils";
import { Money } from "@/components/ui/money";
import { StatusPill } from "@/components/ui/status-pill";
import { Button } from "@/components/ui/button";
import { assignVendorToProductsAction } from "@/app/actions/catalog";
import type { ProductSummary, ProductIncompleteReason, VendorSummary } from "@/lib/domain/catalog";

const REASON_LABEL: Record<ProductIncompleteReason, string> = {
  needs_producer: "Needs producer",
  needs_case_size: "Needs case size",
  needs_cost: "Needs cost",
  // Attached by `attachStock`, so it only appears where stock was asked for —
  // which is this table. A product with no par can never reach the reorder
  // list, and nothing else anywhere says so.
  needs_par: "Needs par",
};

/**
 * The catalog table.
 *
 * The cost column is built per role — a manager's `columns` array does not
 * contain it, rather than containing it filtered or hidden (design-system.md,
 * binding rule). The server already omits `currentUnitCost` from their
 * payload, so this is the matching half of a gate that is enforced twice.
 *
 * "Needs attention" is a derived predicate computed server-side
 * (lib/domain/catalog.ts), not a stored flag and not something this table
 * re-invents from category plus a null brand the way the prototype did.
 *
 * Bulk vendor assignment is owner/manager only (staff gets no checkboxes or
 * action bar at all — CLAUDE.md invariant 7, gated in page, not just in button
 * disabled state). Visible when one or more products are selected.
 */
export function CatalogTable({
  products,
  query,
  view,
  canSeeCost,
  vendors,
  userRole,
}: {
  products: ProductSummary[];
  query: string;
  view: "all" | "attention";
  canSeeCost: boolean;
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

  const canManage = userRole === "owner" || userRole === "manager";

  // Track which products are currently visible (after filtering by search/view).
  // Use a derived check rather than a stored list so the UI stays in sync.
  // Wrapped in useMemo to keep dependency stable in useEffect below.
  const visibleIds = useMemo(() => new Set(products.map((p) => p.id)), [products]);

  // When the product list changes (search query, view filter, navigation), prune
  // selectedIds to only include products still visible. This prevents a bulk
  // vendor write from applying to off-screen products—a silent failure where the
  // manager sees a count for rows they believe they selected, but the ids actually
  // belong to products that are no longer displayed.
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

  function navigate(next: { q?: string; view?: string }) {
    const search = new URLSearchParams(params.toString());
    for (const [key, v] of Object.entries(next)) {
      if (v) search.set(key, v);
      else search.delete(key);
    }
    router.push(`/office/catalog?${search.toString()}`);
  }

  function toggleProduct(id: number) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
    setAssignError(null);
  }

  function selectAllVisible() {
    setSelectedIds(new Set(visibleIds));
    setAssignError(null);
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setAssignError(null);
  }

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

  return (
    <div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate({ q: value, view: view === "attention" ? "attention" : undefined });
          }}
          className="flex min-w-[16rem] flex-1 items-center gap-2 rounded-md border border-input bg-card px-4"
        >
          <input
            type="search"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Search name or brand"
            aria-label="Search catalog"
            className="min-h-tap-min min-w-0 flex-1 bg-transparent text-body text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </form>

        <div className="flex gap-1 rounded-md bg-muted p-1">
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
              aria-pressed={view === tab.key}
              className={cn(
                "min-h-tap-min rounded-sm px-3 text-label uppercase",
                view === tab.key
                  ? "bg-accent text-accent-foreground"
                  : "bg-transparent text-muted-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

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

      {products.length === 0 ? (
        <p className="mt-6 text-row-subtitle text-muted-foreground">
          {view === "attention"
            ? "Nothing needs attention."
            : "No products match that search."}
        </p>
      ) : (
        <>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-border">
                  {canManage ? (
                    <th scope="col" className="py-2 px-1 text-center">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        onChange={(e) =>
                          e.currentTarget.checked ? selectAllVisible() : clearSelection()
                        }
                        aria-label={`Select all ${visibleIds.size} visible products`}
                        className="h-4 w-4 cursor-pointer"
                      />
                    </th>
                  ) : null}
                  <th scope="col" className="py-2 text-label uppercase text-muted-foreground">
                    Product
                  </th>
                  <th scope="col" className="py-2 text-label uppercase text-muted-foreground">
                    Category
                  </th>
                  <th scope="col" className="py-2 text-right text-label uppercase text-muted-foreground">
                    On hand
                  </th>
                  {canSeeCost ? (
                    <th
                      scope="col"
                      className="py-2 text-right text-label uppercase text-muted-foreground"
                    >
                      Unit cost
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id} className="border-b border-border align-top">
                    {canManage ? (
                      <td className="py-3 px-1 text-center">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(product.id)}
                          onChange={() => toggleProduct(product.id)}
                          aria-label={`Select ${product.name}`}
                          className="h-4 w-4 cursor-pointer"
                        />
                      </td>
                    ) : null}
                    <td className="py-3">
                      <Link
                        href={`/office/catalog/${product.id}`}
                        className="block text-row-subtitle font-semibold text-foreground underline"
                      >
                        {product.name}
                      </Link>
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
                    </td>
                    <td className="py-3 text-row-subtitle text-muted-foreground">
                      {product.category}
                    </td>
                    <td className="py-3 text-right">
                      <StockCell product={product} />
                    </td>
                    {canSeeCost ? (
                      <td className="py-3 text-right">
                        {product.currentUnitCost ? (
                          <Money value={Number(product.currentUnitCost)} />
                        ) : (
                          <span className="text-caption text-muted-foreground">not set</span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
        </>
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

function StockCell({ product }: { product: ProductSummary }) {
  const stock = product.stock;
  if (!stock) return null;

  // No closed count yet — "never counted" is not "zero on hand", and showing
  // a 0 here would read as an urgent stockout across the whole catalog.
  if (stock.onHand == null) {
    return <span className="text-caption text-muted-foreground">no closed count</span>;
  }

  const pct =
    stock.parLevel && stock.parLevel > 0
      ? Math.min(100, Math.round((stock.onHand / stock.parLevel) * 100))
      : null;

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <span className="text-numeral-sm tabular-nums text-foreground">
        {formatUnits(stock.onHand)}
        {stock.onHandIsPartial ? "+" : ""}
      </span>
      {stock.onHandIsPartial ? (
        <span className="text-caption text-warning">at least — case size missing</span>
      ) : null}
      {pct != null ? (
        <>
          <span className="block h-1 w-20 overflow-hidden rounded-full bg-muted">
            <span
              className={cn("block h-full", pct < 50 ? "bg-warning" : "bg-success")}
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="text-caption text-muted-foreground">par {stock.parLevel}</span>
        </>
      ) : null}
    </div>
  );
}
