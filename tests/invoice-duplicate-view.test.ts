import { describe, expect, test } from "bun:test";
import { invoiceStatusEnum } from "@/db/enums";
import { buildDuplicateView, buildRetryDuplicateView } from "@/lib/invoice-duplicate-view";
import type { DuplicateInvoice } from "@/lib/domain/invoices";

// Midday UTC so the local-zone date is the same day in any real timezone.
const UPLOADED = new Date("2026-11-02T12:00:00Z");

function dup(overrides: Partial<DuplicateInvoice> = {}): DuplicateInvoice {
  return {
    invoiceId: 41,
    vendorName: "Example Beverage Co",
    invoiceNumber: "10482",
    invoiceDate: "2026-10-30",
    status: "approved",
    uploadedAt: UPLOADED,
    ...overrides,
  };
}

function allText(view: ReturnType<typeof buildDuplicateView>): string {
  return [view.heading, view.body, view.openLabel ?? "", view.href ?? "", view.note, view.chooseAnotherLabel].join(" | ");
}

describe("buildDuplicateView", () => {
  test("names number, vendor, upload date and status, and ends with Nothing was added.", () => {
    const view = buildDuplicateView(dup(), true);
    expect(view.heading).toBe("This file is already uploaded.");
    expect(view.body).toBe(
      "It is identical to invoice 10482 from Example Beverage Co, uploaded Nov 2, 2026 and is approved. Nothing was added.",
    );
    expect(view.body.endsWith("Nothing was added.")).toBe(true);
    expect(view.note).toBe("If the earlier copy was rejected, this upload goes through as normal.");
    expect(view.chooseAnotherLabel).toBe("Choose another file");
  });

  test("owner gets an Open invoice link to the review page", () => {
    const view = buildDuplicateView(dup(), true);
    expect(view.openLabel).toBe("Open invoice 10482");
    expect(view.href).toBe("/office/invoices/41");
  });

  test("manager gets the same details and no link", () => {
    const owner = buildDuplicateView(dup(), true);
    const manager = buildDuplicateView(dup(), false);
    expect(manager.body).toBe(owner.body);
    expect(manager.openLabel).toBeNull();
    expect(manager.href).toBeNull();
  });

  test("a null invoice number gets neutral wording, never null or blank", () => {
    for (const canOpen of [true, false]) {
      const view = buildDuplicateView(dup({ invoiceNumber: null, status: "processing" }), canOpen);
      expect(view.body).toContain("an earlier invoice with no number yet");
      expect(allText(view)).not.toMatch(/null|undefined/i);
      expect(view.body).not.toContain("invoice null");
    }
    expect(buildDuplicateView(dup({ invoiceNumber: null }), true).openLabel).toBe("Open the earlier invoice");
  });

  test("a whitespace-only number counts as no number", () => {
    const view = buildDuplicateView(dup({ invoiceNumber: "   " }), true);
    expect(view.body).toContain("no number yet");
    expect(view.openLabel).toBe("Open the earlier invoice");
  });

  test("a null vendor drops the 'from' clause cleanly", () => {
    const view = buildDuplicateView(dup({ vendorName: null }), true);
    expect(view.body).toBe("It is identical to invoice 10482, uploaded Nov 2, 2026 and is approved. Nothing was added.");
    expect(view.body).not.toContain("from");
  });

  test("null number and null vendor together still read as a sentence", () => {
    const view = buildDuplicateView(dup({ invoiceNumber: null, vendorName: null, status: "uploaded" }), false);
    expect(view.body).toBe(
      "It is identical to an earlier invoice with no number yet, uploaded Nov 2, 2026 and is waiting to be read. Nothing was added.",
    );
  });

  test("an unreadable upload date is omitted rather than printed as Invalid Date", () => {
    const view = buildDuplicateView(dup({ uploadedAt: new Date("garbage") }), true);
    expect(view.body).not.toMatch(/invalid|NaN/i);
    expect(view.body).not.toContain("uploaded");
  });

  const PLAIN: Record<string, string> = {
    uploaded: "waiting to be read",
    processing: "being read",
    needs_review: "waiting for review",
    reviewed: "reviewed, waiting for approval",
    approved: "approved",
    rejected: "rejected",
  };

  test("every status enum value has plain words and none leaks raw", () => {
    expect(Object.keys(PLAIN).sort()).toEqual([...invoiceStatusEnum].sort());
    for (const status of invoiceStatusEnum) {
      const view = buildDuplicateView(dup({ status }), true);
      expect(view.body).toContain(`and is ${PLAIN[status]}.`);
      expect(view.body).not.toMatch(/needs_review|_/);
    }
  });

  test("an unknown status never leaks as an enum value", () => {
    const view = buildDuplicateView(dup({ status: "something_new" as never }), true);
    expect(view.body).not.toContain("something_new");
    expect(view.body).toContain("already in the archive");
  });
});

describe("buildRetryDuplicateView", () => {
  test("carries no note and no choose-another label", () => {
    const view = buildRetryDuplicateView(dup(), true);
    expect(Object.keys(view).sort()).toEqual(["body", "heading", "href", "openLabel"]);
    expect(view).not.toHaveProperty("note");
    expect(view).not.toHaveProperty("chooseAnotherLabel");
    expect(JSON.stringify(view)).not.toContain("Choose another file");
    expect(JSON.stringify(view)).not.toContain("goes through as normal");
  });

  test("the body names the original", () => {
    const view = buildRetryDuplicateView(dup(), true);
    expect(view.heading).toBe("This file is already uploaded.");
    expect(view.body).toContain("invoice 10482");
    expect(view.body).toContain("Example Beverage Co");
    expect(view.body.endsWith("Nothing was added.")).toBe(true);
  });

  test("href and openLabel are null when the viewer cannot open it", () => {
    const view = buildRetryDuplicateView(dup(), false);
    expect(view.href).toBeNull();
    expect(view.openLabel).toBeNull();
    const open = buildRetryDuplicateView(dup(), true);
    expect(open.href).toBe("/office/invoices/41");
    expect(open.openLabel).toBe("Open invoice 10482");
  });
});
