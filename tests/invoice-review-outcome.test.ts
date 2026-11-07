/**
 * `reviewOutcomeView` decides whether a needs_review invoice shows its
 * extraction failure, offers Retry, and blocks Approve (QA F8).
 */
import { describe, expect, test } from "bun:test";
import { reviewOutcomeView } from "@/lib/invoice-review-outcome";
import type { InvoiceExtractionOutcome } from "@/lib/domain/invoices";

const failedNoLines: InvoiceExtractionOutcome = {
  jobStatus: "failed",
  failed: true,
  failureMessage: "We could not read this document. Reject it and upload a clearer copy.",
  canRetry: true,
  lineCount: 0,
};

describe("reviewOutcomeView", () => {
  test("failed extraction with no lines shows the message, offers Retry, blocks Approve", () => {
    const v = reviewOutcomeView("needs_review", failedNoLines);
    expect(v.showFailurePanel).toBe(true);
    expect(v.failureMessage).toBe(failedNoLines.failureMessage);
    expect(v.canRetryNow).toBe(true);
    expect(v.approveBlockedReason).toContain("no lines");
  });

  test("zero lines without a failure still blocks Approve but shows no failure panel", () => {
    const v = reviewOutcomeView("needs_review", {
      ...failedNoLines,
      jobStatus: "done",
      failed: false,
      failureMessage: null,
      canRetry: false,
    });
    expect(v.showFailurePanel).toBe(false);
    expect(v.canRetryNow).toBe(false);
    expect(v.approveBlockedReason).not.toBeNull();
  });

  test("lines present leaves Approve open", () => {
    const v = reviewOutcomeView("needs_review", {
      ...failedNoLines,
      failed: false,
      failureMessage: null,
      canRetry: false,
      lineCount: 3,
    });
    expect(v.approveBlockedReason).toBeNull();
  });

  test("a failed job that left lines still shows the failure but does not block Approve", () => {
    const v = reviewOutcomeView("needs_review", { ...failedNoLines, lineCount: 2 });
    expect(v.showFailurePanel).toBe(true);
    expect(v.approveBlockedReason).toBeNull();
  });

  test("other statuses and a missing outcome offer nothing extra", () => {
    for (const s of ["reviewed", "rejected", "approved"]) {
      expect(reviewOutcomeView(s, failedNoLines)).toEqual({
        showFailurePanel: false,
        failureMessage: null,
        canRetryNow: false,
        approveBlockedReason: null,
      });
    }
    expect(reviewOutcomeView("needs_review", null).approveBlockedReason).toBeNull();
  });
});
