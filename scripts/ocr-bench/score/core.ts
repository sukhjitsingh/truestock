/**
 * Pure scoring helpers for the OCR engine bench. No file I/O and no network, so everything here is exercised on
 * SYNTHETIC data in score.test.ts. Nothing in this module prints: callers decide what leaves the process, and the
 * rule is structure only (counts, booleans, codes, masked text). Real invoice values live only in the ground-truth
 * file under the scratch dir, never in a report.
 *
 * Reads (never edits) the spike modules under lib/domain/ocr-template: the template engine, the gate and the money
 * helpers, so "does the existing template + gate pass on this engine's output" is answered by the real code.
 */
import type { DraftInvoiceLine } from "@/lib/domain/invoice-lines";
import { extractWithOcrTemplate } from "@/lib/domain/ocr-template/engine";
import { verifyOcrExtraction } from "@/lib/domain/ocr-template/gate";
import { MONEY_TOKEN_SOURCE, formatCents, parseDecimalUnits, parseMoneyTokenCents } from "@/lib/domain/ocr-template/money";
import { normalizeOcrText } from "@/lib/domain/ocr-template/normalize";
import { OCR_TEMPLATES } from "@/lib/domain/ocr-template/templates";
import type { OcrTemplateHeader, OcrTemplateResult, OcrVendorTemplate } from "@/lib/domain/ocr-template/types";

// ---------------------------------------------------------------------------------------------------------------
// text helpers

/** letters -> a, digits -> 9 (the same masking the engines use for error text). */
export function maskText(text: string): string {
  return text.replace(/[A-Za-z]/g, "a").replace(/\d/g, "9");
}

/** Lower-case alphanumeric words. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// ---------------------------------------------------------------------------------------------------------------
// money tokens

export interface MoneyToken {
  /** Signed integer cents. A leading `(` or `-`, or a trailing `)`, makes it negative. */
  cents: number;
  /** A `$` sits directly in front of the digits (the template requires one). */
  hasDollar: boolean;
  start: number;
  end: number;
}

/**
 * The spec's /\d{1,3}(,\d{3})*\.\d{2}/ with boundary guards so a long number is not read as a fragment: the digits
 * are not preceded by another digit, `.` or `,` and not followed by another digit; plain digit runs (no commas) are
 * accepted. The guard sits directly before the digits so a quantity glued onto the `$` ("1$140.00") still yields the
 * `$`-carrying token. A `$` is optional on purpose: this metric is about the digits. Whether the `$` survived is
 * reported separately (`dollarFraction`), because the template requires it. A token is negative when it carries a
 * minus, or sits inside a balanced pair of parentheses (the accounting form the normaliser also accepts).
 */
