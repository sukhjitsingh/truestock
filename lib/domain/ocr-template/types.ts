/**
 * Types for the deterministic per-vendor OCR template parser (PDF/OCR spike).
 *
 * The whole module is pure: no database, no network, no `@/db` runtime
 * import. `DraftInvoiceLine` is imported as a TYPE only —
 * `lib/domain/invoice-lines.ts` pulls in the database client at runtime, and
 * a template run must stay usable from a plain script or test.
 *
 * A template is DATA, not code: regexes and a few flags. The generic work
 * (normalising, segmenting records, assigning amounts, building lines,
 * running the gate) lives once in `engine.ts`. Adding a vendor is therefore
 * "author anchors against the normalised stream" and nothing else — see
 * `docs/plans/pdf-ocr-spike/findings.md`.
 */
import type { DraftInvoiceLine } from "@/lib/domain/invoice-lines";

export type OcrLineType = DraftInvoiceLine["lineType"];
export type OcrLineUom = NonNullable<DraftInvoiceLine["uom"]>;

/**
 * Same shape as the pipeline's `ExtractedInvoiceHeader`, except the totals
 * are already decimal strings (4 dp, the pipeline's header scale) because
 * the template never holds a float: money is parsed to integer cents and
 * only ever formatted back out.
 */
export interface OcrTemplateHeader {
  /** YYYY-MM-DD, calendar-validated, or null when absent/impossible. */
  invoiceDate: string | null;
  invoiceNumber: string | null;
  /** The invoice's own printed grand total, or null if absent or ambiguous. */
  totalGross: string | null;
  totalDiscount: string | null;
  totalNet: string | null;
  currency: string | null;
}

/**
 * Where the header fields live, as regexes over the NORMALISED stream (see
 * `normalize.ts`). Every pattern is optional-failure: a miss yields `null`
 * for that field, never a guess. Only the printed total is load-bearing —
 * the gate refuses to pass without it.
 */
export interface OcrHeaderRules {
  /**
   * Must define named groups `year` (4 digits), `month`, `day`. Naming the
   * groups lets a template state its date order (US MDY here) declaratively.
   */
  invoiceDate: RegExp;
  /** Group 1 is the invoice number. */
  invoiceNumber: RegExp;
  /**
   * Capture groups 1..n are successive money tokens printed after the
   * "Total" label. The footer prints the grand total more than once on some
   * layouts; every group that captured must be the same amount or the total
   * is treated as unreadable.
   */
  printedTotal: RegExp;
}

/**
 * How to recognise and read ONE kind of invoice row. Rows are found by
 * their content anchor (item code / pack token / deposit wording), never by
 * line position — OCR markdown reflows between DPIs, the content does not.
 */
export interface OcrRecordRule {
  /** Short stable id, used only in diagnostics. */
  id: string;
  /**
   * Global regex over the normalised stream matching the row's HEAD (the
   * part before its amounts). Named groups it may define: `code`,
   * `description`, `pack`, `packWord`. The text between the end of the head
   * and the start of the next head is this row's "window".
   */
  anchor: RegExp;
  /**
   * Fixed, or chosen by the sign of the row's printed total (a deposit row
   * that prints its total as a negative is the credit for a returned keg).
   */
  lineType: OcrLineType | { positive: OcrLineType; negative: OcrLineType };
  /**
   * Group 1 captures the quantity digits somewhere in the window. Deliberately
   * narrow: a bare number must sit directly in front of a money token, so
   * stray page digits cannot be mistaken for a quantity.
   */
  quantity: RegExp;
  /**
   * Whether to keep the anchor's `code` group as `vendorItemCode`. A code
   * the OCR drops on some scans (it did, for the deposit row) must be left
   * null so the lines stay identical across resolutions.
   */
  keepCode: boolean;
  /** printed pack word (lower-case) -> uom. A word not listed leaves uom null. */
  uomByPackWord?: Record<string, OcrLineUom>;
}

export interface OcrVendorTemplate {
  /** Stable registry key. */
  key: string;
  /** Human name for logs and the review UI. */
  name: string;
  /**
   * Every pattern must match the normalised text for this template to claim
   * the document. Structural, not vendor-name, anchors: the point is "this
   * is the layout I was validated on", and the gate is the real safety net.
   */
  detect: RegExp[];
  header: OcrHeaderRules;
  records: OcrRecordRule[];
  /** Matches the label that ends the item region (the first "Total $..."). */
  footer: RegExp;
}

export type OcrGateCheckId =
  | "printed-total-missing"
  | "no-lines"
  | "line-gross-missing"
  | "line-sign"
  | "line-arithmetic"
  | "gross-sum-mismatch"
  | "gate-internal-error";

export interface OcrGateFailure {
  check: OcrGateCheckId;
  /** 1-based, present when the failure is about one line. */
  lineNumber?: number;
  detail: string;
}

export interface OcrGateResult {
  pass: boolean;
  failedChecks: OcrGateFailure[];
  /** Sum of every line's rawGross (deposits and credits included), 2 dp. */
  sumGross: string | null;
  /** Printed total, 2 dp. */
  printedTotal: string | null;
  /** sumGross - printedTotal, 2 dp signed, or null if either side is unknown. */
  diff: string | null;
}

export type OcrTemplateResult =
  | {
      ok: true;
      templateKey: string;
      header: OcrTemplateHeader;
      lines: DraftInvoiceLine[];
      gate: OcrGateResult;
    }
  | { ok: false; reason: "no-template"; detail: string }
  | { ok: false; reason: "parse-failed"; templateKey: string; detail: string }
  | {
      ok: false;
      reason: "gate-failed";
      templateKey: string;
      header: OcrTemplateHeader;
      lines: DraftInvoiceLine[];
      gate: OcrGateResult;
      detail: string;
    };
