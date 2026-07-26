import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's standard class combiner: conditional classes, last-wins conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Money formatting. Takes dollars (the server's valuation layer works in
 * dollars as numbers — see lib/domain/valuation.ts), not cents.
 *
 * There is deliberately no "null means zero" fallback here. A value the
 * caller cannot see arrives as `undefined` and must not be rendered at all
 * (docs/design-system.md §8) — that decision belongs to the component, and
 * making this function tolerate undefined would invite `formatMoney(v ?? 0)`,
 * which prints "$0.00" for a bottle whose cost is merely hidden or unknown.
 */
export function formatMoney(dollars: number): string {
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Units are fractional — `partial_fills` holds tenths, so 4 sealed bottles
 * plus a 0.3 and a 0.8 is 5.1 units. Trailing zeros are dropped so whole
 * numbers read as "12", not "12.0", while a partial still reads "5.1".
 */
export function formatUnits(units: number): string {
  return Number(units.toFixed(2)).toLocaleString("en-US");
}

/** e.g. "Jul 26, 2:14 PM" — compact enough for a phone row. */
export function formatDateTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
