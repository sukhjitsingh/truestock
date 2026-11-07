/**
 * Text and view models for the invoice posting panels. Pure, and nothing here
 * imports server code (not even types), so the browser bundle stays clean. The
 * one import is `cost-derivation`, which is itself pure.
 */
import {
  classifyLineForPosting,
  effectivePackSize,
  isValidPackSize,
  type PostingCandidateLine,
} from "@/lib/domain/cost-derivation";

/**
 * "N of M lines will post" before approval, "N of M lines posted" after.
 * `final` is true only once approved, when `posted` counts rows that exist.
 */
export function postingHeadline(posted: number, total: number, final: boolean): string {
  if (total <= 0) return "This invoice has no lines to post.";
  const noun = total === 1 ? "line" : "lines";
  const verb = final ? "posted" : "will post";
  return `${posted} of ${total} ${noun} ${verb}`;
}

/** Every reason a line can be reported as not posted. */
export type SkipReasonKey =
  | "not_product_line"
  | "not_matched"
  | "no_net"
  | "free_goods"
  | "credit"
  | "no_quantity"
  | "no_units_per_case"
  | "not_posted_at_approval";

/**
 * One plain sentence for a skipped line. Each sentence states only what the
 * code checks: `classifyLineForPosting` (lib/domain/cost-derivation.ts) for the
 * first seven, and for `not_posted_at_approval` the fact that an approved
 * invoice has no cost history row for the line.
 */
export function describeSkipReason(reason: SkipReasonKey | null, lineNumber: number): string {
  const line = `Line ${lineNumber}`;
  switch (reason) {
    case "not_product_line":
      return `${line} is not a product line (for example a deposit or freight charge), so it does not change a cost.`;
    case "not_matched":
      return `${line} is not matched to a product, so there is no product to update.`;
    case "no_net":
      return `${line} has no net amount, so no cost can be worked out.`;
    case "free_goods":
      return `${line} has a net of zero (free goods), so it does not change a cost.`;
    case "credit":
      return `${line} is a credit (its net is below zero), so it does not change a cost.`;
    case "no_quantity":
      return `${line} has no quantity above zero, so no cost can be worked out.`;
    case "no_units_per_case":
      return `${line} has no units per case, so the cost of one unit cannot be worked out. Enter it on the line.`;
    case "not_posted_at_approval":
      return `${line} was left out when this invoice was approved, and no cost was recorded for it.`;
    case null:
      return `${line} posts a cost.`;
  }
}

/** What the form knows about a line that the reviewer cannot change. */
export interface LineFacts {
  lineType: PostingCandidateLine["lineType"];
  uom: PostingCandidateLine["uom"];
  quantity: string | null;
  packSize: number | null;
}

/** The reviewer's editable values for one line, exactly as the form holds them. */
export interface LineFormValues {
  rawNet: string;
  matchedProductId: string;
  /**
   * Units per case exactly as typed. Left out (undefined) means the form has no
   * such input for this line, so the stored value stands.
   */
  packSize?: string;
}

/**
 * Whether the reviewer is given a units-per-case input for this line: any
 * product line whose pack size the classifier needs from the reviewer, which is
 * every unit of measure except `each` and `keg` (those are always 1).
 */
export function showsPackSizeInput(facts: Pick<LineFacts, "lineType" | "uom">): boolean {
  return facts.lineType === "product" && effectivePackSize({ uom: facts.uom, packSize: null }) === null;
}

/**
 * A typed units-per-case value as the integer the server accepts, or null when
 * blank or invalid. Anything that is not a plain whole number from 1 to 9999
 * (0, "2.5", "1e2", "12 ", "-3", 10000) is null, so the panel never counts an
 * invalid value as a pack size.
 */
export function parsePackSizeInput(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return isValidPackSize(n) ? n : null;
}

/**
 * Form values to the classifier's input. The match and the net come from what
 * the reviewer has typed or picked (blank means none, as on submit); everything
 * else comes from the stored line. Pure so a test can prove an edit changes the
 * verdict.
 */
export function candidateFromFormValues(facts: LineFacts, values: LineFormValues): PostingCandidateLine {
  const net = values.rawNet.trim();
  const matched = values.matchedProductId.trim();
  const matchedNumber = matched === "" ? Number.NaN : Number(matched);
  return {
    lineType: facts.lineType,
    uom: facts.uom,
    quantity: facts.quantity,
    packSize: values.packSize === undefined ? facts.packSize : parsePackSizeInput(values.packSize),
    rawNet: net === "" ? null : net,
    matchedProductId: Number.isInteger(matchedNumber) && matchedNumber > 0 ? matchedNumber : null,
  };
}

export interface SkippedLineView {
  lineNumber: number;
  description: string | null;
  reason: SkipReasonKey;
}

/** What the panel renders: the counts and every skipped line. */
export interface PostingPanelModel {
  final: boolean;
  totalLines: number;
  postedLines: number;
  skipped: SkippedLineView[];
}

/** Before approval, from the form's current values. */
export function livePanelModel(
  lines: Array<LineFacts & { id: number; lineNumber: number; description: string | null }>,
  fields: Record<number, LineFormValues>,
): PostingPanelModel {
  const skipped: SkippedLineView[] = [];
  let posted = 0;
  for (const line of lines) {
    const values = fields[line.id];
    if (!values) continue;
    const verdict = classifyLineForPosting(candidateFromFormValues(line, values));
    if (verdict.posts) posted += 1;
    else skipped.push({ lineNumber: line.lineNumber, description: line.description, reason: verdict.reason });
  }
  return { final: false, totalLines: posted + skipped.length, postedLines: posted, skipped };
}

/** From the server's report, which decides the numbers. */
export function panelModelFromReport(report: {
  final: boolean;
  totalLines: number;
  postedLines: number;
  lines: Array<{ lineNumber: number; description: string | null; posted: boolean; reason: SkipReasonKey | null }>;
}): PostingPanelModel {
  const skipped: SkippedLineView[] = [];
  for (const l of report.lines) {
    if (!l.posted && l.reason) skipped.push({ lineNumber: l.lineNumber, description: l.description, reason: l.reason });
  }
  return { final: report.final, totalLines: report.totalLines, postedLines: report.postedLines, skipped };
}
