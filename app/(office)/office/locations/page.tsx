import { requireOfficeUser } from "@/lib/current-user";
import { listAllLocationsAction } from "@/app/actions/catalog";
import { LocationsTable } from "@/components/office/locations-table";

export const metadata = { title: "Locations · Truestock" };

/**
 * Slice 2 (docs/plans/phase-1-to-1.5/04-slices.md): locations CRUD. Swaps
 * slice 1's read-only render for `listAllLocationsAction()` (active +
 * retired — the management screen's own read, distinct from
 * `listLocationsAction`, which the scan-picker keeps using unchanged) and
 * `<LocationsTable>` for create/rename/re-mode.
 *
 * Authorization: `requireOfficeUser()` (also called by the `(office)`
 * layout — defence in depth, CLAUDE.md invariant 7) sends staff to
 * `/count` before this component ever renders. `listAllLocationsAction`
 * re-checks the role itself (owner/manager only) and scopes the query to
 * the caller's organization from `requireRole`, never from client input.
 */
export default async function LocationsPage() {
  await requireOfficeUser();
  const result = await listAllLocationsAction();

  const locations = result.ok ? result.data : [];

  return (
    <div>
      <h1 className="text-header-title">Locations</h1>
      <p className="mt-1 text-row-subtitle text-muted-foreground">
        Where counts happen. Speed Rail and Back Bar count in tenths; Storeroom counts by
        quantity.
      </p>

      {!result.ok ? (
        <p className="mt-6 rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
          {result.error.message}
        </p>
      ) : (
        <LocationsTable locations={locations} />
      )}
    </div>
  );
}
