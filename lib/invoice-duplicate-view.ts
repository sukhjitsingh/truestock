/**
 * Wording for the "this file is already uploaded" refusal (docs/plans/
 * invoice-qa-fixes, mockups/duplicate-refused.html).
 *
 * One function builds the panel for BOTH refusal paths (request-time and
 * confirm-time), so the two can never drift apart. Pure and dependency-light
 * so it is testable without a browser.
 *
 * Rules the tests pin: never print a blank, the word "null", or a raw status
 * enum; a missing invoice number or vendor gets neutral wording instead; a
 * manager (canOpen false) sees the same details with no link, because the
 * review page is owner-only and the link would 404.
 */
import type { DuplicateInvoice } from "@/lib/domain/invoices";
import { formatDate } from "@/lib/utils";

export const DUPLICATE_HEADING = "This file is already uploaded.";
export const DUPLICATE_NOTE = "If the earlier copy was rejected, this upload goes through as normal.";
export const CHOOSE_ANOTHER_LABEL = "Choose another file";

/** Fits "...and is <phrase>." in plain words; keyed by the invoice status enum. */
const STATUS_PHRASE: Record<string, string> = {
  uploaded: "waiting to be read",
  processing: "being read",
  needs_review: "waiting for review",
  reviewed: "reviewed, waiting for approval",
  approved: "approved",
  rejected: "rejected",
};

export interface DuplicateView {
  heading: string;
  /** Names the original and ends with "Nothing was added." */
  body: string;
  /** Link text and target; both null when the viewer may not open the invoice. */
  openLabel: string | null;
  href: string | null;
  note: string;
  chooseAnotherLabel: string;
}

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function statusPhrase(status: string): string {
  // An unknown status must not leak as a raw enum value.
  return STATUS_PHRASE[status] ?? "already in the archive";
}

function uploadedOn(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatDate(date);
}

export function buildDuplicateView(duplicate: DuplicateInvoice, canOpen: boolean): DuplicateView {
  const number = present(duplicate.invoiceNumber);
  const vendor = present(duplicate.vendorName);
  const date = uploadedOn(duplicate.uploadedAt);

  const subject = number ? `invoice ${number}` : "an earlier invoice with no number yet";
  const fromVendor = vendor ? ` from ${vendor}` : "";
  const uploaded = date ? `, uploaded ${date}` : "";
  const state = ` and is ${statusPhrase(duplicate.status)}`;

  return {
    heading: DUPLICATE_HEADING,
    body: `It is identical to ${subject}${fromVendor}${uploaded}${state}. Nothing was added.`,
    openLabel: canOpen ? (number ? `Open invoice ${number}` : "Open the earlier invoice") : null,
    href: canOpen ? `/office/invoices/${duplicate.invoiceId}` : null,
    note: DUPLICATE_NOTE,
    chooseAnotherLabel: CHOOSE_ANOTHER_LABEL,
  };
}

/**
 * The same refusal as shown on "Retry extraction" in the review screen. There
 * is no file to swap there, so the "if the earlier copy was rejected, this
 * upload goes through" note (about a fresh upload) and the "Choose another
 * file" action are left out rather than shown where they make no sense.
 */
export type RetryDuplicateView = Pick<DuplicateView, "heading" | "body" | "openLabel" | "href">;

export function buildRetryDuplicateView(duplicate: DuplicateInvoice, canOpen: boolean): RetryDuplicateView {
  const { heading, body, openLabel, href } = buildDuplicateView(duplicate, canOpen);
  return { heading, body, openLabel, href };
}
