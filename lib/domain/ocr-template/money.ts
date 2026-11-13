/**
 * Exact money helpers for the OCR template parser. Everything here works in
 * integers (cents, or units of 10^-scale) so a total can never drift the way
 * `0.1 + 0.2` does — the gate compares sums, and a float that is "close
 * enough" is exactly the plausible-but-wrong failure this module exists to
 * stop. No float arithmetic touches an amount anywhere in `ocr-template/`.
 */

/**
 * One money token as the normaliser leaves it: optional leading minus,
 * `$`, digits with optional thousands commas, exactly two decimals. The
 * trailing lookahead rejects a third decimal digit rather than silently
 * truncating it.
 */
export const MONEY_TOKEN_SOURCE = String.raw`-?\$\d[\d,]*\.\d{2}(?!\d)`;

const MONEY_TOKEN_STRICT = /^(-?)\$(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})$/;

/** `"$1,234.56"` -> 123456; `"-$25.00"` -> -2500; anything else -> null. */
export function parseMoneyTokenCents(token: string): number | null {
  const match = MONEY_TOKEN_STRICT.exec(token);
  if (!match) return null;
  const cents = Number(match[2].replace(/,/g, "")) * 100 + Number(match[3]);
  if (!Number.isSafeInteger(cents)) return null;
  return match[1] === "-" ? -cents : cents;
}

/** Integer cents -> decimal string at `scale` (>= 2) decimal places. */
export function formatCents(cents: number, scale: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${fraction}${"0".repeat(scale - 2)}`;
}

/** Non-negative integer -> decimal string at `scale` decimal places. */
export function formatWhole(value: number, scale: number): string {
  return `${value}.${"0".repeat(scale)}`;
}

/**
 * Decimal string -> integer count of 10^-scale units, or null when the
 * string is not a plain decimal or carries more precision than `scale`
 * (refusing beats rounding: the caller is verifying, not repairing).
 */
export function parseDecimalUnits(value: string | null, scale: number): number | null {
  if (value == null) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? "";
  if (fraction.length > scale) return null;
  const units = Number(match[2]) * 10 ** scale + Number(fraction.padEnd(scale, "0"));
  if (!Number.isSafeInteger(units)) return null;
  return match[1] === "-" ? -units : units;
}
