/**
 * Parse the scan page's deep-link params (`/count/:id/scan?locationId=3`).
 *
 * The URL is client input like any other, so nothing in it is trusted: ids must
 * be canonical positive integers, and `locationId` must be one of the ACTIVE
 * locations the page already loaded (invariants 6 and 9). A retired or foreign
 * location id would otherwise start a leg that writes into it — the screen
 * holds its locations per leg by design, so nothing downstream would object.
 * Anything that fails falls back to `null`, which the caller treats as "show
 * the location picker" — silently, because a stale bookmark is not an error.
 *
 * Strict on purpose: `Number("1e3")`, `Number(" 5")` and `Number("")` all
 * "work", and a forgiving parser is how a typo'd or tampered param turns into a
 * different, valid-looking id.
 */
export interface ScanParams {
  locationId: number | null;
  /**
   * Parsed and validated, but NOT yet consumed: the scan page uses only
   * `locationId`, so a link carrying `productId` lands in the right leg and
   * does not open the product (docs/open-items.md #40). Kept so the validation
   * exists the day something reads it — and so nobody assumes the deep link
   * already does more than it does.
   */
  productId: number | null;
}

type RawParams = Record<string, string | string[] | undefined>;

/** First value wins when a param repeats (`?locationId=1&locationId=2`). */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInt(value: string | undefined): number | null {
  // No sign, no decimals, no exponent, no whitespace, no leading zeros.
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseScanParams(
  raw: RawParams,
  validLocationIds: readonly number[],
): ScanParams {
  const locationId = positiveInt(first(raw.locationId));
  if (locationId === null || !validLocationIds.includes(locationId)) {
    // A product with no valid location to count it in means nothing.
    return { locationId: null, productId: null };
  }
  return { locationId, productId: positiveInt(first(raw.productId)) };
}
