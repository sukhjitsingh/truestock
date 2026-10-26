"use client";

import { useState } from "react";
import { Search, ScanLine } from "lucide-react";
import { searchProductsAction, resolveBarcodeAction } from "@/app/actions/catalog";
import type { ProductSummary } from "@/lib/domain/catalog";
import { CardStack, GlyphTile, monogram } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import { BarcodeScanner } from "@/components/count/barcode-scanner";
import { EnrollForm } from "@/components/count/enroll-form";

const CATEGORY_GLYPH: Record<string, string> = {
  Spirits: "SP",
  Beer: "BE",
  Wine: "WI",
  Liqueur: "LQ",
  NA: "NA",
};

function glyphFor(product: ProductSummary): string {
  if (product.unitType === "keg") return "KG";
  return CATEGORY_GLYPH[product.category] ?? monogram(product.name);
}

/**
 * Mobile Catalog Search Surface (`CountCatalogSearch`, Target 12)
 *
 * Provides:
 * 1. Fast debounce-free product search.
 * 2. In-field camera scan trigger + BarcodeScanner modal.
 * 3. Scan-to-enroll: a barcode that the server confirms is unknown opens
 *    EnrollForm. There is deliberately no barcode-less "Add" button here —
 *    EnrollForm binds a scanned barcode to a product, and with an empty one the
 *    create call is rejected by the barcode schema (min length 4). Products with
 *    no usable barcode are added from the back office catalog.
 * 4. Glassmorphic product cards with category glyphs and status pills.
 */
export function CountCatalogSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSummary[]>([]);
  const [searched, setSearched] = useState(false);
  const [offline, setOffline] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [enrollingBarcode, setEnrollingBarcode] = useState<string | null>(null);
  // A scan whose lookup could not be completed (offline, or the server refused).
  // Kept apart from `offline`, which is about the search box.
  const [scanError, setScanError] = useState<string | null>(null);

  async function run(value: string) {
    setQuery(value);
    if (value.trim().length < 2) {
      setResults([]);
      setSearched(false);
      setOffline(false);
      return;
    }
    try {
      const found = await searchProductsAction({ query: value, limit: 25 });
      if (found.ok) {
        setResults(found.data);
        setSearched(true);
        setOffline(false);
      }
    } catch {
      setResults([]);
      setSearched(false);
      setOffline(true);
    }
  }

  async function handleBarcodeDetected(barcode: string) {
    setScannerOpen(false);
    setScanError(null);
    try {
      const res = await resolveBarcodeAction({ barcode });
      if (res.ok && res.data) {
        setQuery(res.data.product.name);
        setResults([res.data.product]);
        setSearched(true);
        setOffline(false);
      } else if (res.ok) {
        // The server looked and the barcode is genuinely unknown -> enroll it.
        setEnrollingBarcode(barcode);
      } else {
        // A refused lookup is not an answer about the catalog. Opening the enroll
        // form here would offer to create a duplicate of a product that may well
        // already carry this barcode.
        setScanError(res.error.message);
      }
    } catch {
      // Offline, same reasoning: the catalog was never consulted, so "unknown
      // barcode" would be a claim nobody checked.
      setScanError("Offline — can’t look that barcode up from here. Move back into WiFi range and scan again.");
    }
  }

  if (enrollingBarcode !== null) {
    return (
      <EnrollForm
        barcode={enrollingBarcode}
        onCancel={() => setEnrollingBarcode(null)}
        onResolved={(product) => {
          setEnrollingBarcode(null);
          setQuery(product.name);
          setResults([product]);
          setSearched(true);
        }}
      />
    );
  }

  return (
    <div className="mt-4">
      {/* Action Header Controls */}
      <div className="flex items-center gap-2">
        <div className="flex h-tap-min flex-1 items-center gap-2 rounded-xl border border-input bg-card/90 px-3.5 backdrop-blur-md shadow-xs focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/50">
          <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => void run(e.target.value)}
            placeholder="Search catalog products…"
            aria-label="Search products"
            className="min-w-0 flex-1 bg-transparent text-body text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            aria-label="Scan barcode to find product"
            className="-mr-2 flex size-tap-min shrink-0 items-center justify-center rounded-lg text-accent transition-colors hover:bg-muted active:scale-95"
          >
            <ScanLine className="size-5" aria-hidden="true" />
          </button>
        </div>

      </div>

      {/* Barcode Scanner Modal */}
      {scannerOpen ? (
        <BarcodeScanner
          onDetected={handleBarcodeDetected}
          onClose={() => setScannerOpen(false)}
        />
      ) : null}

      {scanError ? (
        <p className="mt-4 text-row-subtitle text-warning" role="alert">
          {scanError}
        </p>
      ) : null}

      {/* Results Container */}
      <div className="mt-4">
        {offline ? (
          <div className="glass-card p-card-pad text-warning" role="alert">
            <p className="font-semibold">Offline</p>
            <p className="mt-1 text-row-subtitle text-muted-foreground">
              Cannot search the catalog from here. Move back into Wi-Fi range and try again.
            </p>
          </div>
        ) : searched && results.length === 0 ? (
          <div className="glass-card p-card-pad text-center py-6">
            <p className="text-row-title font-semibold text-card-foreground">No Products Found</p>
            <p className="mt-1 text-row-subtitle text-muted-foreground">
              Nothing matches &ldquo;{query}&rdquo;. It may not be in the catalog yet &mdash;
              scanning it during a count enrolls it.
            </p>
          </div>
        ) : (
          <CardStack>
            {results.map((product) => (
              <div
                key={product.id}
                className="glass-card flex items-start gap-3 p-card-pad"
              >
                <GlyphTile className="text-numeral-md font-bold">{glyphFor(product)}</GlyphTile>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-row-title font-bold text-card-foreground">
                    {product.name}
                  </p>
                  <p className="truncate text-row-subtitle text-muted-foreground">
                    {product.unitType === "keg" ? "Keg" : `${product.sizeMl}ml`} &middot;{" "}
                    {product.category}
                    {product.brand ? ` · ${product.brand}` : ""}
                  </p>
                  {product.incomplete.includes("needs_producer") ? (
                    <StatusPill tone="warning" className="mt-2">
                      Needs producer
                    </StatusPill>
                  ) : null}
                </div>
              </div>
            ))}
          </CardStack>
        )}
      </div>
    </div>
  );
}

