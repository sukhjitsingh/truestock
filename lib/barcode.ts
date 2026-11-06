/**
 * One barcode, one written form (docs/plans/barcode-integrity, Fix 1).
 *
 * A bottle's barcode can be written down several ways that all mean the same
 * code: the 12-digit UPC-A printed on it, the 13-digit EAN-13 form with a
 * leading zero (which is how the ZXing reader actually reported a UPC-A
 * through the fake camera, 2026-11-05), the 14-digit GTIN-14, or the 8-digit
 * UPC-E short form on small bottles. The database's unique index only refuses
 * an IDENTICAL string, so each reading looked like a new barcode and one
 * bottle's code could be attached to two different sizes — the owner's bug.
 *
 * Every barcode is therefore stored and looked up in one standard form:
 * the 14-digit GTIN (owner, 2026-11-05). The format the camera reported is
 * recorded alongside it.
 *
 * Self-contained by requirement: no database, no DOM, no app imports, so every
 * rule is a table row in tests/barcode-normalize.test.ts. Called at the six
 * places in lib/domain/catalog.ts where a barcode reaches a query or an
 * insert, which every path goes through — scanning, rapid scan, linking,
 * creating, and writes replayed from a phone's offline queue.
 *
 * ## The safety rule
 *
 * The only dangerous mistake here is MERGING two different codes into one.
 * So nothing is rewritten unless its GS1 check digit proves it is the code it
 * appears to be. Anything else is stored exactly as read (trimmed): the worst
 * outcome of that is the app asking "which bottle is this?" again, never two
 * products sharing a barcode.
 *
 * | Input                               | Stored as                         |
 * |-------------------------------------|-----------------------------------|
 * | 12, 13 or 14 digits, valid          | left-padded with zeros to 14      |
 * | 8 digits + format upc_e, valid      | expanded to UPC-A, padded to 14   |
 * | 8 digits + format ean_8, valid      | padded to 14                      |
 * | 8 digits, no/other format           | as read — never guessed           |
 * | any digits with a bad check digit   | as read                           |
 * | other lengths, or any non-digit     | as read, trimmed                  |
 */
import { SCAN_BARCODE_FORMATS } from "./barcode-reader";

export type ScannedBarcodeFormat = (typeof SCAN_BARCODE_FORMATS)[number];

export interface NormalizedBarcode {
  /** What is stored and looked up. */
  barcode: string;
  /** What the camera said it read, if it is one the scanner asks for; else null. */
  format: ScannedBarcodeFormat | null;
}

/**
 * Total — never throws, for any input — and idempotent: normalizing the
 * output again with the same format returns the same result.
 */
export function normalizeBarcode(raw: string, format?: string | null): NormalizedBarcode {
  const code = String(raw ?? "").trim();
  const known = toKnownFormat(format);

  if (/^\d+$/.test(code)) {
    if ((code.length === 12 || code.length === 13 || code.length === 14) && isValidGs1(code)) {
      return { barcode: code.padStart(14, "0"), format: known };
    }
    if (code.length === 8 && known === "upc_e") {
      const upcA = expandUpcE(code);
      if (upcA && isValidGs1(upcA)) return { barcode: upcA.padStart(14, "0"), format: known };
    }
    if (code.length === 8 && known === "ean_8" && isValidGs1(code)) {
      return { barcode: code.padStart(14, "0"), format: known };
    }
  }
  return { barcode: code, format: known };
}

/** GS1 mod-10: weights 3,1,3,… from the digit left of the check digit. */
function isValidGs1(digits: string): boolean {
  let sum = 0;
  for (let i = digits.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(digits[i]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/**
 * UPC-E (number system, six digits, check digit) → the 12-digit UPC-A it
 * abbreviates. The last of the six digits selects which zeros were dropped.
 * Only number systems 0 and 1 exist for UPC-E; anything else is not one.
 */
function expandUpcE(code: string): string | null {
  const ns = code[0];
  if (ns !== "0" && ns !== "1") return null;
  const [d1, d2, d3, d4, d5, d6] = code.slice(1, 7);
  const check = code[7];
  let body: string;
  if (d6 === "0" || d6 === "1" || d6 === "2") body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === "3") body = `${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === "4") body = `${d1}${d2}${d3}${d4}00000${d5}`;
  else body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  return `${ns}${body}${check}`;
}

function toKnownFormat(format?: string | null): ScannedBarcodeFormat | null {
  return (SCAN_BARCODE_FORMATS as readonly string[]).includes(format ?? "")
    ? (format as ScannedBarcodeFormat)
    : null;
}
