/**
 * Runs a deterministic vendor template over OCR markdown:
 *
 *   normalise -> detect template -> header -> records -> lines -> gate
 *
 * Every stage fails CLOSED. A template was validated on the shapes its
 * author saw; anything else (a row with the wrong number of amounts, an
 * amount that cannot be paired unambiguously, a total that does not add up)
 * returns `ok: false`, and `ok: false` means "escalate to Claude Vision",
 * never "use what we have". Vision stays the last resort for exactly the
 * documents this cannot prove it read correctly.
 *
 * The function never throws: OCR output is untrusted input of unbounded
 * shape, and a crash here would take down the extraction job instead of
 * letting it fall through to the next extractor.
 *
 * Pure: no database, no network. `DraftInvoiceLine` is a type-only import.
 */
import type { DraftInvoiceLine } from "@/lib/domain/invoice-lines";
import { verifyOcrExtraction } from "./gate";
import { MONEY_TOKEN_SOURCE, formatCents, formatWhole, parseMoneyTokenCents } from "./money";
import { normalizeOcrText } from "./normalize";
import { OCR_TEMPLATES } from "./templates";
import type {
  OcrHeaderRules,
  OcrLineType,
  OcrRecordRule,
  OcrTemplateHeader,
  OcrTemplateResult,
  OcrVendorTemplate,
} from "./types";

/**
 * Amounts printed on every item row, in no reliable order after OCR:
 * PRICE (per unit), NET (extended), TOTAL (what the row adds to the
 * invoice). The column order is NOT trusted — OCR reorders them — so they
 * are assigned by value relationship in `assignAmounts`.
 */
const AMOUNTS_PER_RECORD = 3;

/** Pipeline scales (`extraction-pipeline.ts:parseLinesFromVision`). */
const QUANTITY_SCALE = 3;
const UNIT_COST_SCALE = 4;
const LINE_MONEY_SCALE = 2;
const HEADER_MONEY_SCALE = 4;

/** A fresh, stateless copy of `pattern` (strips g/y, adds `extraFlags`), so a registry regex is never mutated by `lastIndex`. */
function fresh(pattern: RegExp, extraFlags = ""): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "") + extraFlags);
}

