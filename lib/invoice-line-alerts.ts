/**
 * Live invoice-line alert badges (Phase 2.5, Slice 4 — "Cost Flow + Alerts",
 * `docs/plans/phase-2.5-invoice-automation/04-slices.md`). Deliberately
 * NOT the same thing as `components/office/invoice-exception-badges.tsx`'s
 * `KNOWN_EXCEPTION_FLAGS` — those four flags are written by the extraction
 * pipeline and persisted on `invoice_line.exception_flags`; the two alerts
 * here are computed on the fly from whatever gross/discount/net values are
 * CURRENTLY on screen (the live editable field while a line is in its
 * `needs_review` editable state, the persisted value otherwise) and are
 * never written anywhere. That file's own header comment reserves this pair
 * for Slice 4 as a separate concept on purpose — do not fold these into
 * `KNOWN_EXCEPTION_FLAGS`.
 *
 * Dependency-free like `lib/count-status.ts` / `lib/reorder-format.ts` — no
 * React, no database — so it is directly unit-testable and importable from
 * the client component that renders it.
 */

export interface InvoiceLineAlert {
  key: "discount-over-50" | "negative-net";
  label: string;
  /** A subset of `PillTone` (`components/ui/status-pill.tsx`) — this file
   * stays dependency-free rather than importing that type, and the string
   * literals below are structurally assignable to it at the call site. */
  tone: "warning" | "negative";
}

function toNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `discount > 50%` fires when `raw_discount / raw_gross > 0.5`. `raw_gross`
 * of `0`, `null`, blank, or unparseable is guarded to "no alert" rather than
 * a division by zero / `NaN` comparison — a line with no gross entered yet
 * has nothing to judge the discount against, not an alarming 50%+ discount.
 *
 * `negative net` fires when `raw_net < 0` — should not happen in a correct
 * invoice, but the check exists per the Slice 4 spec regardless.
 */
export function computeLineAlerts(
  rawGross: string | null | undefined,
  rawDiscount: string | null | undefined,
  rawNet: string | null | undefined,
): InvoiceLineAlert[] {
  const alerts: InvoiceLineAlert[] = [];

  const gross = toNumber(rawGross);
  const discount = toNumber(rawDiscount);
  if (gross != null && gross !== 0 && discount != null && discount / gross > 0.5) {
    alerts.push({ key: "discount-over-50", label: "Discount > 50%", tone: "warning" });
  }

  const net = toNumber(rawNet);
  if (net != null && net < 0) {
    alerts.push({ key: "negative-net", label: "Negative net", tone: "negative" });
  }

  return alerts;
}
