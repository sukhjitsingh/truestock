import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/current-user";
import { CountCatalogSearch } from "@/components/count/catalog-search";

export const metadata = { title: "Catalog · Truestock" };

/**
 * Mobile Catalog Lookup (`/count/catalog`, Target 12)
 *
 * Read-only product lookup and scan-to-enroll from mobile.
 */
export default async function CountCatalogPage() {
  await requireUser();

  return (
    <div className="px-bar-pad pb-action-bar pt-4">
      {/* Top Header Bar */}
      <header className="flex items-center justify-between border-b border-border/60 pb-3.5">
        <Link
          href="/count"
          aria-label="Back to Floor Count Hub"
          className="flex size-11 items-center justify-center rounded-full border border-border/80 bg-card/85 text-foreground backdrop-blur-md shadow-xs transition-all hover:border-accent/40 active:scale-95"
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </Link>
        <span className="text-screen-title font-semibold uppercase tracking-wider text-foreground">
          Mobile Catalog
        </span>
        <div className="size-11" aria-hidden="true" />
      </header>

      {/* Screen Title & Subtitle */}
      <div className="pt-4">
        <h1 className="text-header-title text-foreground">Catalog Lookup</h1>
        <p className="mt-0.5 text-row-subtitle text-muted-foreground">
          Search items or scan barcodes to look up and enroll products
        </p>
      </div>

      <CountCatalogSearch />
    </div>
  );
}

