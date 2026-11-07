import type { AuditPacketOmittedInvoice } from "@/lib/domain/audit-packets";

/**
 * View logic for the audit packet screen's "left out" list (QA F10).
 *
 * The failure it guards: a packet used to drop an undated invoice with no
 * word, so the owner handed over an archive believing it held everything.
 * Empty must therefore only ever be shown when the server said "nothing
 * omitted" - never for a preview that failed, is still loading, or belongs
 * to a different date range. Pure (type-only import) so the rules are
 * testable without a browser.
 */

export interface OmittedRowView {
  invoiceId: number;
  /** Vendor name, or a plain fallback. */
  title: string;
  /** "Invoice 1234" or a plain fallback, then the date or "no date". */
  subtitle: string;
  /** Plain-words reason this invoice is not in the packet. */
  reason: string;
  /** The owner-only review page for this invoice. */
  href: string;
}

function statusWords(status: string): string {
  return status.replace(/_/g, " ");
}

export function omittedRowView(o: AuditPacketOmittedInvoice): OmittedRowView {
  const vendor = o.vendorName?.trim() ? o.vendorName.trim() : "Unknown vendor";
  const number = o.invoiceNumber?.trim() ? `Invoice ${o.invoiceNumber.trim()}` : "No invoice number";
  const date = o.invoiceDate ? o.invoiceDate : "no date";
  const reason =
    o.reason === "undated"
      ? "Approved, but it has no invoice date, so it cannot be placed in a date range."
      : `Not approved yet (status: ${statusWords(o.status)}).`;
  return {
    invoiceId: o.invoiceId,
    title: vendor,
    subtitle: `${number} · ${date}`,
    reason,
    href: `/office/invoices/${o.invoiceId}`,
  };
}

export function includedCountText(count: number): string {
  return `${count} ${count === 1 ? "invoice" : "invoices"} will be included`;
}

export function omittedHeading(count: number): string {
  return `${count} ${count === 1 ? "invoice" : "invoices"} will be left out`;
}

export interface PacketOmissionsView {
  kind: "none" | "list" | "not_recorded";
  heading: string;
  rows: OmittedRowView[];
}

/**
 * For a packet that already exists. `undefined` means the packet predates
 * the omitted list: say so, never "nothing omitted".
 */
export function packetOmissionsView(
  omitted: AuditPacketOmittedInvoice[] | undefined,
): PacketOmissionsView {
  if (omitted === undefined) {
    return {
      kind: "not_recorded",
      heading: "Left-out invoices were not recorded for this packet",
      rows: [],
    };
  }
  if (omitted.length === 0) {
    return { kind: "none", heading: "No invoices were left out of this packet", rows: [] };
  }
  return {
    kind: "list",
    heading: `${omitted.length} ${omitted.length === 1 ? "invoice was" : "invoices were"} left out of this packet`,
    rows: omitted.map(omittedRowView),
  };
}

export type PreviewState =
  | { key: string; status: "loading" }
  | { key: string; status: "error"; message: string }
  | { key: string; status: "ok"; includedInvoiceCount: number; omitted: AuditPacketOmittedInvoice[] };

export function previewKey(dateFrom: string, dateTo: string): string {
  return `${dateFrom}|${dateTo}`;
}

export type PreviewView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      includedText: string;
      omittedHeading: string | null;
      rows: OmittedRowView[];
    };

/**
 * What to show for the range currently in the inputs. A result tagged with a
 * different range is treated as no result at all (loading), so an earlier
 * range's list can never appear under a later range's dates.
 */
export function previewView(
  state: PreviewState | null,
  dateFrom: string,
  dateTo: string,
  rangeValid: boolean,
): PreviewView {
  if (!rangeValid) return { kind: "idle" };
  if (!state || state.key !== previewKey(dateFrom, dateTo)) return { kind: "loading" };
  if (state.status === "loading") return { kind: "loading" };
  if (state.status === "error") return { kind: "error", message: state.message };
  return {
    kind: "ready",
    includedText: includedCountText(state.includedInvoiceCount),
    omittedHeading: state.omitted.length > 0 ? omittedHeading(state.omitted.length) : null,
    rows: state.omitted.map(omittedRowView),
  };
}
