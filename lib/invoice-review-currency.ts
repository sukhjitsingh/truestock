/**
 * The currency the review form starts with (QA 2026-11-06).
 *
 * The input used to carry `placeholder="USD"` on an empty value. A placeholder
 * looks filled in but is not submitted, so review refused with "missing:
 * currency" while the screen seemed to have one. The form now starts with a
 * real value: whatever extraction found, else USD. It is visible, editable, and
 * submitted exactly like anything the reviewer typed. The server applies no
 * default of its own; a missing currency is still refused there.
 *
 * Pure so the rule is testable without a browser.
 */
export const DEFAULT_REVIEW_CURRENCY = "USD";

export function initialCurrencyInput(extracted: string | null | undefined): string {
  const trimmed = extracted?.trim();
  return trimmed ? trimmed : DEFAULT_REVIEW_CURRENCY;
}