function moneyTokens(text: string): string[] {
  return text.match(new RegExp(MONEY_TOKEN_SOURCE, "g")) ?? [];
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function extractHeader(rules: OcrHeaderRules, text: string): OcrTemplateHeader {
  let invoiceDate: string | null = null;
  const dateMatch = fresh(rules.invoiceDate).exec(text);
  if (dateMatch?.groups) {
    const year = Number(dateMatch.groups.year);
    const month = Number(dateMatch.groups.month);
    const day = Number(dateMatch.groups.day);
    if (isCalendarDate(year, month, day)) {
      invoiceDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const invoiceNumber = fresh(rules.invoiceNumber).exec(text)?.[1] ?? null;

  // Every captured token must be the same amount. The footer prints the total
  // more than once on some layouts; if two readings disagree, one is a
  // misread, and picking either would be a guess.
  let totalGross: string | null = null;
  const totalMatch = fresh(rules.printedTotal).exec(text);
  if (totalMatch) {
    const cents = totalMatch
      .slice(1)
      .filter((group): group is string => group !== undefined)
      .map((token) => parseMoneyTokenCents(token));
    if (cents.length > 0 && cents.every((value) => value != null && value === cents[0])) {
      totalGross = formatCents(cents[0] as number, HEADER_MONEY_SCALE);
    }
  }

  // Currency stays null: a `$` does not prove USD, and a template that never
  // saw another currency has no business asserting one.
  return { invoiceDate, invoiceNumber, totalGross, totalDiscount: null, totalNet: null, currency: null };
}

interface Anchor {
  rule: OcrRecordRule;
  start: number;
  end: number;
  text: string;
  groups: Record<string, string | undefined>;
}

function findAnchors(rules: OcrRecordRule[], text: string): Anchor[] {
  const anchors: Anchor[] = [];
  for (const rule of rules) {
    for (const match of text.matchAll(fresh(rule.anchor, "g"))) {
      anchors.push({
        rule,
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        text: match[0],
        groups: match.groups ?? {},
      });
    }
  }
  return anchors.sort((a, b) => a.start - b.start);
}

interface Assigned {
  unit: number;
  net: number;
  total: number;
}

/**
 * Pairs three unordered amounts with PRICE / NET / TOTAL by value, in cents.
 *
 *   net   == quantity x price           (quantity taken as 1 when unreadable)
 *   total >= net                        (TOTAL may carry a deposit on top)
 *   or, for a credit row, total < 0 and |total| == net
 *
 * Returns null unless EXACTLY ONE distinct assignment satisfies this. If two
 * assignments fit (indistinguishable amounts that mean different things),
 * choosing one would be a coin flip printed as a fact, so the row fails and
 * the document escalates.
 */
function assignAmounts(amounts: number[], quantity: number | null): Assigned | null {
  const negativeCount = amounts.filter((amount) => amount < 0).length;
  if (negativeCount > 1) return null;

  const multiplier = quantity ?? 1;
  const found = new Map<string, Assigned>();
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const [priceIndex, netIndex, totalIndex] of orders) {
    const unit = amounts[priceIndex];
    const net = amounts[netIndex];
    const total = amounts[totalIndex];
    if (unit < 0 || net < 0 || net !== unit * multiplier) continue;
    const valid = negativeCount === 1 ? total < 0 && -total === net : total >= net;
    if (valid) found.set(`${unit}|${net}|${total}`, { unit, net, total });
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

function resolveLineType(rule: OcrRecordRule, total: number): OcrLineType {
  if (typeof rule.lineType === "string") return rule.lineType;
  return total < 0 ? rule.lineType.negative : rule.lineType.positive;
}

function moneyToken(cents: number): string {
  return `${cents < 0 ? "-" : ""}$${formatCents(Math.abs(cents), 2)}`;
}

type RecordsResult = { ok: true; lines: DraftInvoiceLine[] } | { ok: false; detail: string };

function extractRecords(template: OcrVendorTemplate, text: string): RecordsResult {
  const anchors = findAnchors(template.records, text);
  if (anchors.length === 0) {
    return { ok: false, detail: "No item rows matched any record anchor." };
  }
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i].start < anchors[i - 1].end) {
      return { ok: false, detail: `Record anchors overlap (rules ${anchors[i - 1].rule.id} and ${anchors[i].rule.id}).` };
    }
  }

  // The item region ends at the footer label; the last row's window must not
  // swallow the totals block.
  const footer = fresh(template.footer, "g");
  footer.lastIndex = anchors[anchors.length - 1].end;
  const regionEnd = footer.exec(text)?.index ?? text.length;

  const lines: DraftInvoiceLine[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const window = text.slice(anchor.end, i + 1 < anchors.length ? anchors[i + 1].start : regionEnd);
    const row = `row ${i + 1} (rule ${anchor.rule.id})`;

    const tokens = moneyTokens(window);
    if (tokens.length !== AMOUNTS_PER_RECORD) {
      return { ok: false, detail: `${row}: found ${tokens.length} amounts, expected ${AMOUNTS_PER_RECORD}.` };
    }
    const cents = tokens.map((token) => parseMoneyTokenCents(token));
    if (cents.some((value) => value == null)) {
      return { ok: false, detail: `${row}: an amount token could not be parsed exactly.` };
    }

    const quantities = new Set<number>();
    for (const match of window.matchAll(fresh(anchor.rule.quantity, "g"))) {
      quantities.add(Number(match[1]));
    }
    if (quantities.size > 1) {
      return { ok: false, detail: `${row}: ${quantities.size} different quantity candidates, refusing to pick one.` };
    }
    const quantity = quantities.size === 1 ? [...quantities][0] : null;

    const assigned = assignAmounts(cents as number[], quantity);
    if (!assigned) {
      return { ok: false, detail: `${row}: the amounts cannot be paired with price/net/total unambiguously.` };
    }

    const packWord = anchor.groups.packWord;
    const pack = anchor.groups.pack;
    const printedQuantity = quantity == null ? "" : ` ${quantity}`;
    lines.push({
      lineNumber: i + 1,
      // Rebuilt from the tokens the template consumed, not sliced from the
      // page: a page slice carries stray tokens and a glued quantity that
      // differ per DPI, the consumed tokens do not.
      rawText: `${anchor.text}${printedQuantity} ${moneyToken(assigned.unit)} ${moneyToken(assigned.net)} ${moneyToken(assigned.total)}`,
      lineType: resolveLineType(anchor.rule, assigned.total),
      vendorItemCode: anchor.rule.keepCode ? (anchor.groups.code ?? null) : null,
      description: anchor.groups.description ?? null,
      packDescription: pack && packWord ? `${pack} ${packWord}` : null,
      quantity: quantity == null ? null : formatWhole(quantity, QUANTITY_SCALE),
      uom: packWord ? (anchor.rule.uomByPackWord?.[packWord.toLowerCase()] ?? null) : null,
      // Pack semantics ("4/6", "6/4") were not proven on the sample, so the
      // number is left unread instead of guessed.
      packSize: null,
      unitCost: formatCents(assigned.unit, UNIT_COST_SCALE),
      extendedCost: formatCents(assigned.net, LINE_MONEY_SCALE),
      // TOTAL, signed. It can include a deposit embedded in the row; the
      // deposit is NOT folded into unitCost/extendedCost (invariant: never
      // fold deposits into product cost), so rawGross - extendedCost on a
      // product row is that embedded deposit, not a discount.
      rawGross: formatCents(assigned.total, LINE_MONEY_SCALE),
      rawDiscount: null,
      rawNet: formatCents(assigned.net, LINE_MONEY_SCALE),
      exceptionFlags: null,
      extractionConfidence: null,
      matchedProductId: null,
      matchedVendorAliasId: null,
      matchMethod: "unmatched",
      matchConfidence: null,
    });
  }
  return { ok: true, lines };
}

export function extractWithOcrTemplate(
  markdown: string,
  templates: readonly OcrVendorTemplate[] = OCR_TEMPLATES,
): OcrTemplateResult {
  let templateKey: string | null = null;
  try {
    const text = normalizeOcrText(markdown);

    const claiming = templates.filter((candidate) => candidate.detect.every((pattern) => fresh(pattern).test(text)));
    if (claiming.length === 0) {
      return { ok: false, reason: "no-template", detail: `No registered template (of ${templates.length}) matched this document.` };
    }
    if (claiming.length > 1) {
      return { ok: false, reason: "no-template", detail: `${claiming.length} templates claim this document; refusing to pick one.` };
    }
    const template = claiming[0];
    templateKey = template.key;

    const header = extractHeader(template.header, text);
    const records = extractRecords(template, text);
    if (!records.ok) {
      return { ok: false, reason: "parse-failed", templateKey, detail: records.detail };
    }

    const gate = verifyOcrExtraction(header, records.lines);
    if (!gate.pass) {
      return {
        ok: false,
        reason: "gate-failed",
        templateKey,
        header,
        lines: records.lines,
        gate,
        detail: `Gate failed: ${gate.failedChecks.map((failure) => failure.check).join(", ")}.`,
      };
    }
    return { ok: true, templateKey, header, lines: records.lines, gate };
  } catch (error) {
    const detail = `Unexpected ${error instanceof Error ? error.name : "error"} while reading the document.`;
    return templateKey
      ? { ok: false, reason: "parse-failed", templateKey, detail }
      : { ok: false, reason: "no-template", detail };
  }
}
