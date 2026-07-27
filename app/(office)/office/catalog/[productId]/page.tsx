import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOfficeUser } from "@/lib/current-user";
import { searchProductsAction, listVendorsAction } from "@/app/actions/catalog";
import { ProductEditForm } from "@/components/office/product-edit-form";

export const metadata = { title: "Edit product · Truestock" };

/**
 * Product edit. This is where costs and case sizes actually get entered —
 * the workflow docs/open-items.md item 4 is waiting on — so it is the one
 * back-office screen the valuation half of the app depends on.
 */
export default async function ProductEditPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const user = await requireOfficeUser();
  const productId = Number((await params).productId);
  if (!Number.isInteger(productId) || productId <= 0) notFound();

  // There is no getProduct(id) read; searchProducts is the catalog read and
  // returns the same role-shaped summary. Rather than add a near-duplicate
  // domain function, this filters the list — 97 products, one indexed query.
  const [all, vendors] = await Promise.all([
    searchProductsAction({ limit: 100, activeOnly: false }),
    listVendorsAction(),
  ]);
  if (!all.ok) notFound();

  const product = all.data.find((p) => p.id === productId);
  if (!product) notFound();

  return (
    <div className="max-w-2xl">
      <Link href="/office/catalog" className="text-caption text-muted-foreground underline">
        ← Catalog
      </Link>
      <h1 className="mt-2 text-header-title">{product.name}</h1>

      <ProductEditForm
        product={product}
        vendors={vendors.ok ? vendors.data : []}
        canEditCost={user.role === "owner"}
      />
    </div>
  );
}
