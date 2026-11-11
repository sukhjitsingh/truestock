import Link from "next/link";
import { requireOfficeUser } from "@/lib/current-user";
import { reorderListAction } from "@/app/actions/reports";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/office/page-header";
import { ReorderVendorBlock } from "@/components/office/reorder-vendor-block";

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

  const { asOfCountId, asOfClosedAt, items, productsWithPar } = result.data;
  const asOfClosedAtLabel = asOfClosedAt == null ? null : formatDate(asOfClosedAt);

  // Group by vendor ID, not name. `reorderList` already sorts so same-vendor
  // items are adjacent and retired vendors come first, so this is a walk, not
  // a re-sort. A retired vendor's group is flagged: nothing can be ordered from it.
  const groups: { key: string; vendor: string; flagged: boolean; items: typeof items }[] = [];
  for (const item of items) {
    const key = item.vendorId == null ? "none" : String(item.vendorId);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else
      groups.push({
        key,
        vendor: item.vendorName ?? "No vendor set",
        flagged: !item.vendorActive,
        items: [item],
      });
  }

  return (
    <div>
      <PageHeader
        title="Reorder"
        subtitle={
          asOfCountId == null ? (
            <p className="text-row-subtitle text-muted-foreground">
              Nothing to suggest yet — on-hand comes from the most recent{" "}
              <strong className="text-foreground">closed</strong>{" "}count, and there isn&rsquo;t
              one. An in-progress count can&rsquo;t be used: every section not yet walked would
              read as zero and put the whole catalog on this list.
            </p>
          ) : (
            <p className="text-row-subtitle text-muted-foreground">
              On hand as of count #{asOfCountId}
              {asOfClosedAtLabel ? ` · ${asOfClosedAtLabel}` : ""} &middot; {items.length}{" "}
              {items.length === 1 ? "item" : "items"} at or below par
            </p>
          )
        }
      />

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
          <div className="mt-6 max-w-prose rounded-xl border border-border/80 bg-card/85 backdrop-blur-md p-6 text-row-subtitle text-muted-foreground shadow-xs">
            <p>
              No product has a par level configured yet, so order deficits cannot be calculated. Set target stock levels on products in the{" "}
              <Link href="/office/catalog" className="text-accent font-semibold underline">
                catalog
              </Link>{" "}
              — items missing target stock are tagged{" "}
              <strong className="text-foreground">Needs par</strong>.
            </p>
          </div>
        ) : (
          <div className="mt-6 rounded-xl border border-success/30 bg-success-bg/80 p-6 text-row-subtitle text-success backdrop-blur-md shadow-xs">
            <p>
              All inventoried items are currently stocked at or above target par levels.{" "}
              <span className="text-caption text-muted-foreground">
                ({productsWithPar} {productsWithPar === 1 ? "product has" : "products have"} an active par level.)
              </span>
            </p>
          </div>
        )
      ) : null}

      {asOfCountId != null ? (
        <div className="mt-8 flex flex-col gap-section-gap">
          {groups.map((group) => (
            <ReorderVendorBlock
              key={group.key}
              vendorName={group.vendor}
              flagged={group.flagged}
              items={group.items}
              asOfCountId={asOfCountId}
              asOfClosedAt={asOfClosedAtLabel}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
