import { requireOfficeUser } from "@/lib/current-user";
import { reorderListAction } from "@/app/actions/reports";
import { formatUnits } from "@/lib/utils";

export const metadata = { title: "Reorder · Handlebar" };

/**
 * The reorder list (spec §9.3), grouped by vendor.
 *
 * No cost data appears here at all — par levels and quantities are the only
 * inputs — so there is nothing to gate beyond the owner/manager check the
 * action already makes. A manager running the order does not need prices to
 * know what is short.
 */
export default async function ReorderPage() {
  await requireOfficeUser();
  const result = await reorderListAction();

  if (!result.ok) {
    return (
      <p className="rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
        {result.error.message}
      </p>
    );
  }

  const { asOfCountId, items } = result.data;

  // Group by vendor. `reorderList` already sorts so same-vendor items are
  // adjacent, so this is a walk, not a re-sort.
  const groups: { vendor: string; items: typeof items }[] = [];
  for (const item of items) {
    const vendor = item.vendorName ?? "No vendor set";
    const last = groups[groups.length - 1];
    if (last && last.vendor === vendor) last.items.push(item);
    else groups.push({ vendor, items: [item] });
  }

  return (
    <div>
      <h1 className="text-header-title">Reorder</h1>
      {asOfCountId == null ? (
        <p className="mt-4 text-row-subtitle text-muted-foreground">
          Nothing to suggest yet — on-hand comes from the most recent{" "}
          <strong className="text-foreground">closed</strong> count, and there isn&rsquo;t one.
          An in-progress count can&rsquo;t be used: every section not yet walked would read as
          zero and put the whole catalog on this list.
        </p>
      ) : (
        <p className="mt-1 text-row-subtitle text-muted-foreground">
          On hand as of count #{asOfCountId} &middot; {items.length}{" "}
          {items.length === 1 ? "item" : "items"} at or below par
        </p>
      )}

      {items.length === 0 && asOfCountId != null ? (
        <p className="mt-6 text-row-subtitle text-muted-foreground">
          Nothing is below its reorder point.
        </p>
      ) : null}

      <div className="mt-8 flex flex-col gap-section-gap">
        {groups.map((group) => (
          <section key={group.vendor}>
            <h2 className="mb-3 text-label uppercase text-muted-foreground">{group.vendor}</h2>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 text-label uppercase text-muted-foreground">
                    Product
                  </th>
                  <th scope="col" className="py-2 text-right text-label uppercase text-muted-foreground">
                    On hand
                  </th>
                  <th scope="col" className="py-2 text-right text-label uppercase text-muted-foreground">
                    Par
                  </th>
                  <th scope="col" className="py-2 text-right text-label uppercase text-muted-foreground">
                    Order
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.items.map((item) => (
                  <tr key={item.productId} className="border-b border-border">
                    <td className="py-3 text-row-subtitle text-foreground">
                      {item.productName}
                      <span className="ml-2 text-caption text-muted-foreground">
                        {item.category}
                      </span>
                    </td>
                    <td className="py-3 text-right text-row-subtitle tabular-nums text-muted-foreground">
                      {formatUnits(item.onHand)}
                    </td>
                    <td className="py-3 text-right text-row-subtitle tabular-nums text-muted-foreground">
                      {formatUnits(item.parLevel)}
                    </td>
                    <td className="py-3 text-right text-numeral-sm tabular-nums text-foreground">
                      {formatUnits(item.suggestedOrderQty)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}
