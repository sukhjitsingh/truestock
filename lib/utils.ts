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
 * A stored money value, formatted for display INSIDE AN EDITABLE INPUT.
 *
 * `current_unit_cost` is `DECIMAL(10,4)`, and mysql2 hands DECIMAL back as a
 * string with every declared decimal place — so a $144 keg round-trips as
 * `"144.0000"` and that is literally what the catalog's cost cell and the
 * product edit form put in front of the user. Four decimal places on a price
 * read as noise at best and as a different number at worst.
 *
 * **This trims only trailing zeros past the cents place; it never rounds.**
 * `144.0000` → `144.00`, `21.5` → `21.50`, but `12.3456` stays `12.3456`.
 * That distinction is the whole point: the column is DECIMAL(10,4) because
 * some costs genuinely carry sub-cent precision (a case cost divided across
 * a pack lands there), and quietly rendering `12.35` in an editable field
 * would make the user's next save silently write away real precision they
 * never chose to discard. A value with meaningful sub-cent digits shows all
 * of them — it is rare, and looking unusual is correct when it IS unusual.
 *
 * For read-only display of a computed dollar figure, use `formatMoney`
 * (or the `Money` component), which is always exactly two places.
 */
export function formatCostForInput(value: string | null | undefined): string {
  if (value == null || value.trim() === "") return "";
  const trimmed = value.trim();
  const match = /^(-?\d+)\.(\d+)$/.exec(trimmed);
  if (!match) return trimmed;
  const [, whole, decimals] = match;
  // Keep every place that carries information; pad back up to two so the
  // field reads as money rather than as a bare number.
  const significant = decimals.replace(/0+$/, "");
  return `${whole}.${significant.padEnd(2, "0")}`;
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
