/**
 * View rules for the audit packet screen's omitted-invoice list (QA F10):
 * empty must mean "nothing omitted" and nothing else.
 */
import { describe, expect, test } from "bun:test";
import {
  omittedRowView,
  packetOmissionsView,
  previewKey,
  previewView,
  includedCountText,
  type PreviewState,
} from "@/lib/audit-packet-omissions";
import type { AuditPacketOmittedInvoice } from "@/lib/domain/audit-packets";

const unapproved: AuditPacketOmittedInvoice = {
  invoiceId: 7,
  vendorName: "Test Supply Co",
  invoiceNumber: "A-100",
  status: "needs_review",
  invoiceDate: "2026-10-02",
  reason: "unapproved",
};
const undated: AuditPacketOmittedInvoice = {
  invoiceId: 9,
  vendorName: null,
  invoiceNumber: null,
  status: "approved",
  invoiceDate: null,
  reason: "undated",
};

describe("omittedRowView", () => {
  test("unapproved row names vendor, number, date, status, and links to review", () => {
    const r = omittedRowView(unapproved);
    expect(r.title).toBe("Test Supply Co");
    expect(r.subtitle).toBe("Invoice A-100 · 2026-10-02");
    expect(r.reason).toContain("Not approved yet");
    expect(r.reason).toContain("needs review");
    expect(r.href).toBe("/office/invoices/7");
  });
  test("undated row uses fallbacks and says approved but no date", () => {
    const r = omittedRowView(undated);
    expect(r.title).toBe("Unknown vendor");
    expect(r.subtitle).toBe("No invoice number · no date");
    expect(r.reason).toContain("Approved");
    expect(r.reason).toContain("no invoice date");
  });
});

describe("packetOmissionsView", () => {
  test("undefined is 'not recorded', never 'nothing omitted'", () => {
    const v = packetOmissionsView(undefined);
    expect(v.kind).toBe("not_recorded");
    expect(v.heading).toContain("not recorded");
  });
  test("empty array says nothing was left out", () => {
    const v = packetOmissionsView([]);
    expect(v.kind).toBe("none");
    expect(v.rows).toHaveLength(0);
  });
  test("a list is counted and every row is kept", () => {
    const v = packetOmissionsView([unapproved, undated]);
    expect(v.kind).toBe("list");
    expect(v.heading).toContain("2 invoices were left out");
    expect(v.rows.map((r) => r.invoiceId)).toEqual([7, 9]);
  });
});

describe("previewView", () => {
  const ok: PreviewState = {
    key: previewKey("2026-10-01", "2026-10-31"),
    status: "ok",
    includedInvoiceCount: 1,
    omitted: [unapproved],
  };
  test("no valid range shows nothing", () => {
    expect(previewView(ok, "2026-10-01", "2026-10-31", false).kind).toBe("idle");
  });
  test("a result for the same range is shown with the count and rows", () => {
    const v = previewView(ok, "2026-10-01", "2026-10-31", true);
    expect(v.kind).toBe("ready");
    if (v.kind === "ready") {
      expect(v.includedText).toBe("1 invoice will be included");
      expect(v.rows).toHaveLength(1);
    }
  });
  test("a result from an earlier range is never shown for a new range", () => {
    expect(previewView(ok, "2026-10-01", "2026-11-05", true).kind).toBe("loading");
  });
  test("a failed preview is an error, not an empty list", () => {
    const v = previewView(
      { key: ok.key, status: "error", message: "boom" },
      "2026-10-01",
      "2026-10-31",
      true,
    );
    expect(v).toEqual({ kind: "error", message: "boom" });
  });
  test("an ok preview with nothing omitted has no omitted heading", () => {
    const v = previewView({ ...ok, omitted: [] } as PreviewState, "2026-10-01", "2026-10-31", true);
    expect(v.kind === "ready" && v.omittedHeading).toBeNull();
  });
  test("count text pluralises", () => {
    expect(includedCountText(0)).toBe("0 invoices will be included");
    expect(includedCountText(2)).toBe("2 invoices will be included");
  });
});
