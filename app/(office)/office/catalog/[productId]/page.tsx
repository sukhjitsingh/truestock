import { notFound } from "next/navigation";
import { requireOfficeUser } from "@/lib/current-user";
import { getProductWithStockAction, listAllVendorsAction } from "@/app/actions/catalog";
import { formatProductSize } from "@/lib/bottle-sizes";
import { PageHeader } from "@/components/office/page-header";
import { ProductEditForm } from "@/components/office/product-edit-form";

export const metadata = { title: "Edit product · Truestock" };

/**
 * Product edit. This is where costs and case sizes actually get entered —
 * the workflow docs/open-items.md item 4 is waiting on — so it is the one
 * back-office screen the valuation half of the app depends on.
 */
export default async function ProductEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const user = await requireOfficeUser();
  const productId = Number((await params).productId);
  if (!Number.isInteger(productId) || productId <= 0) notFound();

  // One product by id, par and on-hand attached. This used to filter a capped
  // 100-row search, which 404'd every product past the 100th alphabetically
  // once the catalog grew (QA 2026-11-08).
  const [found, vendors] = await Promise.all([
    getProductWithStockAction({ productId }),
    listAllVendorsAction(),
  ]);
  if (!found.ok) notFound();
  const product = found.data;
  const { created } = await searchParams;

  return (
    <div className="max-w-2xl">
      <PageHeader title={`${product.name}, ${formatProductSize(product)}`} breadcrumb={{ label: "← Catalog", href: "/office/catalog" }} />
      {created === "1" ? (
        <p className="mt-4 rounded-md bg-success-bg px-3 py-2 text-caption text-success" role="status">
          Product added. Set its par level below so it shows up on the reorder list.
        </p>
      ) : null}

      <ProductEditForm
        product={product}
        // Active vendors plus this product's own vendor if retired; no other
        // retired vendor reaches the client.
        vendors={vendors.ok ? vendors.data.filter((v) => v.active || v.id === product.vendorId) : []}
        canEditCost={user.role === "owner"}
      />
    </div>
  );
}
