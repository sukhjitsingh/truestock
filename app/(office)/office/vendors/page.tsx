import { requireOfficeUser } from "@/lib/current-user";
import { listVendorsAction } from "@/app/actions/catalog";
import { VendorsList } from "@/components/office/vendors-list";

export const metadata = { title: "Vendors · Truestock" };

/**
 * Vendors back-office screen.
 *
 * Lists all vendors for the organization, with the ability to create new ones.
 * The empty state is emphasized — vendors drive reorder grouping (spec §9.3),
 * and every reorder row groups under "No vendor set" until at least one vendor
 * exists. An empty state that merely says "None exist" misses the chance to
 * explain what vendors DO, which matters when the screen is visited for the
 * first time and nobody knows why they should exist.
 *
 * Authorization (CLAUDE.md invariant 7): requires office user + owner/manager
 * role. The requireOfficeUser check at the page level gates access; specific
 * role checks live in the server actions that create/update vendors (gated to
 * owner/manager in lib/authz.ts).
 */
export default async function VendorsPage() {
  await requireOfficeUser();
  const result = await listVendorsAction();

  const vendors = result.ok ? result.data : [];

  return (
    <div>
      <h1 className="text-header-title">Vendors</h1>
      <p className="mt-1 text-row-subtitle text-muted-foreground">
        Suppliers for products and reorder grouping.
      </p>

      {!result.ok ? (
        <p className="mt-6 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {result.error.message}
        </p>
      ) : (
        <VendorsList vendors={vendors} />
      )}
    </div>
  );
}
