import Link from "next/link";
import { requireOfficeUser } from "@/lib/current-user";
import { reorderListAction } from "@/app/actions/reports";
import { formatUnits } from "@/lib/utils";

export const metadata = { title: "Reorder · Truestock" };

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

  const { asOfCountId, items, productsWithPar } = result.data;

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

      {/*
        Two very different empty states, deliberately not sharing a message.
        "Nothing is short" is good news. "No product has a par" means this
        screen cannot produce a row no matter how empty the shelves get — and
        for as long as par levels were unwritable, it printed the good-news
        version. A finished-looking screen reporting a confident wrong answer
        is the failure mode CLAUDE.md's invariants exist to prevent, and it
        does not stop being one just because the sentence is grammatical.
      */}
      {items.length === 0 && asOfCountId != null ? (
        productsWithPar === 0 ? (
          <p className="mt-6 max-w-prose text-row-subtitle text-muted-foreground">
            No product has a par level yet, so nothing can appear here. Set one on a
            product in the{" "}
            <Link href="/office/catalog" className="text-foreground underline">
              catalog
            </Link>{" "}
            — the products missing one are tagged{" "}
            <strong className="text-foreground">Needs par</strong>.
          </p>
        ) : (
          <p className="mt-6 text-row-subtitle text-muted-foreground">
            Nothing is below its reorder point.{" "}
            <span className="text-caption">
              ({productsWithPar} {productsWithPar === 1 ? "product has" : "products have"} a
              par level.)
            </span>
          </p>
        )
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
