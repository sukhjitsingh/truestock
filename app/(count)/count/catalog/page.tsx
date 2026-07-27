import { requireUser } from "@/lib/current-user";
import { CountCatalogSearch } from "@/components/count/catalog-search";

export const metadata = { title: "Catalog · Truestock" };

/**
 * Read-only product lookup from the phone — "do we already carry this?"
 * mid-shift, without opening a count.
 *
 * Deliberately does NOT request `includeOnHand`. On-hand comes from the last
 * closed count, so on this device it would be answering a question nobody
 * asked with a number that is stale by definition; the back-office catalog
 * is where that figure belongs. Keeping it off also keeps this on the same
 * single-indexed-lookup path the count-time picker uses.
 */
export default async function CountCatalogPage() {
  await requireUser();

  return (
    <div className="px-bar-pad pb-8 pt-6">
      <h1 className="text-header-title text-foreground">Catalog</h1>
      <p className="mt-1 text-row-subtitle text-muted-foreground">
        Look up a product. To count one, open a count.
      </p>
      <CountCatalogSearch />
    </div>
  );
}
