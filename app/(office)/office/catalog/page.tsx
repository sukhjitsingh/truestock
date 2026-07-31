import { requireOfficeUser } from "@/lib/current-user";
import { searchProductsAction, listVendorsAction } from "@/app/actions/catalog";
import { CatalogTable } from "@/components/office/catalog-table";

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

  const [productResult, vendorResult] = await Promise.all([
    searchProductsAction({
      query: q,
      limit: 100,
      activeOnly: true,
      includeOnHand: true,
    }),
    listVendorsAction(),
  ]);

  const products = productResult.ok ? productResult.data : [];
  const vendors = vendorResult.ok ? vendorResult.data : [];
  const needsAttention = view === "attention";
  const shown = needsAttention ? products.filter((p) => p.incomplete.length > 0) : products;

  return (
    <div>
      <h1 className="text-header-title">Catalog</h1>
      <p className="mt-1 text-row-subtitle text-muted-foreground">
        {products.length} active products &middot;{" "}
        {products.filter((p) => p.incomplete.length > 0).length} need attention
      </p>

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
          vendors={vendors}
          userRole={user.role}
        />
      )}
    </div>
  );
}
