"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { cn, formatUnits } from "@/lib/utils";
import { Money } from "@/components/ui/money";
import { StatusPill } from "@/components/ui/status-pill";
import type { ProductSummary, ProductIncompleteReason } from "@/lib/domain/catalog";

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
 */
export function CatalogTable({
  products,
  query,
  view,
  canSeeCost,
}: {
  products: ProductSummary[];
  query: string;
  view: "all" | "attention";
  canSeeCost: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState(query);

  function navigate(next: { q?: string; view?: string }) {
    const search = new URLSearchParams(params.toString());
    for (const [key, v] of Object.entries(next)) {
      if (v) search.set(key, v);
      else search.delete(key);
    }
    router.push(`/office/catalog?${search.toString()}`);
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

      {products.length === 0 ? (
        <p className="mt-6 text-row-subtitle text-muted-foreground">
          {view === "attention"
            ? "Nothing needs attention."
            : "No products match that search."}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[48rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-border">
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
      )}
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
