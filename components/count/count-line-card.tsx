import { cn, formatUnits } from "@/lib/utils";
import { Money } from "@/components/ui/money";
import { GlyphTile, monogram } from "@/components/ui/card";

export interface CountLineCardData {
  productName: string;
  category: string;
  sizeMl: number;
  unitType: "bottle" | "can" | "keg";
  locationName: string;
  sealedCaseQty: number;
  sealedEachQty: number;
  partialFills: number[];
  units: number | null;
  caseSizeAtCount: number | null;
  extendedValue?: number | null;
}

const CATEGORY_GLYPH: Record<string, string> = {
  Spirits: "SP",
  Beer: "BE",
  Wine: "WI",
  Liqueur: "LQ",
  NA: "NA",
};

function glyphFor(data: CountLineCardData): string {
  if (data.unitType === "keg") return "KG";
  return CATEGORY_GLYPH[data.category] ?? monogram(data.productName);
}

/**
 * How a line's quantity reads. Cases and eaches stay separate all the way to
 * the screen (invariant 4) — "3 cases, 7 ea", never "79 ea". The observation
 * is what was seen; converting it for display would quietly assert a case
 * size the count line may not even have snapshotted.
 */
function describeQuantity(data: CountLineCardData): string {
  const parts: string[] = [];
  if (data.sealedCaseQty > 0) {
    parts.push(`${data.sealedCaseQty} ${data.sealedCaseQty === 1 ? "case" : "cases"}`);
  }
  if (data.sealedEachQty > 0 || parts.length === 0) {
    parts.push(`${data.sealedEachQty} ea`);
  }
  if (data.partialFills.length > 0) {
    const open = data.partialFills.length;
    parts.push(`${open} open (${data.partialFills.map((f) => `${Math.round(f * 100)}%`).join(", ")})`);
  }
  return parts.join(", ");
}

export function CountLineCard({
  data,
  highlight,
  className,
}: {
  data: CountLineCardData;
  /** "Already on this count — updated, not duplicated" affordance after a rescan. */
  highlight?: string;
  className?: string;
}) {
  // Units are null only when they are genuinely indeterminate: sealed cases
  // counted against a product with no case-size snapshot (valuation.ts). That
  // is NOT zero, and it must not render as "0 units" — the case size is
  // missing on the whole catalog right now, so this path is common, not rare.
  const unitsUnknown = data.units == null;
  const priced = data.extendedValue != null;

  return (
    <article
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border bg-card p-card-pad",
        className,
      )}
    >
      <GlyphTile className="text-numeral-md">{glyphFor(data)}</GlyphTile>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-row-title text-card-foreground">{data.productName}</h3>
        </div>
        <p className="truncate text-row-subtitle text-muted-foreground">
          {data.unitType === "keg" ? "Keg" : `${data.sizeMl}ml`} &middot; {data.locationName}
        </p>

        <div
          className={cn(
            "mt-2",
            priced ? "grid grid-cols-[1fr_auto] items-baseline gap-2" : "grid grid-cols-1",
          )}
        >
          <span className="text-numeral-sm text-card-foreground">
            {describeQuantity(data)}
            {!unitsUnknown && data.partialFills.length > 0
              ? ` · ${formatUnits(data.units!)} units`
              : ""}
          </span>
          <Money value={data.extendedValue} />
        </div>

        {unitsUnknown ? (
          <p className="mt-1 text-caption text-warning">
            Cases counted but no case size on file — units can&rsquo;t be totalled yet
          </p>
        ) : !priced && data.extendedValue !== undefined ? (
          // extendedValue === null means "the server computed it and there is
          // no cost", which is worth stating. undefined means "this viewer
          // isn't permitted to see cost" — say nothing at all in that case,
          // or the absence itself becomes the leak (design-system.md §8).
          <p className="mt-1 text-caption text-muted-foreground">
            No cost on file — excluded from valuation
          </p>
        ) : null}

        {highlight ? (
          <p className="mt-2 flex items-center gap-1.5 text-caption text-success">{highlight}</p>
        ) : null}
      </div>
    </article>
  );
}
