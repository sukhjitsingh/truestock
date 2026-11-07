/**
 * Client-side date-range checks for the audit packet form (QA 2026-11-06:
 * the end-date message printed twice, once under the field and once in the
 * alert banner). Pure so the rule is testable without a browser.
 *
 * A message tied to a field is shown under that field only. The banner is
 * for what has no field to sit under (network failure, server message).
 */

/** `dateFrom`/`dateTo` are plain YYYY-MM-DD strings, so a bare string compare
 *  matches calendar order and matches `lib/validation/invoices.ts`. */
export function validateRange(dateFrom: string, dateTo: string, today: string): string | null {
  if (!dateFrom || !dateTo) return "Choose both a start and end date.";
  if (dateFrom > dateTo) return "End date must be on or after the start date.";
  if (dateTo > today) return "End date cannot be in the future.";
  return null;
}

/** What to show for a range that failed the client check: field error only. */
export function rangeFailureView(
  dateFrom: string,
  dateTo: string,
  today: string,
): { banner: string | null; fieldErrors: Record<string, string> } | null {
  const message = validateRange(dateFrom, dateTo, today);
  if (!message) return null;
  return { banner: null, fieldErrors: { dateTo: message } };
}

/** The banner text, or null when a field already shows the same message. */
export function bannerText(error: string | null, fieldErrors: Record<string, string>): string | null {
  if (!error) return null;
  return Object.values(fieldErrors).includes(error) ? null : error;
}
