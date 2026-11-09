import { requireOfficeUser } from "@/lib/current-user";
import { listVendorsAction } from "@/app/actions/catalog";
import { PageHeader } from "@/components/office/page-header";
import { ProductCreateForm } from "@/components/office/product-create-form";

export const metadata = { title: "Add product · Truestock" };

/**
 * Back-office product creation (QA 2026-11-08). The phone can only create a
 * product from an unknown barcode; this is the path for everything that has
 * none. Authorization is the page gate here and `createProductAction`'s own
 * `requireRole` on the write (invariant 7).
 */
export default async function NewProductPage() {
  const user = await requireOfficeUser();
  const vendors = await listVendorsAction();

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Add product"
        breadcrumb={{ label: "← Catalog", href: "/office/catalog" }}
        subtitle={
          <p className="text-row-subtitle text-muted-foreground">
            For products without a usable barcode, or to set one up before the next count. Par and reorder point are
            set on the next screen.
          </p>
        }
      />
      <ProductCreateForm vendors={vendors.ok ? vendors.data : []} canEditCost={user.role === "owner"} />
    </div>
  );
}
