import type { InvoiceExtractionOutcome } from "@/lib/domain/invoices";

/**
 * What the review screen offers for a `needs_review` invoice, given how its
 * newest extraction job ended. Pure so the rule is testable without a browser.
 *
 * The failure it guards is quiet: an invoice whose extraction failed sits in
 * `needs_review` with zero lines, and a bare "No lines were extracted" next to
 * a live Approve button let it be approved with a hand-typed total (QA F8).
 * The server refuses that approval too; this is the owner-facing half.
 */
export interface ReviewOutcomeView {
  /** Show the failure panel (with `failureMessage`) instead of the bare empty-table note. */
  showFailurePanel: boolean;
  failureMessage: string | null;
  /** Offer Retry directly, without making the owner Return first. */
  canRetryNow: boolean;
  /** Non-null means Approve is disabled, and this is the reason to print beside it. */
  approveBlockedReason: string | null;
}

export function reviewOutcomeView(
  status: string,
  outcome: InvoiceExtractionOutcome | null,
): ReviewOutcomeView {
  if (status !== "needs_review" || !outcome) {
    return { showFailurePanel: false, failureMessage: null, canRetryNow: false, approveBlockedReason: null };
  }
  return {
    showFailurePanel: outcome.failed && outcome.failureMessage != null,
    failureMessage: outcome.failureMessage,
    canRetryNow: outcome.canRetry,
    approveBlockedReason:
      outcome.lineCount === 0 ? "Nothing to approve: no lines were extracted from this document." : null,
  };
}
