"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { searchProductsAction } from "@/app/actions/catalog";
import type { ProductSummary } from "@/lib/domain/catalog";
import { CardStack, Card } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";

export function CountCatalogSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSummary[]>([]);
  const [searched, setSearched] = useState(false);

  async function run(value: string) {
    setQuery(value);
    if (value.trim().length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    const found = await searchProductsAction({ query: value, limit: 25 });
    if (found.ok) {
      setResults(found.data);
      setSearched(true);
    }
  }

  return (
    <div className="mt-section-gap">
      <div className="flex h-tap-min items-center gap-2 rounded-md border border-input bg-card px-4">
        <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => void run(e.target.value)}
          placeholder="Search products"
          aria-label="Search products"
          className="min-w-0 flex-1 bg-transparent text-body text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>

      <div className="mt-4">
        {searched && results.length === 0 ? (
          <p className="text-row-subtitle text-muted-foreground">
            Nothing matches. It may not be in the catalog yet — scanning it during a count
            enrolls it.
          </p>
        ) : (
          <CardStack>
            {results.map((product) => (
              <Card key={product.id}>
                <p className="text-row-title text-card-foreground">{product.name}</p>
                <p className="text-row-subtitle text-muted-foreground">
                  {product.unitType === "keg" ? "Keg" : `${product.sizeMl}ml`} &middot;{" "}
                  {product.category}
                  {product.brand ? ` · ${product.brand}` : ""}
                </p>
                {product.incomplete.includes("needs_producer") ? (
                  <StatusPill tone="warning" className="mt-2">
                    Needs producer
                  </StatusPill>
                ) : null}
              </Card>
            ))}
          </CardStack>
        )}
      </div>
    </div>
  );
}
