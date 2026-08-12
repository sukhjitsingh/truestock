import { requireOfficeUser } from "@/lib/current-user";
import { listLocationsAction } from "@/app/actions/catalog";

export const metadata = { title: "Locations · Truestock" };

const countModeLabel: Record<string, string> = {
  tenths: "Tenths",
  quantity: "Quantity",
};

/**
 * Slice 1 tracer bullet (docs/plans/phase-1-to-1.5/04-slices.md): the route
 * exists, is in the nav, and renders the five seeded locations read-only via
 * the *existing, unchanged* `listLocationsAction()`. No create, edit,
 * retire, or `active` column here — those land in slices 2 and 3.
 *
 * Authorization: `requireOfficeUser()` (called by the `(office)` layout,
 * called again here per CLAUDE.md invariant 7 — defence in depth, not only
 * middleware) sends staff to `/count` before this component ever renders.
 * `listLocationsAction` re-checks the role itself and scopes the query to
 * the caller's organization from `requireRole`, never from client input.
 */
export default async function LocationsPage() {
  await requireOfficeUser();
  const result = await listLocationsAction();

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
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-2 text-label uppercase text-muted-foreground">
                  Name
                </th>
                <th scope="col" className="py-2 text-label uppercase text-muted-foreground">
                  Counting mode
                </th>
                <th scope="col" className="py-2 text-right text-label uppercase text-muted-foreground">
                  Sort order
                </th>
              </tr>
            </thead>
            <tbody>
              {locations.map((loc) => (
                <tr key={loc.id} className="border-b border-border">
                  <td className="py-3 text-row-subtitle font-semibold text-foreground">
                    {loc.name}
                  </td>
                  <td className="py-3 text-row-subtitle text-muted-foreground">
                    {countModeLabel[loc.countMode] ?? loc.countMode}
                  </td>
                  <td className="py-3 text-right text-row-subtitle tabular-nums text-muted-foreground">
                    {loc.sortOrder}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
