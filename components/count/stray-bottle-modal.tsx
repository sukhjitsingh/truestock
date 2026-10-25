"use client";

import { useEffect, useState } from "react";
import { X, Search } from "lucide-react";
import { searchProductsAction } from "@/app/actions/catalog";
import type { LocationSummary, ProductSummary } from "@/lib/domain/catalog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface StrayBottleModalProps {
  isOpen: boolean;
  activeLocationId: number;
  locations: LocationSummary[];
  onClose: () => void;
  onRecordStray: (targetLocationId: number, product: ProductSummary) => void;
}

/**
 * Stray Bottle Escape Hatch Modal (spec §5, prototypes/count-scan.html)
 *
 * Allows a counter to record an out-of-place bottle found on the floor into an
 * alternate location without mutating the locked session station.
 */
export function StrayBottleModal({ isOpen, ...rest }: StrayBottleModalProps) {
  // The stateful body only exists while the modal is open, so every open
  // starts from a clean query, result list and destination without any
  // "reset when closed" effect. (That effect re-ran on every render — the
  // filtered locations array is a new reference each time — and its
  // `setResults([])` is a new reference too, so a closed modal re-rendered in
  // a loop.)
  if (!isOpen) return null;
  return <StrayBottleModalBody {...rest} />;
}

function StrayBottleModalBody({
  activeLocationId,
  locations,
  onClose,
  onRecordStray,
}: Omit<StrayBottleModalProps, "isOpen">) {
  const eligibleLocations = locations.filter((l) => l.id !== activeLocationId);
  // No preselected destination, on purpose. A wrong location fails silently
  // (AGENTS.md, "active location is locked per leg"): the bottle lands on a real
  // line in the wrong place and nothing looks broken. A default of
  // `eligibleLocations[0]` is exactly a plausible-but-wrong default for anyone
  // who taps a product without reading step 1, so the counter has to choose.
  const [targetLocationId, setTargetLocationId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSearch = async (val: string) => {
    setQuery(val);
    if (val.trim().length < 2) {
      setResults([]);
      setOffline(false);
      return;
    }
    setLoading(true);
    try {
      const found = await searchProductsAction({ query: val, limit: 10 });
      if (found.ok) {
        setResults(found.data);
        setOffline(false);
      }
    } catch {
      // Offline. Say so rather than falling through to "No matching products
      // found" — that is an answer about the catalog, and the catalog was never
      // consulted.
      setResults([]);
      setOffline(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="stray-modal-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <div className="w-full max-w-lg rounded-t-2xl border border-border bg-card p-card-pad shadow-2xl sm:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div>
            <h2 id="stray-modal-title" className="text-row-title text-card-foreground">
              Count a stray bottle elsewhere
            </h2>
            <p className="text-caption text-muted-foreground">
              Records one bottle into another section. You return here afterward.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="flex size-tap-min items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>

        {/* Step 1: Pick Destination Location */}
        <div className="mt-4">
          <label className="block text-label uppercase text-muted-foreground">
            1. Destination section
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            {eligibleLocations.map((loc) => {
              const isSelected = targetLocationId === loc.id;
              return (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => setTargetLocationId(loc.id)}
                  className={cn(
                    "min-h-tap-min rounded-full border px-4 text-label uppercase transition-colors",
                    isSelected
                      ? "border-accent bg-accent text-accent-foreground font-bold shadow-sm"
                      : "border-input bg-muted/60 text-foreground hover:bg-muted",
                  )}
                >
                  {loc.name}
                </button>
              );
            })}
          </div>
        </div>

        {/* Step 2: Search Product */}
        <div className="mt-4">
          <label htmlFor="stray-search-input" className="block text-label uppercase text-muted-foreground">
            2. Find product
          </label>
          <div className="mt-2 flex h-tap-min items-center gap-2 rounded-md border border-input bg-background px-3 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50">
            <Search className="size-4 text-muted-foreground" aria-hidden="true" />
            <input
              id="stray-search-input"
              type="search"
              autoFocus
              value={query}
              onChange={(e) => void handleSearch(e.target.value)}
              placeholder="Search product name or brand…"
              className="min-w-0 flex-1 bg-transparent text-body text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>

          {targetLocationId == null ? (
            <p className="mt-2 text-caption text-muted-foreground">
              Pick a destination section first, then tap the product.
            </p>
          ) : null}

          {/* Search Results */}
          <div className="mt-3 max-h-60 overflow-y-auto">
            {loading ? (
              <p className="py-3 text-center text-caption text-muted-foreground">Searching…</p>
            ) : offline ? (
              <p className="py-3 text-center text-caption text-warning" role="alert">
                Offline — can&rsquo;t search the catalog from here. Move back into WiFi range.
              </p>
            ) : results.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {results.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    disabled={targetLocationId == null}
                    onClick={() => {
                      if (targetLocationId != null) {
                        onRecordStray(targetLocationId, product);
                        onClose();
                      }
                    }}
                    className="flex min-h-tap-min flex-col justify-center rounded-lg border border-border bg-muted/30 p-2.5 text-left transition-colors hover:bg-muted active:bg-muted/80 disabled:opacity-50"
                  >
                    <span className="text-row-subtitle font-semibold text-foreground">
                      {product.name}
                    </span>
                    <span className="text-caption text-muted-foreground">
                      {product.unitType === "keg" ? "Keg" : `${product.sizeMl}ml`}
                      {product.brand ? ` · ${product.brand}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            ) : query.trim().length >= 2 ? (
              <p className="py-3 text-center text-caption text-muted-foreground">
                No matching products found in catalog.
              </p>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-5 border-t border-border pt-3">
          <Button
            type="button"
            variant="outline"
            size="primary"
            className="w-full text-label uppercase"
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
