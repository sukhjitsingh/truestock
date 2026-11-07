import { formatProductSize } from "@/lib/bottle-sizes";

/**
 * Size-mismatch warning for the invoice review screen (QA 2026-11-06): a
 * 1.75 L invoice line matched to a 750 ml catalog row costs the wrong bottle
 * and nothing on screen looked wrong.
 *
 * Warning only, and it never guesses. A size is read only when the text names
 * exactly one volume in ml or litres; anything else (no unit, oz or gal, two
 * different volumes) reads as "unknown" and produces no warning, because a
 * false alarm on every line teaches the reviewer to ignore the real one.
 *
 * Pure and dependency-light so it is testable without a browser.
 */

// A number followed by a volume unit: "750ML", "1.75L", "1 L", ".75 LTR".
// The lookbehind keeps "12/750ML" from reading as 2750 or 12.750; the
// trailing \b keeps "12 LB" from reading as litres.
const VOLUME = /(?<![\d.])(\d+(?:\.\d+)?|\.\d+)\s*(ml|ltr|lt|l|liters?|litres?)\b/gi;

/** Distinct volumes named in one string, in millilitres. */
function volumesMl(text: string): number[] {
  const found = new Set<number>();
  for (const m of text.matchAll(VOLUME)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    found.add(m[2].toLowerCase() === "ml" ? Math.round(n) : Math.round(n * 1000));
  }
  return [...found];
}

/**
 * The bottle size a line states, in ml, or null when it cannot be read with
 * confidence. The pack description is tried first ("12/750ML", "6/1.75L"),
 * then the item description; the first one that names a volume decides, and
 * it must name exactly one.
 */
export function parseLineSizeMl(line: {
  packDescription: string | null;
  description: string | null;
}): number | null {
  for (const text of [line.packDescription, line.description]) {
    if (!text) continue;
    const sizes = volumesMl(text);
    if (sizes.length === 1) return sizes[0];
    if (sizes.length > 1) return null;
  }
  return null;
}

/** Two sizes within 2% are the same bottle (1 L vs 1000 ml; 1.75 L vs 1750 ml). */
const SAME_SIZE_TOLERANCE = 0.02;

/**
 * A warning when the size on the line clearly differs from the matched
 * product's size, else null. Both sizes print through `formatProductSize`.
 */
export function lineSizeWarning(
  line: { packDescription: string | null; description: string | null },
  matched: { unitType: string; sizeMl: number } | null | undefined,
): string | null {
  if (!matched) return null;
  const lineMl = parseLineSizeMl(line);
  if (lineMl == null) return null;
  if (Math.abs(lineMl - matched.sizeMl) / matched.sizeMl <= SAME_SIZE_TOLERANCE) return null;
  const lineSize = formatProductSize({ unitType: "bottle", sizeMl: lineMl });
  const productSize = formatProductSize(matched);
  return `Size check: this line reads ${lineSize}, but the matched product is ${productSize}.`;
}
