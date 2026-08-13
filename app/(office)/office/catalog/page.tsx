import { requireOfficeUser } from "@/lib/current-user";
import { searchProductsAction, listVendorsAction } from "@/app/actions/catalog";
import { lastClosedCountAction } from "@/app/actions/reports";
import { PageHeader } from "@/components/office/page-header";
import { CatalogTable } from "@/components/office/catalog-table";
import { formatDate } from "@/lib/utils";

export const metadata = { title: "Catalog · Truestock" };

/**
 * The catalog. Loads with stock figures attached (`includeOnHand`), which is
 * the opt-in the count-time product picker deliberately does not take — see
 * `searchProducts` in lib/domain/catalog.ts.
 *
 * Staff users see the catalog table without checkboxes or bulk vendor
 * assignment (invariant 7: authorization gated in the page, not just in
 * button disabled state).
 */
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; view?: string }>;
}) {
  const user = await requireOfficeUser();
  const { q, view } = await searchParams;

  const [productResult, vendorResult, lastClosedResult] = await Promise.all([
    searchProductsAction({
      query: q,
      limit: 100,
      activeOnly: true,
      includeOnHand: true,
    }),
    listVendorsAction(),
    lastClosedCountAction(),
  ]);

  const products = productResult.ok ? productResult.data : [];
  const vendors = vendorResult.ok ? vendorResult.data : [];
  const needsAttention = view === "attention";
  const shown = needsAttention ? products.filter((p) => p.incomplete.length > 0) : products;
  // On-hand figures below are a single shared snapshot — every row's stock
  // comes from the same last-closed count, so this is one page-level note
  // rather than a per-row label (spec §4: "as of count #N", never "Current").
  const lastClosed = lastClosedResult.ok ? lastClosedResult.data : null;

  return (
    <div>
      <PageHeader
        title="Catalog"
        subtitle={
          <div className="flex flex-col gap-1">
            <p className="text-row-subtitle text-muted-foreground">
              {products.length} active products &middot;{" "}
              {products.filter((p) => p.incomplete.length > 0).length} need attention
            </p>
            <p className="text-caption text-muted-foreground">
              {lastClosed ? (
                <>
                  On-hand as of count #{lastClosed.id} &middot; {formatDate(lastClosed.closedAt)}
                </>
              ) : (
                "On-hand figures need a closed count — none has closed yet."
              )}
            </p>
          </div>
        }
      />

      {!productResult.ok ? (
        <p className="mt-6 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {productResult.error.message}
        </p>
      ) : (
        <CatalogTable
          products={shown}
          query={q ?? ""}
          view={needsAttention ? "attention" : "all"}
          canSeeCost={user.role === "owner"}
          canEditCost={user.role === "owner"}
          vendors={vendors}
          userRole={user.role}
        />
      )}
    </div>
  );
}
