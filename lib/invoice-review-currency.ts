/**
 * The currency the review form starts with (QA 2026-11-06).
 *
 * The input used to carry `placeholder="USD"` on an empty value. A placeholder
 * looks filled in but is not submitted, so review refused with "missing:
 * currency" while the screen seemed to have one.
 *
 * The form starts with what extraction found, else empty, and never with a
 * guess. An empty box looks empty, so the reviewer knows to fill it. A
 * preselected USD would be a plausible-but-wrong default on any invoice in
 * another currency, and nobody is expected to check a field that looks done.
 * The server applies no default either: a missing currency is refused there.
 *
 * Pure so the rule is testable without a browser.
 */
export function initialCurrencyInput(extracted: string | null | undefined): string {
  return extracted?.trim() ?? "";
}