const MONEY_RE = /(\(\s*)?(-\s?)?(\$)?\s?(?<![\d.,])((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?!\d)(\s*\))?/g;

export function findMoneyTokens(text: string): MoneyToken[] {
  const out: MoneyToken[] = [];
  for (const match of text.matchAll(MONEY_RE)) {
    const [whole, open, minus, dollar, digits, close] = match;
    const [int, frac] = digits.split(".");
    const abs = Number(int.replace(/,/g, "")) * 100 + Number(frac);
    if (!Number.isSafeInteger(abs)) continue;
    const negative = minus !== undefined || (open !== undefined && close !== undefined);
    const start = match.index ?? 0;
    out.push({ cents: negative && abs !== 0 ? -abs : abs, hasDollar: dollar !== undefined, start, end: start + whole.length });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// multisets and precision / recall

export type Multiset = Map<number, number>;

export function toMultiset(values: readonly number[]): Multiset {
  const map: Multiset = new Map();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return map;
}

export function multisetSize(set: Multiset): number {
  let n = 0;
  for (const count of set.values()) n += count;
  return n;
}

export interface Prf {
  tp: number;
  fp: number;
  fn: number;
  expected: number;
  observed: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

/**
 * Multiset precision / recall. `tolerated` is a count of EXTRA copies per value that are neither required (recall)
 * nor penalised (precision): the grand total is printed twice on the footer and "amount received" prints 0.00,
 * neither of which belongs to a line, but reading them is not an error.
 */
export function scoreMultiset(expected: Multiset, observed: Multiset, tolerated: Multiset = new Map()): Prf {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const keys = new Set([...expected.keys(), ...observed.keys()]);
  for (const key of keys) {
    const e = expected.get(key) ?? 0;
    const o = observed.get(key) ?? 0;
    const t = tolerated.get(key) ?? 0;
    tp += Math.min(e, o);
    fn += Math.max(0, e - o);
    fp += Math.max(0, o - e - t);
  }
  const expectedTotal = multisetSize(expected);
  const observedTotal = multisetSize(observed);
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = expectedTotal > 0 ? tp / expectedTotal : null;
  let f1: number | null = null;
  if (recall !== null) {
    f1 = precision !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  }
  return { tp, fp, fn, expected: expectedTotal, observed: observedTotal, precision, recall, f1 };
}

/** Per value, the count that at least `minAgree` of the sets reach (the `minAgree`-th largest count). */
export function agreedMultiset(sets: readonly Multiset[], minAgree = 2): Multiset {
  const out: Multiset = new Map();
  const keys = new Set(sets.flatMap((set) => [...set.keys()]));
  for (const key of keys) {
    const counts = sets.map((set) => set.get(key) ?? 0).sort((a, b) => b - a);
    const agreed = counts[minAgree - 1] ?? 0;
    if (agreed > 0) out.set(key, agreed);
  }
  return out;
}

/** Per value, the largest count any of the sets holds. */
export function unionMultiset(sets: readonly Multiset[]): Multiset {
  const out: Multiset = new Map();
  for (const set of sets) for (const [key, count] of set) out.set(key, Math.max(out.get(key) ?? 0, count));
  return out;
}

/** Number of items the two multisets share (sum of the per-value minimum count). */
export function intersectionSize(a: Multiset, b: Multiset): number {
  let n = 0;
  for (const [key, count] of a) n += Math.min(count, b.get(key) ?? 0);
  return n;
}

export function moneyCentsOf(text: string): number[] {
  return findMoneyTokens(text).map((token) => token.cents);
}

// ---------------------------------------------------------------------------------------------------------------
// ground truth

export interface GtLine {
  n: number;
  lineType: string;
  /** Lower-case words of code + description + pack, from the 3-render consensus. PRIVATE. */
  descTokens: string[];
  qty: number;
  unitCents: number;
  extCents: number;
  /** The TOTAL column, signed (a returned-keg credit is negative). */
  grossCents: number;
  /** A deposit row, or a row whose TOTAL exceeds its NET (a deposit embedded in the row). */
  depositFlag: boolean;
}

export interface GroundTruth {
  version: 1;
  doc: "scan";
  derivedFrom: { renders: number; rule: string };
  /**
   * `pass`: the unchanged gate accepted the consensus. `independentCheck`: the same two rules redone here in plain
   * integer cents (qty x unit within 1 cent of ext on every line, TOTAL column within 2 cents of the printed total).
   * `exactArithmetic`: the same with zero slack.
   */
  gate: { pass: boolean; independentCheck: boolean; exactArithmetic: boolean; fieldConflicts: number };
  header: { printedTotalCents: number };
  lines: GtLine[];
  /** Extra copies of a value that appear on the page outside the line items and are not errors. */
  tolerated: { cents: number; extra: number; why: string }[];
}

export function gtMoneyMultiset(gt: GroundTruth): Multiset {
  const values: number[] = [gt.header.printedTotalCents];
  for (const line of gt.lines) values.push(line.unitCents, line.extCents, line.grossCents);
  return toMultiset(values);
}

export function gtTolerated(gt: GroundTruth): Multiset {
  const out: Multiset = new Map();
  for (const entry of gt.tolerated) out.set(entry.cents, (out.get(entry.cents) ?? 0) + entry.extra);
  return out;
}

function decimalToCents(value: string | null): number | null {
  const units = parseDecimalUnits(value, 4);
  return units === null || units % 100 !== 0 ? null : units / 100;
}

function wholeNumber(value: string | null): number | null {
  const units = parseDecimalUnits(value, 3);
  return units === null || units % 1000 !== 0 ? null : units / 1000;
}

type Fields = Record<string, unknown>;
const asFields = (line: DraftInvoiceLine): Fields => line as unknown as Fields;

export interface ConsensusResult {
  sameShape: boolean;
  fieldConflicts: number;
  header: OcrTemplateHeader;
  lines: DraftInvoiceLine[];
}

/**
 * The replay.ts consensus, unchanged in rule: per field, an unread (null) value yields to a read value and two
 * different read values are a conflict (left null). Header total is merged the same way. Requires equal shape.
 */
export function consensusOfTemplateRuns(results: readonly OcrTemplateResult[]): ConsensusResult | null {
  const usable = results.filter(
    (r): r is Extract<OcrTemplateResult, { lines: DraftInvoiceLine[] }> => r.ok || r.reason === "gate-failed",
  );
  if (usable.length === 0 || usable.length !== results.length) return null;
  const sets = usable.map((r) => r.lines);
  const sameShape = sets.every((set) => set.length === sets[0].length && set.every((l, i) => l.lineType === sets[0][i].lineType));
  if (!sameShape) return null;

  let fieldConflicts = 0;
  const lines = sets[0].map((base, i) => {
    const out: Fields = { ...asFields(base) };
    for (const key of Object.keys(out)) {
      if (key === "rawText") continue;
      const reads = new Set(
        sets
          .map((set) => asFields(set[i])[key])
          .filter((value) => value != null)
          .map((value) => JSON.stringify(value)),
      );
      if (reads.size > 1) fieldConflicts++;
      out[key] = reads.size === 1 ? JSON.parse([...reads][0]) : null;
    }
    return out as unknown as DraftInvoiceLine;
  });

  const headerReads = new Set(usable.map((r) => r.header.totalGross).filter((value) => value != null));
  if (headerReads.size > 1) fieldConflicts++;
  const header: OcrTemplateHeader = { ...usable[0].header, totalGross: headerReads.size === 1 ? [...headerReads][0] : null };
  return { sameShape, fieldConflicts, header, lines };
}

export type GtDerivation =
  | { ok: true; gt: GroundTruth; sameShape: true }
  | { ok: false; reason: string; sameShape: boolean; fieldConflicts: number; gateChecks: string[] };

/**
 * Ground truth for the scanned sample: the per-field consensus of the library OCR's saved markdown at several
 * resolutions, accepted only if the UNCHANGED gate passes on it (qty x unit == ext on every line, and the sum of the
 * TOTAL column equals the printed total, to the cent). That is the sense in which it is "arithmetic-verified": it is
 * not a human transcription, it is a reading that three independent renders agree on and that adds up.
 * `independentCheck` redoes the two checks here in plain integer cents so the claim does not rest on the gate alone.
 */
export function deriveGroundTruth(markdowns: readonly string[]): GtDerivation {
  const results = markdowns.map((markdown) => extractWithOcrTemplate(markdown));
  const consensus = consensusOfTemplateRuns(results);
  if (!consensus) {
    return { ok: false, reason: "renders do not all yield template lines of the same shape", sameShape: false, fieldConflicts: 0, gateChecks: [] };
  }
  const gate = verifyOcrExtraction(consensus.header, consensus.lines);
  if (!gate.pass) {
    return { ok: false, reason: "gate failed on the consensus", sameShape: true, fieldConflicts: consensus.fieldConflicts, gateChecks: gate.failedChecks.map((f) => f.check) };
  }
  const printed = decimalToCents(consensus.header.totalGross);
  const lines: GtLine[] = [];
  let independent = printed !== null;
  let exact = true;
  let sum = 0;
  for (const [i, line] of consensus.lines.entries()) {
    const qty = wholeNumber(line.quantity);
    const unit = decimalToCents(line.unitCost);
    const ext = decimalToCents(line.extendedCost);
    const gross = decimalToCents(line.rawGross);
    if (qty === null || unit === null || ext === null || gross === null) {
      independent = false;
      continue;
    }
    if (Math.abs(qty * unit - ext) > 1) independent = false;
    if (qty * unit !== ext) exact = false;
    sum += gross;
    lines.push({
      n: i + 1,
      lineType: line.lineType,
      descTokens: wordsOf([line.vendorItemCode, line.description, line.packDescription].filter(Boolean).join(" ")),
      qty,
      unitCents: unit,
      extCents: ext,
      grossCents: gross,
      depositFlag: line.lineType === "deposit" || line.lineType === "deposit_return" || gross !== ext,
    });
  }
  if (printed === null || lines.length !== consensus.lines.length || Math.abs(sum - printed) > 2) independent = false;
  if (printed === null || sum !== printed) exact = false;
  if (!independent) exact = false;
  const gt: GroundTruth = {
    version: 1,
    doc: "scan",
    derivedFrom: {
      renders: markdowns.length,
      rule: "per-field consensus of the library OCR template runs (unread yields, differing reads conflict), then the unchanged gate",
    },
    gate: { pass: true, independentCheck: independent, exactArithmetic: exact, fieldConflicts: consensus.fieldConflicts },
    header: { printedTotalCents: printed ?? 0 },
    lines,
    tolerated: [
      { cents: printed ?? 0, extra: 1, why: "the footer prints the grand total twice" },
      { cents: 0, extra: 1, why: "the amount-received field" },
    ],
  };
  return { ok: true, gt, sameShape: true };
}

/**
 * Money that is printed on the page but is not a line item (the footer's repeated grand total, an amount-received
 * field): per value, the copies that at least two of the library renders agree on beyond what the line items
 * account for. Reading these is correct, so the precision metric must not count them as false positives. With one
 * render there is nothing to agree on, so nothing is tolerated beyond the hardcoded footer entries.
 */
export function deriveTolerated(gt: GroundTruth, markdowns: readonly string[]): GroundTruth["tolerated"] {
  if (markdowns.length < 2) return gt.tolerated;
  const agreed = agreedMultiset(
    markdowns.map((markdown) => toMultiset(moneyCentsOf(markdown))),
    2,
  );
  const onLines = gtMoneyMultiset(gt);
  const out: GroundTruth["tolerated"] = [];
  for (const [cents, count] of [...agreed.entries()].sort((a, b) => a[0] - b[0])) {
    const extra = count - (onLines.get(cents) ?? 0);
    if (extra > 0) out.push({ cents, extra, why: "printed outside the line items; at least two library renders agree" });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// rows and quantities

export function markdownRows(markdown: string): string[] {
  return markdown.split(/\r\n|\r|\n/).filter((row) => row.trim() !== "");
}

/** A standalone small integer in the row: `3`, `(1)`, or one glued straight onto a money token (`1$140.00`). */
export function standaloneIntegers(row: string): number[] {
  const out: number[] = [];
  for (const token of row.split(/[\s|]+/)) {
    const plain = /^\(?(\d{1,3})\)?$/.exec(token);
    const glued = /^(\d{1,3})(?=-?\(?\$)/.exec(token);
    const hit = plain ?? glued;
    if (hit) out.push(Number(hit[1]));
  }
  return out;
}

/** True when an integer equal to `qty` sits directly in front of one of `moneyCents` in the row (the position the template reads). */
export function quantityBeforeMoney(row: string, qty: number, moneyCents: readonly number[]): boolean {
  for (const token of findMoneyTokens(row)) {
    if (!moneyCents.includes(token.cents) && !moneyCents.includes(Math.abs(token.cents))) continue;
    const before = row.slice(0, token.start).replace(/[#|*]/g, " ").trimEnd();
    const hit = /(?:^|[^\w$.,/-])\(?(\d{1,3})\)?$/.exec(before);
    if (hit && Number(hit[1]) === qty) return true;
  }
  return false;
}

export interface QtyHit {
  located: boolean;
  any: boolean;
  adjacent: boolean;
  oneDigit: boolean;
}

/**
 * For each ground-truth line: find the markdown row that carries that line's NET (extended) amount, then ask whether
 * the quantity appears there as a standalone small integer (`any`) and whether it sits directly in front of one of the
 * line's own amounts (`adjacent`, the position the template's quantity rule needs). When several lines share a NET
 * amount, the k-th such line takes the k-th row carrying it. `oneDigit` marks the lone single-digit quantities that
 * the library OCR kept dropping. A row that cannot be located counts as a miss.
 */
export function scoreQuantities(markdown: string, lines: readonly GtLine[]): QtyHit[] {
  const rows = markdownRows(markdown);
  const rowMoney = rows.map((row) => findMoneyTokens(row).map((t) => t.cents));
  const seenExt = new Map<number, number>();
  return lines.map((line) => {
    const k = seenExt.get(line.extCents) ?? 0;
    seenExt.set(line.extCents, k + 1);
    const candidates: number[] = [];
    rowMoney.forEach((cents, index) => {
      if (cents.includes(line.extCents)) candidates.push(index);
    });
    const oneDigit = line.qty >= 1 && line.qty <= 9;
    if (candidates.length === 0) return { located: false, any: false, adjacent: false, oneDigit };
    const row = rows[candidates[Math.min(k, candidates.length - 1)]];
    return {
      located: true,
      any: standaloneIntegers(row).includes(line.qty),
      adjacent: quantityBeforeMoney(row, line.qty, [line.unitCents, line.extCents, line.grossCents]),
      oneDigit,
    };
  });
}

export interface Ratio {
  hit: number;
  of: number;
}

export function ratioOf(hits: readonly boolean[]): Ratio {
  return { hit: hits.filter(Boolean).length, of: hits.length };
}

export function ratioValue(r: Ratio): number | null {
  return r.of > 0 ? r.hit / r.of : null;
}

export interface QtySummary {
  located: Ratio;
  any: Ratio;
  anyOneDigit: Ratio;
  adjacent: Ratio;
  adjacentOneDigit: Ratio;
}

export function summarizeQuantities(hits: readonly QtyHit[]): QtySummary {
  const lone = hits.filter((h) => h.oneDigit);
  return {
    located: ratioOf(hits.map((h) => h.located)),
    any: ratioOf(hits.map((h) => h.any)),
    anyOneDigit: ratioOf(lone.map((h) => h.any)),
    adjacent: ratioOf(hits.map((h) => h.adjacent)),
    adjacentOneDigit: ratioOf(lone.map((h) => h.adjacent)),
  };
}

/** Recall of the ground-truth description words in the engine markdown (multiset). Relative to the library consensus, not to true text. */
export function descriptionRecall(markdown: string, lines: readonly GtLine[]): Ratio {
  const pool = new Map<string, number>();
  for (const word of wordsOf(markdown)) pool.set(word, (pool.get(word) ?? 0) + 1);
  let hit = 0;
  let of = 0;
  for (const line of lines) {
    for (const word of line.descTokens) {
      of++;
      const have = pool.get(word) ?? 0;
      if (have > 0) {
        hit++;
        pool.set(word, have - 1);
      }
    }
  }
  return { hit, of };
}

// ---------------------------------------------------------------------------------------------------------------
// template + gate

export type TemplateStatus = "ok" | "no-template" | "parse-failed" | "gate-failed";

export interface TemplateOutcome {
  status: TemplateStatus;
  lineCount: number | null;
  gatePass: boolean | null;
  /** gate check code -> number of failures */
  failedChecks: Record<string, number>;
  /** Why parse-failed / no-template, as a code (never the free text). */
  failureKind: string | null;
  /** The row number the parse failed on, when it names one. */
  failureRow: number | null;
  /** For an amount-count failure: how many amounts that row had. */
  failureAmounts: number | null;
  /** Which of the template's detect patterns hit (no-template only). */
  detectHits: boolean[] | null;
  /** Lines the template produced whose (qty, unit, ext, total) match a ground-truth line, as a multiset. */
  exactVsGt: Ratio | null;
  /** The gate passed but the lines are not the ground truth: the worst outcome. */
  falseAccept: boolean | null;
}

function classifyFailure(detail: string): { kind: string; row: number | null; amounts: number | null } {
  const row = /\brow (\d+)\b/.exec(detail);
  const rowNumber = row ? Number(row[1]) : null;
  const found = /found (\d+) amounts/.exec(detail);
  if (/No item rows matched/.test(detail)) return { kind: "no-item-rows", row: null, amounts: null };
  if (/anchors overlap/.test(detail)) return { kind: "anchors-overlap", row: null, amounts: null };
  if (found) return { kind: "amount-count", row: rowNumber, amounts: Number(found[1]) };
  if (/could not be parsed exactly/.test(detail)) return { kind: "amount-unparseable", row: rowNumber, amounts: null };
  if (/different quantity candidates/.test(detail)) return { kind: "quantity-ambiguous", row: rowNumber, amounts: null };
  if (/cannot be paired/.test(detail)) return { kind: "amounts-unpairable", row: rowNumber, amounts: null };
  if (/templates claim/.test(detail)) return { kind: "ambiguous-template", row: null, amounts: null };
  if (/No registered template/.test(detail)) return { kind: "no-template-match", row: null, amounts: null };
  return { kind: "other", row: rowNumber, amounts: null };
}

function lineKey(line: DraftInvoiceLine): string {
  return [wholeNumber(line.quantity), decimalToCents(line.unitCost), decimalToCents(line.extendedCost), decimalToCents(line.rawGross)].join("|");
}

function gtLineKey(line: GtLine): string {
  return [line.qty, line.unitCents, line.extCents, line.grossCents].join("|");
}

export function compareLinesToGt(lines: readonly DraftInvoiceLine[], gt: GroundTruth): Ratio {
  const pool = new Map<string, number>();
  for (const line of lines) pool.set(lineKey(line), (pool.get(lineKey(line)) ?? 0) + 1);
  let hit = 0;
  for (const line of gt.lines) {
    const key = gtLineKey(line);
    const have = pool.get(key) ?? 0;
    if (have > 0) {
      hit++;
      pool.set(key, have - 1);
    }
  }
  return { hit, of: gt.lines.length };
}

export function detectHitsOf(markdown: string, template: OcrVendorTemplate = OCR_TEMPLATES[0]): boolean[] {
  const text = normalizeOcrText(markdown);
  return template.detect.map((pattern) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(text));
}

/** Runs the real template + gate on one markdown. With a ground truth, also compares the produced lines to it. */
export function runTemplate(markdown: string, gt?: GroundTruth): TemplateOutcome {
  const result = extractWithOcrTemplate(markdown);
  const base: TemplateOutcome = {
    status: result.ok ? "ok" : result.reason,
    lineCount: null,
    gatePass: null,
    failedChecks: {},
    failureKind: null,
    failureRow: null,
    failureAmounts: null,
    detectHits: null,
    exactVsGt: null,
    falseAccept: null,
  };
  if (result.ok || result.reason === "gate-failed") {
    base.lineCount = result.lines.length;
    base.gatePass = result.gate.pass;
    for (const failure of result.gate.failedChecks) base.failedChecks[failure.check] = (base.failedChecks[failure.check] ?? 0) + 1;
    if (gt) {
      base.exactVsGt = compareLinesToGt(result.lines, gt);
      if (result.ok) base.falseAccept = base.exactVsGt.hit !== gt.lines.length || result.lines.length !== gt.lines.length;
    }
  } else {
    const failure = classifyFailure(result.detail);
    base.failureKind = failure.kind;
    base.failureRow = failure.row;
    base.failureAmounts = failure.amounts;
    if (result.reason === "no-template") base.detectHits = detectHitsOf(markdown);
  }
  return base;
}

// ---------------------------------------------------------------------------------------------------------------
// lenient reading and cross-source merge (scratch experiment)

export interface LenientRow {
  ruleId: string;
  anchorText: string;
  qty: number | null;
  /** Two or more different quantity candidates in the window: unread, not a guess. */
  qtyAmbiguous: boolean;
  /** Signed cents of the money tokens in the row's window; [] when none was read or there were more than three. */
  amounts: number[];
  amountCount: number;
  /** Sticky: two sources read this field differently, so it stays unread. */
  qtyConflict: boolean;
  amountsConflict: boolean;
}

export interface LenientDoc {
  rows: LenientRow[];
  totalCents: number | null;
  /** The footer's own readings disagree, or a merge saw two different totals. Sticky. */
  totalConflict: boolean;
}

function fresh(pattern: RegExp, extraFlags = ""): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "") + extraFlags);
}

/**
 * Reads the document the way the template does (same anchors, same windows, same quantity rule, same footer) but
 * without failing closed: a row with fewer than three amounts or no quantity is kept with those fields unread.
 * That is the input the "unread yields to a read value" merge needs. Returns null when anchors overlap.
 */
export function readLenient(markdown: string, template: OcrVendorTemplate = OCR_TEMPLATES[0]): LenientDoc | null {
  const text = normalizeOcrText(markdown);
  const anchors: { ruleId: string; rule: OcrVendorTemplate["records"][number]; start: number; end: number; text: string }[] = [];
  for (const rule of template.records) {
    for (const match of text.matchAll(fresh(rule.anchor, "g"))) {
      const start = match.index ?? 0;
      anchors.push({ ruleId: rule.id, rule, start, end: start + match[0].length, text: match[0] });
    }
  }
  anchors.sort((a, b) => a.start - b.start);
  for (let i = 1; i < anchors.length; i++) if (anchors[i].start < anchors[i - 1].end) return null;

  let regionEnd = text.length;
  if (anchors.length > 0) {
    const footer = fresh(template.footer, "g");
    footer.lastIndex = anchors[anchors.length - 1].end;
    regionEnd = footer.exec(text)?.index ?? text.length;
  }

  const rows: LenientRow[] = anchors.map((anchor, i) => {
    const window = text.slice(anchor.end, i + 1 < anchors.length ? anchors[i + 1].start : regionEnd);
    const tokens = window.match(new RegExp(MONEY_TOKEN_SOURCE, "g")) ?? [];
    const parsed = tokens.map((token) => parseMoneyTokenCents(token)).filter((value): value is number => value !== null);
    const quantities = new Set<number>();
    for (const match of window.matchAll(fresh(anchor.rule.quantity, "g"))) quantities.add(Number(match[1]));
    return {
      ruleId: anchor.ruleId,
      anchorText: anchor.text,
      qty: quantities.size === 1 ? [...quantities][0] : null,
      qtyAmbiguous: quantities.size > 1,
      amounts: tokens.length <= 3 ? parsed : [],
      amountCount: tokens.length,
      qtyConflict: false,
      amountsConflict: false,
    };
  });

  let totalCents: number | null = null;
  let totalConflict = false;
  const totalMatch = fresh(template.header.printedTotal).exec(text);
  if (totalMatch) {
    const cents = totalMatch
      .slice(1)
      .filter((group): group is string => group !== undefined)
      .map((token) => parseMoneyTokenCents(token));
    if (cents.length > 0 && cents.every((value) => value !== null && value === cents[0])) totalCents = cents[0];
    else totalConflict = true;
  }
  return { rows, totalCents, totalConflict };
}

function isSubMultiset(small: readonly number[], big: readonly number[]): boolean {
  const pool = toMultiset(big);
  for (const value of small) {
    const have = pool.get(value) ?? 0;
    if (have === 0) return false;
    pool.set(value, have - 1);
  }
  return true;
}

function moneyText(cents: number): string {
  return `${cents < 0 ? "-" : ""}$${formatCents(Math.abs(cents), 2)}`;
}

/**
 * Rebuilds a markdown the template can read from merged rows. Scratch plumbing for the merge experiment: it goes
 * through the REAL `extractWithOcrTemplate`, so assignment of price / net / total and the gate are the production
 * code, not a copy. The "Load Sheet" label and the deposit row's `(n)` quantity format are the one registered
 * template's shapes; `readLenient` -> `reconstructMarkdown` round-trips its synthetic fixtures (see the tests).
 */
export function reconstructMarkdown(rows: readonly LenientRow[], totalCents: number | null): string {
  const parts = ["Load Sheet"];
  for (const row of rows) {
    const qty = row.qty === null ? "" : row.ruleId === "keg-deposit" ? ` (${row.qty})` : ` ${row.qty}`;
    const amounts = row.amounts.length > 0 ? ` ${row.amounts.map(moneyText).join(" ")}` : "";
    parts.push(`${row.anchorText}${qty}${amounts}`);
  }
  if (totalCents !== null) parts.push(`Total ${moneyText(totalCents)}`);
  return parts.join("\n");
}

export type AlignMode = "anchor-order" | "amount-token";

export interface Alignment {
  mode: AlignMode;
  pairs: [number | null, number | null][];
  /** Rows that found no partner and were carried over from one source only. */
  unpaired: number;
}

/**
 * Row alignment between two readings of the same page. First choice: the rows' content anchors in reading order
 * (same count, same rule sequence), which is row-aligned by construction. If the two disagree on which rows exist
 * (an engine dropped or invented an item code), fall back to aligning by the money tokens the rows share: a row in
 * A takes the next unused row in B of the same rule that has a money value in common. A row with no partner is kept
 * from its one source, so it can only be wrong, never silently dropped.
 */
export function alignRows(a: readonly LenientRow[], b: readonly LenientRow[]): Alignment {
  if (a.length === b.length && a.every((row, i) => row.ruleId === b[i].ruleId)) {
    return { mode: "anchor-order", pairs: a.map((_, i): [number, number] => [i, i]), unpaired: 0 };
  }
  const pairs: [number | null, number | null][] = [];
  const shares = (x: LenientRow, y: LenientRow) => x.amounts.some((cents) => y.amounts.includes(cents));
  let cursor = 0;
  for (let i = 0; i < a.length; i++) {
    let hit = -1;
    for (let j = cursor; j < b.length; j++) {
      if (b[j].ruleId === a[i].ruleId && shares(a[i], b[j])) {
        hit = j;
        break;
      }
    }
    if (hit < 0) {
      pairs.push([i, null]);
      continue;
    }
    for (let j = cursor; j < hit; j++) pairs.push([null, j]);
    pairs.push([i, hit]);
    cursor = hit + 1;
  }
  for (let j = cursor; j < b.length; j++) pairs.push([null, j]);
  return { mode: "amount-token", pairs, unpaired: pairs.filter(([x, y]) => x === null || y === null).length };
}

interface Filled {
  qty: number;
  amounts: number;
}

function mergeRow(x: LenientRow | null, y: LenientRow | null, filled: Filled): LenientRow {
  if (x === null) return { ...(y as LenientRow) };
  if (y === null) return { ...x };

  const qtyConflict = x.qtyConflict || y.qtyConflict || (x.qty !== null && y.qty !== null && x.qty !== y.qty);
  let qty: number | null = null;
  if (!qtyConflict) {
    qty = x.qty ?? y.qty;
    if (qty !== null && (x.qty === null || y.qty === null)) filled.qty++;
  }

  let amountsConflict = x.amountsConflict || y.amountsConflict;
  let amounts: number[] = [];
  if (!amountsConflict) {
    if (x.amounts.length === 0) amounts = y.amounts;
    else if (y.amounts.length === 0) amounts = x.amounts;
    else if (isSubMultiset(x.amounts, y.amounts)) amounts = y.amounts;
    else if (isSubMultiset(y.amounts, x.amounts)) amounts = x.amounts;
    else amountsConflict = true;
    if (!amountsConflict && amounts.length === 3 && (x.amounts.length < 3 || y.amounts.length < 3)) filled.amounts++;
  }
  return { ruleId: x.ruleId, anchorText: x.anchorText, qty, qtyAmbiguous: false, amounts, amountCount: amounts.length, qtyConflict, amountsConflict };
}

export function mergeTwoLenient(a: LenientDoc, b: LenientDoc): { doc: LenientDoc; alignment: Alignment; filled: Filled } {
  const alignment = alignRows(a.rows, b.rows);
  const filled: Filled = { qty: 0, amounts: 0 };
  const rows = alignment.pairs.map(([i, j]) => mergeRow(i === null ? null : a.rows[i], j === null ? null : b.rows[j], filled));
  const totalConflict = a.totalConflict || b.totalConflict || (a.totalCents !== null && b.totalCents !== null && a.totalCents !== b.totalCents);
  const totalCents = totalConflict ? null : (a.totalCents ?? b.totalCents);
  return { doc: { rows, totalCents, totalConflict }, alignment, filled };
}

export interface MergeOutcome {
  inputs: number;
  mergeable: boolean;
  /** Why not, as a code. */
  why: string | null;
  align: AlignMode | null;
  unpaired: number;
  rows: number;
  conflicts: { qty: number; amounts: number; total: number };
  /** Fields that were unread in one source and supplied by another. */
  filled: { qty: number; amounts: number };
  template: TemplateOutcome | null;
}

/**
 * Per-field merge of several readings of the SAME page, by the earlier consensus rule: an unread field yields to a
 * read value, two differing reads are a conflict and leave the field unread (and stay a conflict through later
 * sources). Amounts are merged as a set per row, because the column order is not trusted anywhere in this pipeline:
 * a partial reading yields to a fuller one that contains it, anything else is a conflict. Sources fold left to right.
 * The merged rows then go through the real template + gate.
 */
export function mergeLenient(docs: readonly (LenientDoc | null)[], gt?: GroundTruth): MergeOutcome {
  const base = (why: string, rows = 0): MergeOutcome => ({
    inputs: docs.length,
    mergeable: false,
    why,
    align: null,
    unpaired: 0,
    rows,
    conflicts: { qty: 0, amounts: 0, total: 0 },
    filled: { qty: 0, amounts: 0 },
    template: null,
  });
  if (docs.length === 0) return base("no-inputs");
  if (docs.some((doc) => doc === null)) return base("unreadable-input");
  const readable = docs as LenientDoc[];

  let acc = readable[0];
  let align: AlignMode = "anchor-order";
  let unpaired = 0;
  const filled: Filled = { qty: 0, amounts: 0 };
  for (const next of readable.slice(1)) {
    const step = mergeTwoLenient(acc, next);
    acc = step.doc;
    if (step.alignment.mode === "amount-token") align = "amount-token";
    unpaired += step.alignment.unpaired;
    filled.qty += step.filled.qty;
    filled.amounts += step.filled.amounts;
  }
  if (acc.rows.length === 0) return base("no-rows");

  return {
    inputs: docs.length,
    mergeable: true,
    why: null,
    align,
    unpaired,
    rows: acc.rows.length,
    conflicts: {
      qty: acc.rows.filter((row) => row.qtyConflict).length,
      amounts: acc.rows.filter((row) => row.amountsConflict).length,
      total: acc.totalConflict ? 1 : 0,
    },
    filled,
    template: runTemplate(reconstructMarkdown(acc.rows, acc.totalCents), gt),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// engine-level statistics (no ground truth needed)

export interface WordLike {
  text?: unknown;
  conf?: unknown;
}

export interface EngineStats {
  words: number;
  meanConf: number | null;
  rows: number;
  mdChars: number;
  moneyTokens: number;
  dollarFraction: number | null;
}

export function engineStats(words: readonly WordLike[], markdown: string): EngineStats {
  const confs = words.map((w) => w.conf).filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  const money = findMoneyTokens(markdown);
  return {
    words: words.length,
    meanConf: confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
    rows: markdownRows(markdown).length,
    mdChars: markdown.length,
    moneyTokens: money.length,
    dollarFraction: money.length > 0 ? money.filter((t) => t.hasDollar).length / money.length : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// formatting

/** One decimal by default on purpose: a two-decimal number would look like a money token in a report. */
export function fmt(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);
}

export function fmtRatio(r: Ratio | null | undefined): string {
  return r ? `${r.hit}/${r.of}` : "n/a";
}

export function padCell(text: string, width: number, alignRight = false): string {
  const cut = text.length > width ? text.slice(0, width) : text;
  return alignRight ? cut.padStart(width) : cut.padEnd(width);
}

export function renderTable(header: readonly string[], rows: readonly (readonly string[])[], rightAlign: readonly boolean[] = []): string {
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)));
  const line = (cells: readonly string[]) => cells.map((cell, c) => padCell(cell, widths[c], rightAlign[c] ?? false)).join("  ").trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export const STATUS_CODE: Record<TemplateStatus, string> = {
  ok: "ok",
  "no-template": "NT",
  "parse-failed": "PF",
  "gate-failed": "GF",
};
