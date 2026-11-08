/**
 * How orders are placed with a vendor — a fixed list (QA 2026-11-08).
 *
 * The stored value is the lower-case key; people only ever see the label.
 * There is no free-text option: "Other…" let anything be stored, and the
 * vendors table then printed raw values side by side ("email" next to "Fax").
 *
 * Pure and client-safe: imported by the vendor form, the vendors table and
 * the validation schemas.
 */
export const ORDER_METHODS = [
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "text", label: "Text message" },
  { value: "portal", label: "Portal" },
  { value: "rep", label: "Sales rep" },
] as const;

export type OrderMethod = (typeof ORDER_METHODS)[number]["value"];

export const ORDER_METHOD_VALUES = ORDER_METHODS.map((m) => m.value) as [OrderMethod, ...OrderMethod[]];

export function isOrderMethod(value: string): value is OrderMethod {
  return (ORDER_METHOD_VALUES as readonly string[]).includes(value);
}

/**
 * The label for a stored value. A value saved before the list was fixed is
 * returned as stored rather than hidden, so it never masquerades as
 * "Not entered".
 */
export function orderMethodLabel(value: string | null): string | null {
  if (value === null) return null;
  return ORDER_METHODS.find((m) => m.value === value)?.label ?? value;
}
