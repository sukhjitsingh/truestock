/**
 * Reads the item code, case pack and bottle size out of a bullet-separated
 * `Item Name` cell, the shape Southern Glazer's prints (fabricated example):
 *
 *     SAMPLE VODKA 80 111111 • 1.0L • 12 Case • SCREW CAP
 *
 * docs/plans/invoice-qa-fixes/05-item-name-addendum.md. Pure and dependency
 * free: no DB, no pipeline imports.
 *
 * It reads only what a whole segment states and otherwise returns null. A
 * wrong item code or pack size posts a plausible-but-wrong cost, which is
 * worse than a blank the reviewer fills in.
 */

import { isValidPackSize } from "@/lib/domain/cost-derivation";

const SEPARATOR = "•";

/** All digits, 5 or more. `80` (a proof) and 4-digit numbers are never codes. */
const ITEM_CODE = /^\d{5,64}$/;
/** A whole segment: "12 Case". Not "12 Cases", not "Case of 12". */
const CASE_PACK = /^(\d+)\s*case$/i;
/** A whole segment naming one volume: "1.75L", "750ML", "750 ml", "1.0L". */
const VOLUME = /^(\d+(?:\.\d+)?|\.\d+)\s*(ml|l)$/i;

export interface ItemNameReading {
  vendorItemCode: string | null;
  /** Units per case, from a `<n> Case` segment. */
  packSize: number | null;
  /**
   * `<n>/<volume>` such as `12/1.0L`, set only when BOTH a case pack and a
   * volume were read. A size alone is never turned into a pack description:
   * `n/size` needs an `n`, and inventing one would be a fabricated pack. The
   * size warning still reads the volume from the verbatim description.
   */
  packDescription: string | null;
}

const EMPTY: ItemNameReading = { vendorItemCode: null, packSize: null, packDescription: null };

/** The single value from `values`, or null when there are zero or several (ambiguous). */
function onlyOne<T>(values: T[]): T | null {
  return values.length === 1 ? values[0] : null;
}

export function readItemName(description: string | null | undefined): ItemNameReading {
  if (!description || !description.includes(SEPARATOR)) return EMPTY;
  const segments = description.split(SEPARATOR).map((s) => s.trim());

  // Code: last whitespace token of the first segment, which must follow a name.
  const tokens = segments[0].split(/\s+/).filter(Boolean);
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : null;
  const vendorItemCode = last && ITEM_CODE.test(last) ? last : null;

  const packs: number[] = [];
  const volumes: string[] = [];
  for (const segment of segments.slice(1)) {
    const pack = CASE_PACK.exec(segment);
    if (pack) {
      const n = Number(pack[1]);
      // Same 1..9999 bound the reviewer and the alias writer enforce.
      if (isValidPackSize(n)) packs.push(n);
      continue;
    }
    const volume = VOLUME.exec(segment);
    if (volume && Number(volume[1]) > 0) {
      volumes.push(`${volume[1]}${volume[2].toUpperCase()}`);
    }
  }
  const packSize = onlyOne(packs);
  const volume = onlyOne(volumes);

  return {
    vendorItemCode,
    packSize,
    packDescription: packSize != null && volume != null ? `${packSize}/${volume}` : null,
  };
}

/**
 * Fills only the fields that are still null. A value a real column (or the
 * model) already supplied is never overwritten, field by field.
 */
export function fillFromItemName(line: {
  description: string | null;
  vendorItemCode: string | null;
  packDescription: string | null;
  packSize: number | null;
}): { vendorItemCode: string | null; packDescription: string | null; packSize: number | null } {
  const read = readItemName(line.description);
  return {
    vendorItemCode: line.vendorItemCode ?? read.vendorItemCode,
    packDescription: line.packDescription ?? read.packDescription,
    packSize: line.packSize ?? read.packSize,
  };
}
