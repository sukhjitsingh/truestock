/**
 * The extraction pipeline itself — Phase 2.5, Slices 2 and 3.
 *
 * `processExtractionQueue` is the cron tick body (`instrumentation.ts` calls
 * it on an interval): claim -> CAS invoice `uploaded -> processing` -> classify
 * (`@firecrawl/pdf-inspector`) -> extract (markdown for text PDFs, Claude
 * Vision for scanned/mixed/image PDFs) -> parse -> MATCH
 * (`lib/domain/matching.ts:matchLinesToProducts`, Slice 3) -> checks -> write
 * lines + header -> CAS invoice `processing -> needs_review` -> CAS job
 * `running -> done`. Every other function here is one stage of that pipeline,
 * exported individually so each is unit-testable without a network call or a
 * real PDF.
 *
 * ## Scope this slice deliberately does NOT cover
 *
 * `matchLinesToProducts` (Slice 3, wired into `runClaimedJob` below) resolves
 * a line's `matchedProductId`/`matchedVendorAliasId`/`matchMethod`/
 * `matchConfidence` ONLY via an existing `vendor_alias` keyed on
 * `vendor_item_code` — never a barcode, description, or fuzzy match, even
 * though `invoiceMatchMethodEnum` (db/enums.ts) already has room for those.
 * `runClaimedJob` sets the "unmatched item" exception badge on whatever is
 * STILL unmatched after that call. Of the four exception badges
 * `invoice_line.exceptionFlags` can carry ("price jump", "duplicate",
 * "doesn't add up", "unmatched item"), this pipeline only ever emits two:
 * "unmatched item" and "doesn't add up" (from `arithmeticCheck`/
 * `pdfInspectorCrossCheck` failing). "price jump" needs `product_cost_history`
 * (Slice 4) and "duplicate" needs cross-invoice comparison — neither exists
 * yet, so neither is invented here.
 *
 * Text PDFs deliberately do not depend on Anthropic. pdf-inspector preserves
 * their table layout as Markdown, which this module maps conservatively into
 * review drafts: unknown fields remain null and every row still requires a
 * human review. Mixed/scanned/image PDFs keep the Vision path because their
 * text layer is incomplete or absent.
 */
import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import * as pdfInspector from "@firecrawl/pdf-inspector";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { extractionJob } from "@/db/schema";
import { pdfTypeEnum, invoiceLineTypeEnum, invoiceLineUomEnum, extractionPhaseEnum } from "@/db/enums";
import type { Actor, Role } from "@/lib/authz";
import {
  claimNextJob,
  updateJobStatus,
  updateJobStatusTx,
  type ExtractionJobRow,
} from "@/lib/domain/extraction";
import {
  getInvoice,
  updateInvoiceStatus,
  updateInvoiceStatusTx,
  computeRetentionUntil,
} from "@/lib/domain/invoices";
import {
  writeExtractedLines,
  UNMATCHED_ITEM_FLAG,
  type DraftInvoiceLine,
  type InvoiceLineType,
  type InvoiceLineUom,
} from "@/lib/domain/invoice-lines";
import { matchLinesToProducts } from "@/lib/domain/matching";
import { resolveStoredPath } from "@/lib/storage/invoice-files";
import { DomainError } from "@/lib/domain/errors";

type PdfType = (typeof pdfTypeEnum)[number];
type ExtractionPhase = (typeof extractionPhaseEnum)[number];

/**
 * A synthetic `Actor` for domain calls the pipeline makes on a claimed job's
 * behalf. Never derived from a session — there isn't one; this is a system
 * worker running on a `setInterval`, not a request. `userId: 0` is never
 * persisted by anything this actor calls (`getInvoice`, `updateInvoiceStatus`,
 * `writeExtractedLines` only ever read `actor.organizationId`) and cannot
 * collide with a real `user.id` (autoincrement starts at 1), so there is
 * nothing for it to be mistaken for on the rare path where it might leak into
 * a log line.
 */
function systemActor(organizationId: number): Actor {
  return { userId: 0, role: "owner" as Role, organizationId };
}

// ---------------------------------------------------------------------------
// Classify / process — thin wrappers over @firecrawl/pdf-inspector
// ---------------------------------------------------------------------------

/**
 * pdf-inspector's own `PdfType` is a `const enum`
 * (`TextBased`/`Scanned`/`ImageBased`/`Mixed`), which `isolatedModules`
 * (tsconfig.json) cannot import as a value — only its string literals are
 * used here, matched against the plain strings the compiled addon actually
 * returns at runtime.
 */
const PDF_INSPECTOR_TYPE_TO_SCHEMA: Record<string, PdfType> = {
  TextBased: "text",
  Scanned: "scanned",
  ImageBased: "image",
  Mixed: "mixed",
};

export interface ClassifyPdfResult {
  pdfType: PdfType;
  pageCount: number;
  confidence: number;
  /** 0-indexed, per pdf-inspector's `classifyPdf` — NOT the 1-indexed convention `processPdf` uses. */
  pagesNeedingOcr: number[];
}

/**
 * `filePath` must already be a resolved, containment-checked absolute path
 * (`resolveStoredPath`) — this function does not perform that check itself.
 * Keeping the security-sensitive resolution in exactly one place
 * (`processExtractionQueue`) rather than repeating it here and in
 * `processPdf` is deliberate; see `lib/storage/invoice-files.ts`'s own
 * comment on why `resolveStoredPath` is "the only sanctioned way."
 */
export async function classifyPdf(filePath: string): Promise<ClassifyPdfResult> {
  const bytes = await readFile(filePath);
  const result = await pdfInspector.classifyPdfAsync(bytes);
  const pdfType = PDF_INSPECTOR_TYPE_TO_SCHEMA[String(result.pdfType)];
  if (!pdfType) {
    throw new Error(`pdf-inspector returned an unrecognised pdfType: ${String(result.pdfType)}`);
  }
  return {
    pdfType,
    pageCount: result.pageCount,
    confidence: result.confidence,
    pagesNeedingOcr: result.pagesNeedingOcr,
  };
}

export interface ProcessPdfResult {
  /** `null` when pdf-inspector found no usable text layer (a scanned/image PDF). */
  markdown: string | null;
  /** 1-indexed, per pdf-inspector's `processPdf`. */
  pagesWithTables: number[];
}

/** Same `filePath` contract as `classifyPdf` above. */
export async function processPdf(filePath: string): Promise<ProcessPdfResult> {
  const bytes = await readFile(filePath);
  const result = await pdfInspector.processPdfAsync(bytes);
  return {
    markdown: result.markdown && result.markdown.length > 0 ? result.markdown : null,
    pagesWithTables: result.pagesWithTables,
  };
}

// ---------------------------------------------------------------------------
// Text-based extraction — deterministic pdf-inspector Markdown
// ---------------------------------------------------------------------------

interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

function splitMarkdownRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of trimmed) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isMarkdownSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function normalizeHeader(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/[*_`]/g, "")
    .replace(/[^a-zA-Z0-9#]+/g, " ")
    .trim()
    .toLowerCase();
}

const HEADER_CONTINUATION_WORDS = new Set([
  "order",
  "ship",
  "shipped",
  "quantity",
  "qty",
  "unit",
  "size",
  "brand",
  "item number",
  "description",
  "# of",
  "ru",
  "un",
  "rc un",
  "tax",
  "unit price",
  "extension",
  "gross",
  "discount",
  "net",
]);

function looksLikeHeaderContinuation(row: string[]): boolean {
  const headerish = row.filter((cell) => HEADER_CONTINUATION_WORDS.has(normalizeHeader(cell))).length;
  const numeric = row.filter((cell) => parsePrintedNumber(cell) != null).length;
  return headerish >= 2 && numeric === 0;
}

function parseMarkdownTables(markdown: string): MarkdownTable[] {
  const sourceLines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  for (let index = 0; index < sourceLines.length - 1; index += 1) {
    if (!sourceLines[index].includes("|")) {
      continue;
    }
    const headers = splitMarkdownRow(sourceLines[index]);
    const separator = splitMarkdownRow(sourceLines[index + 1]);
    if (headers.length < 2 || separator.length !== headers.length || !isMarkdownSeparator(separator)) {
      continue;
    }

    const rows: string[][] = [];
    index += 2;
    while (index < sourceLines.length && sourceLines[index].includes("|")) {
      const cells = splitMarkdownRow(sourceLines[index]);
      const nextCells = index + 1 < sourceLines.length ? splitMarkdownRow(sourceLines[index + 1]) : [];
      if (cells.length >= 2 && nextCells.length === cells.length && isMarkdownSeparator(nextCells)) {
        // pdf-inspector may emit adjacent tables without a blank line. Leave
        // this header for the outer scanner instead of swallowing it as data
        // belonging to the preceding table.
        break;
      }
      if (cells.length === headers.length && cells.some(Boolean)) {
        rows.push(cells);
      }
      index += 1;
    }
    index -= 1;

    if (rows[0] && looksLikeHeaderContinuation(rows[0])) {
      const continuation = rows.shift()!;
      for (let column = 0; column < headers.length; column += 1) {
        const base = normalizeHeader(headers[column]);
        const child = normalizeHeader(continuation[column] ?? "");
        headers[column] = child && child !== base ? `${headers[column]} ${continuation[column]}` : headers[column];
      }
    }
    tables.push({ headers: headers.map(normalizeHeader), rows });
  }
  return tables;
}

function parsePrintedNumber(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().replace(/[$,\s]/g, "");
  const parenthesized = /^\((.+)\)$/.exec(normalized);
  const unsignedToken = parenthesized ? parenthesized[1] : normalized;
  // Invoice numbers are ordinary printed decimals, not JavaScript numeric
  // literals. This rejects empty formatting-only cells (`$`, `,`), hex,
  // exponents, Infinity, and other strings Number() would coerce into a
  // plausible value. Leading-decimal forms such as `.038` remain valid.
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(unsignedToken)) {
    return null;
  }
  const numeric = Number(parenthesized ? `-${unsignedToken}` : unsignedToken);
  return Number.isFinite(numeric) ? numeric : null;
}

function columnIndex(headers: string[], patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const index = headers.findIndex((header) => pattern.test(header));
    if (index >= 0) {
      return index;
    }
  }
  return -1;
}

function cellAt(row: string[], index: number): string | null {
  const value = index >= 0 ? row[index]?.trim() : "";
  return value ? value : null;
}

function boundedValue(value: string | null, maxLength: number): string | null {
  return value && value.length <= maxLength ? value : null;
}

// ---------------------------------------------------------------------------
// Shared column-header patterns. Used by BOTH parseLinesFromMarkdown and
// countMarkdownTableDataRows (the latter powers pdfInspectorCrossCheck's
// row-count heuristic) — a single source here is itself part of the fix for
// open item #37: two independently-drifting allowlists (countMarkdownTableDataRows
// had a bare "item" pattern parseLinesFromMarkdown lacked) is exactly how a
// real vendor's line-item table got silently skipped by both the parser AND
// the safety net meant to catch that.
// ---------------------------------------------------------------------------
const DESCRIPTION_HEADER_PATTERNS = [
  /^description$/,
  /^(?:item|product)\s+description$/,
  /^item\s+name$/,
  /^item$/,
  /^product$/,
];
const QUANTITY_HEADER_PATTERNS = [
  /^(?:quantity\s+)?ship(?:ped)?$/,
  /^ship\s+quantity$/,
  /^qty\s+shipped$/,
  /^quantity$/,
  /^qty$/,
  /^order\s+quantity$/,
];
const AMOUNT_HEADER_PATTERNS = [/^extension$/, /^extended(?:\s+(?:cost|price))?$/, /^amount$/, /^line\s+total$/];
const CODE_HEADER_PATTERNS = [/^item\s+(?:number|no|#)$/, /^vendor\s+(?:item|sku)/, /^sku$/, /^product\s+code$/];
// Gross/discount/net accept an optional trailing "amount" word — some vendor
// portal exports (Southern Glazer's) header these columns "Gross Amount" /
// "Discount Amount" / "Net Amount" rather than the bare word.
const GROSS_HEADER_PATTERNS = [/^(?:line\s+)?gross(?:\s+amount)?$/];
const DISCOUNT_HEADER_PATTERNS = [/^(?:line\s+)?discount(?:\s+amount)?$/];
const NET_HEADER_PATTERNS = [/^(?:line\s+)?net(?:\s+amount)?$/];
const INVOICE_DATE_HEADER_PATTERNS = [/^invoice\s*date$/, /^document\s*date$/, /^delivery\s*date$/, /^date$/];
const INVOICE_NUMBER_HEADER_PATTERNS = [/^invoice(?:\s+(?:number|no|#))?$/];
// Header-level (invoice) totals — distinct from the per-line GROSS/DISCOUNT/NET
// patterns above: these match a "Gross Total"/"Total Gross"-style column, not
// a per-line "Gross"/"Gross Amount" one.
const TOTAL_GROSS_HEADER_PATTERNS = [/^gross\s*total$/, /^total\s*gross$/];
const TOTAL_DISCOUNT_HEADER_PATTERNS = [/^discount\s*total$/, /^total\s*discount$/];
const TOTAL_NET_HEADER_PATTERNS = [
  /^net\s*total$/,
  /^total\s*net$/,
  /^invoice\s*total$/,
  /^amount\s*due$/,
  /^pay\s*this\s*amount$/,
];
const TOTAL_LABEL_HEADER_PATTERNS = [
  ...TOTAL_GROSS_HEADER_PATTERNS,
  ...TOTAL_DISCOUNT_HEADER_PATTERNS,
  ...TOTAL_NET_HEADER_PATTERNS,
];

function inferUom(value: string | null): InvoiceLineUom | null {
  if (!value) {
    return null;
  }
  const normalized = normalizeHeader(value);
  if (/^(cs|case|cases)$/.test(normalized)) {
    return "case";
  }
  if (/^(ea|each|unit|units)$/.test(normalized)) {
    return "each";
  }
  if (/^(keg|kegs)$/.test(normalized)) {
    return "keg";
  }
  return "other";
}

/**
 * Some vendor portal exports (Southern Glazer's) print quantity as a single
 * COMPOUND cell mixing a number and a unit word — "1 Cases", "2 Units" —
 * never a bare number. Only ever engaged by the caller when the plain
 * numeric parse of the cell already failed, so a vendor with a clean,
 * separate Quantity column (e.g. Performance Foodservice) never reaches
 * this: parsePrintedNumber already succeeds directly on it and this
 * function is never called.
 */
function parseCompoundQuantityCell(value: string | null): { quantity: number | null; uom: InvoiceLineUom | null } {
  if (!value) {
    return { quantity: null, uom: null };
  }
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+(\S+)$/.exec(value.trim());
  if (!match) {
    return { quantity: null, uom: null };
  }
  return { quantity: parsePrintedNumber(match[1]), uom: inferUom(match[2]) };
}

function inferLineType(description: string): InvoiceLineType {
  const normalized = description.toLowerCase().trim();
  if (
    /^(?:(?:keg|bottle)\s+)?deposit\s+(?:return|credit)\b|^return(?:ed)?\s+(?:keg\s+|bottle\s+)?deposit\b/.test(
      normalized,
    )
  ) {
    return "deposit_return";
  }
  if (/^(?:keg\s+|bottle\s+)?deposit\b/.test(normalized)) return "deposit";
  if (/^(?:freight(?:\s+charge)?|delivery\s+(?:charge|fee)|fuel surcharge)$/.test(normalized)) return "freight";
  if (/^(?:state\s+)?(?:liquor\s+|sales\s+)?tax$/.test(normalized)) return "tax";
  if (/^discount(?:\s+applied)?$/.test(normalized)) return "discount";
  if (/^(?:(?:crv|recycling)\s+)?fee$|^(?:surcharge|service charge)$/.test(normalized)) return "fee";
  return "product";
}

function parsePackSize(packDescription: string | null): number | null {
  const match = packDescription && /^(\d+)\s*(?:\/|x|×)/i.exec(packDescription.trim());
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Open item #35: bounds month to 1-12 and day to 1-31 on BOTH branches — a
 * full, documented, deliberately simple bound, not full calendar-day
 * validation (Feb 30 is not required to be rejected). An out-of-range match
 * returns null rather than being formatted into a date-shaped string that
 * would roll over silently downstream (e.g. through Date.UTC), so it falls
 * through to the existing null-and-flag-for-review path instead of
 * producing a wrong statutory retention date.
 */
function parseDateValue(value: string): string | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(value);
  if (iso) {
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const us = /\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(value);
  if (!us) {
    return null;
  }
  const month = Number(us[1]);
  const day = Number(us[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const year = us[3].length === 2 ? Number(us[3]) + (Number(us[3]) >= 70 ? 1900 : 2000) : Number(us[3]);
  return `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
}

function searchableMarkdown(markdown: string): string {
  return markdown
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/[|*_`#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findLabeledText(source: string, labels: RegExp[], valuePattern: string): string | null {
  for (const label of labels) {
    const after = new RegExp(`${label.source}\\s*(?:no\\.?|number|#|:|-)?\\s*(${valuePattern})`, "i").exec(source);
    if (after?.[1]) {
      return after[1];
    }
  }
  return null;
}

function findLabeledAmount(source: string, labels: RegExp[]): number | null {
  const amountPattern = "\\(?\\$?\\d[\\d,]*(?:\\.\\d{1,4})?\\)?";
  const after = findLabeledText(source, labels, amountPattern);
  if (after) {
    return parsePrintedNumber(after);
  }
  for (const label of labels) {
    const before = new RegExp(`(${amountPattern})\\s*${label.source}`, "i").exec(source);
    if (before?.[1]) {
      return parsePrintedNumber(before[1]);
    }
  }
  return null;
}

function findMarkdownTableValue(tables: MarkdownTable[], headerPatterns: RegExp[]): string | null {
  for (const table of tables) {
    const index = columnIndex(table.headers, headerPatterns);
    if (index < 0) {
      continue;
    }
    for (const row of table.rows) {
      const value = cellAt(row, index);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Some vendor portal exports (Southern Glazer's) print a SECOND label row
 * INSIDE the same markdown table, with no separator line of its own —
 * "Total Cases | Total Units | Gross Total | Discount Total | Net Total"
 * sits as an ordinary DATA row (parseMarkdownTables has no way to know it's
 * really a header), immediately followed by the row holding the actual
 * totals. findMarkdownTableValue only ever looks at a table's DECLARED
 * header row, so it can't see this. This scans a table's own rows for one
 * that itself looks like a label row matching `headerPatterns`, and reads
 * the value from the row immediately after it, at the same column.
 */
function findMarkdownEmbeddedLabelValue(tables: MarkdownTable[], headerPatterns: RegExp[]): string | null {
  for (const table of tables) {
    for (let i = 0; i < table.rows.length - 1; i += 1) {
      const labelIndex = columnIndex(table.rows[i].map(normalizeHeader), headerPatterns);
      if (labelIndex < 0) {
        continue;
      }
      const value = cellAt(table.rows[i + 1], labelIndex);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Item #37 / #5: a table whose description column we can't recognize might
 * still be a genuine, silently-dropped line-item table rather than a
 * metadata table this pipeline was never meant to parse. "Looks like a real
 * line-item table" here means at least 2 data rows, at least 2 of which
 * contain a cell that parses cleanly as a printed number — a repeating
 * shape metadata tables (address blocks, single-row totals) don't have.
 *
 * A table containing an embedded totals LABEL row (see
 * findMarkdownEmbeddedLabelValue above) is excluded even if it happens to
 * satisfy the row/numeric thresholds: it has already been positively
 * identified as recognized metadata, just shaped unusually — not silently
 * dropped line items.
 *
 * Also excluded: any table with fewer than 3 columns. An ordinary
 * Subtotal/Tax/Total summary block — a layout element on a large fraction of
 * real printed invoices — is a plain 2-column (label, amount) table, and its
 * bare "Subtotal"/"Tax"/"Total" labels don't match TOTAL_LABEL_HEADER_PATTERNS
 * (which requires "gross"/"discount"/"net" combined with "total"), so without
 * this it would satisfy the >=2-row/>=2-numeric-row thresholds above and get
 * misidentified as an unrecognized LINE-ITEM table, throwing away an entire
 * extraction that otherwise parsed correctly. A genuine line-item table this
 * guard needs to catch always carries more than a bare label+amount pair —
 * a description plus at least two more of quantity/price/extension/code — so
 * requiring 3+ columns keeps the real detection while excluding the summary-
 * block shape. See tests/extraction-pipeline.test.ts for the regression case.
 */
function looksLikeUnrecognizedLineItemTable(table: MarkdownTable): boolean {
  if (table.rows.length < 2 || table.headers.length < 3) {
    return false;
  }
  if (findMarkdownEmbeddedLabelValue([table], TOTAL_LABEL_HEADER_PATTERNS) != null) {
    return false;
  }
  const numericRows = table.rows.filter((row) => row.some((cell) => parsePrintedNumber(cell) != null)).length;
  return numericRows >= 2;
}

/**
 * Converts pdf-inspector's layout-aware Markdown into conservative review
 * drafts. It intentionally recognizes only common invoice column labels; a
 * table it cannot identify fails loudly instead of manufacturing lines.
 */
export function parseLinesFromMarkdown(markdown: string): ParsedExtraction {
  const source = searchableMarkdown(markdown);
  const tables = parseMarkdownTables(markdown);
  const invoiceDate = parseDateValue(
    findMarkdownTableValue(tables, INVOICE_DATE_HEADER_PATTERNS) ??
      findLabeledText(source, [/invoice\s*date/, /delivery\s*date/, /delv\s*date/, /\bdate\b/], "\\d{1,4}[-/]\\d{1,2}[-/]\\d{1,4}") ??
      "",
  );
  const invoiceNumber = boundedValue(
    findMarkdownTableValue(tables, INVOICE_NUMBER_HEADER_PATTERNS) ??
      findLabeledText(source, [/invoice\s*(?:number|no\.?|#)/], "[A-Z0-9][A-Z0-9._/-]{0,99}"),
    100,
  );
  // Table lookup first (declared header, then a vendor's embedded label row —
  // see findMarkdownEmbeddedLabelValue), text-label search second — mirrors
  // invoiceDate/invoiceNumber above exactly, and only changes behavior for
  // invoices that actually HAVE such a table: with no match on either table
  // path, these fall through to the original findLabeledAmount call
  // unchanged (e.g. Performance Foodservice's free-text "PAY THIS AMOUNT").
  const totalGrossTableValue =
    findMarkdownTableValue(tables, TOTAL_GROSS_HEADER_PATTERNS) ??
    findMarkdownEmbeddedLabelValue(tables, TOTAL_GROSS_HEADER_PATTERNS);
  const totalGross =
    totalGrossTableValue != null
      ? parsePrintedNumber(totalGrossTableValue)
      : findLabeledAmount(source, [/total\s*gross/, /gross\s*total/]);
  const totalDiscountTableValue =
    findMarkdownTableValue(tables, TOTAL_DISCOUNT_HEADER_PATTERNS) ??
    findMarkdownEmbeddedLabelValue(tables, TOTAL_DISCOUNT_HEADER_PATTERNS);
  const totalDiscount =
    totalDiscountTableValue != null
      ? parsePrintedNumber(totalDiscountTableValue)
      : findLabeledAmount(source, [/total\s*discount/, /discount\s*total/]);
  const totalNetTableValue =
    findMarkdownTableValue(tables, TOTAL_NET_HEADER_PATTERNS) ??
    findMarkdownEmbeddedLabelValue(tables, TOTAL_NET_HEADER_PATTERNS);
  const totalNet =
    totalNetTableValue != null
      ? parsePrintedNumber(totalNetTableValue)
      : findLabeledAmount(source, [/pay\s+this\s+amount/, /amount\s*due/, /invoice\s*total/, /total\s*net/]);

  const draftLines: DraftInvoiceLine[] = [];
  // Item #5: tables whose description column can't be identified but still
  // LOOK like a real, repeating line-item table (see
  // looksLikeUnrecognizedLineItemTable) are collected here rather than
  // silently skipped — "if the data isn't ready properly, we don't have data
  // at all" is a direct requirement, not a nice-to-have. Checked and thrown
  // BEFORE the "zero draft lines" throw below, with a distinct message: that
  // one means no table at all was found; this one means some tables parsed
  // fine while another looked like line items and didn't.
  const unrecognizedTables: string[] = [];
  for (const table of tables) {
    const descriptionIndex = columnIndex(table.headers, DESCRIPTION_HEADER_PATTERNS);
    const amountIndex = columnIndex(table.headers, AMOUNT_HEADER_PATTERNS);
    const quantityIndex = columnIndex(table.headers, QUANTITY_HEADER_PATTERNS);
    if (descriptionIndex < 0 || (amountIndex < 0 && quantityIndex < 0)) {
      if (descriptionIndex < 0 && looksLikeUnrecognizedLineItemTable(table)) {
        unrecognizedTables.push(table.headers.filter(Boolean).join(", ") || "(blank headers)");
      }
      continue;
    }

    const codeIndex = columnIndex(table.headers, CODE_HEADER_PATTERNS);
    const brandIndex = columnIndex(table.headers, [/^brand$/]);
    const uomIndex = columnIndex(table.headers, [/^unit$/, /^uom$/, /^order\s+unit$/, /^ru\s+un$/]);
    const packIndex = columnIndex(table.headers, [/^unit\s+size$/, /^pack\s+size$/, /^size$/, /^pack$/]);
    const unitCostIndex = columnIndex(table.headers, [/^unit\s+price$/, /^unit\s+cost$/, /^price$/]);
    const grossIndex = columnIndex(table.headers, GROSS_HEADER_PATTERNS);
    const discountIndex = columnIndex(table.headers, DISCOUNT_HEADER_PATTERNS);
    const netIndex = columnIndex(table.headers, NET_HEADER_PATTERNS);

    for (const row of table.rows) {
      const rawDescription = cellAt(row, descriptionIndex);
      const brand = cellAt(row, brandIndex);
      const description = boundedValue(
        [brand, rawDescription].filter((value, index, values) => value && values.indexOf(value) === index).join(" ") || null,
        512,
      );
      const quantityCell = cellAt(row, quantityIndex);
      let quantity = parsePrintedNumber(quantityCell);
      // Compound cells ("1 Cases", "2 Units") never parse as a plain number
      // — only fall back to the number/uom split when the plain parse
      // already failed, so a vendor with a clean, separate Quantity column
      // never engages this path.
      let compoundUom: InvoiceLineUom | null = null;
      if (quantity == null && quantityCell) {
        const compound = parseCompoundQuantityCell(quantityCell);
        quantity = compound.quantity;
        compoundUom = compound.uom;
      }
      const extension = parsePrintedNumber(cellAt(row, amountIndex));
      const unitCost = parsePrintedNumber(cellAt(row, unitCostIndex));
      const vendorItemCode = boundedValue(cellAt(row, codeIndex), 64);
      if (!description || (!vendorItemCode && quantity == null && extension == null)) {
        continue;
      }

      const packDescription = boundedValue(cellAt(row, packIndex), 64);
      draftLines.push({
        lineNumber: draftLines.length + 1,
        rawText: row.filter(Boolean).join(" | "),
        lineType: rawDescription ? inferLineType(rawDescription) : "unknown",
        vendorItemCode,
        description,
        packDescription,
        quantity: toDecimalString(quantity, 3),
        // Never overwrite a legitimately-found separate UOM column — the
        // compound-cell fallback only fills in when that column found
        // nothing for this row.
        uom: inferUom(cellAt(row, uomIndex)) ?? compoundUom,
        packSize: parsePackSize(packDescription),
        unitCost: toDecimalString(unitCost, 4),
        extendedCost: toDecimalString(extension, 2),
        rawGross: toDecimalString(parsePrintedNumber(cellAt(row, grossIndex)), 2),
        rawDiscount: toDecimalString(parsePrintedNumber(cellAt(row, discountIndex)), 2),
        rawNet: toDecimalString(parsePrintedNumber(cellAt(row, netIndex)), 2),
        exceptionFlags: null,
        extractionConfidence: null,
        matchedProductId: null,
        matchedVendorAliasId: null,
        matchMethod: "unmatched",
        matchConfidence: null,
      });
    }
  }

  if (unrecognizedTables.length > 0) {
    throw new Error(
      `pdf-inspector extracted ${unrecognizedTables.length} table(s) that look like line items but whose columns were not recognized (headers: ${unrecognizedTables
        .map((headers) => `[${headers}]`)
        .join(", ")}) — refusing to write a partial result.`,
    );
  }

  if (draftLines.length === 0) {
    throw new Error("pdf-inspector extracted text but no recognizable invoice line-item table was found.");
  }

  return {
    header: {
      invoiceDate,
      invoiceNumber,
      totalGross: toDecimalString(totalGross, 4),
      totalDiscount: toDecimalString(totalDiscount, 4),
      totalNet: toDecimalString(totalNet, 4),
      currency: /\b(?:usd|u\.?s\.?\s+currency)\b/i.test(source) ? "USD" : null,
    },
    lines: draftLines,
  };
}

// ---------------------------------------------------------------------------
// Extract — Claude Vision, structured output
// ---------------------------------------------------------------------------

const extractedLineSchema = z.object({
  rawText: z.string().nullable(),
  // Loose on the wire deliberately — see parseLinesFromVision's mapping for
  // why an unrecognised value here degrades to "unknown"/"other" rather than
  // failing the whole document's extraction over one bad line.
  lineType: z.string().nullable(),
  // .max() bounds match db/schema.ts's invoice_line column widths exactly
  // (vendor_item_code/pack_description varchar(64), description varchar(512))
  // — a garbled or hallucinated extraction over-length hits a clean Zod
  // error here, at the AI/domain boundary, instead of an opaque MariaDB
  // "Data too long" surfacing through processExtractionQueue's generic catch.
  vendorItemCode: z.string().max(64).nullable(),
  description: z.string().max(512).nullable(),
  packDescription: z.string().max(64).nullable(),
  quantity: z.number().nullable(),
  uom: z.string().nullable(),
  packSize: z.number().int().positive().nullable(),
  unitCost: z.number().nullable(),
  extendedCost: z.number().nullable(),
  rawGross: z.number().nullable(),
  rawDiscount: z.number().nullable(),
  rawNet: z.number().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});

const extractedInvoiceSchema = z.object({
  invoiceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "invoiceDate must be YYYY-MM-DD")
    .nullable(),
  // Matches invoice.invoice_number's varchar(100) — see extractedLineSchema's
  // own comment on why AI output gets the same boundary bounds as any other.
  invoiceNumber: z.string().max(100).nullable(),
  totalGross: z.number().nullable(),
  totalDiscount: z.number().nullable(),
  totalNet: z.number().nullable(),
  currency: z.string().nullable(),
  lines: z.array(extractedLineSchema),
});

export type ExtractedInvoice = z.infer<typeof extractedInvoiceSchema>;

export interface ExtractionDoc {
  pdfType: PdfType;
  /** pdf-inspector's markdown, when the classification suggests a usable text layer. */
  markdown: string | null;
  /** Base64-encoded PDF bytes, sent as the Claude Vision document block. */
  pdfBase64: string;
}

export interface ExtractInvoiceResult {
  /** `parsed_output` from the Vision call, unnarrowed — `parseLinesFromVision` is the boundary that validates it. */
  raw: unknown;
  provider: string;
  modelId: string;
  promptVersion: string;
  /** The full Claude response, stored verbatim in `extraction_job.raw_response` for audit. */
  rawResponse: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
}

export type ExtractInvoiceFn = (doc: ExtractionDoc) => Promise<ExtractInvoiceResult>;

const PROMPT_VERSION = "invoice-extraction-v1";
const MODEL_ID: Anthropic.Model = "claude-sonnet-5";
const MAX_OUTPUT_TOKENS = 8192;

const SYSTEM_INSTRUCTIONS = `You are extracting structured data from a supplier invoice for a bar or restaurant's inventory system. Read the attached PDF (and the markdown text layer, if provided, which is a machine extraction of the same document and should be treated as ground truth for wording, not as a replacement for reading the PDF's actual layout).

Return every line item on the invoice, in the order printed, plus the document's header totals. For each line:
- rawText: the line exactly as printed (best effort).
- lineType: "product" (goods sold), "deposit" (keg/bottle deposit), "deposit_return" (deposit credited back), "freight", "tax", "fee", "discount" (a discount printed as its own line), or "unknown".
- vendorItemCode: the supplier's own SKU/item code, if printed.
- description, packDescription (e.g. "12/750ML"), quantity, uom ("each", "case", "keg", or "other"), packSize (units per case, only if determinable from packDescription).
- unitCost, extendedCost: as billed.
- rawGross, rawDiscount, rawNet: the line's own printed gross/discount/net amounts, if the invoice prints them per line.
- confidence: your own 0-1 confidence in this line's extraction.

Never invent a number that is not printed or clearly computable from what is printed. Leave a field null rather than guessing. totalGross/totalDiscount/totalNet are the invoice's own header totals, not a sum you compute.`;

/**
 * Per-million-token USD pricing, input/output — an operational ESTIMATE for
 * `extraction_job.cost_usd` (DECIMAL(10,6): fractions of a cent per call),
 * never wired to a real billing system and never shown to a client. Update
 * when Anthropic's published pricing changes. An unlisted model id falls
 * back to the Sonnet-tier rate rather than throwing — a missing job is a
 * worse operational surprise than a mildly-wrong cost estimate.
 */
const PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 3, output: 15 },
};
const DEFAULT_PRICING = PRICING_USD_PER_MTOK["claude-sonnet-5"];

function estimateCostUsd(modelId: string, inputTokens: number | null, outputTokens: number | null): string | null {
  if (inputTokens == null && outputTokens == null) {
    return null;
  }
  const pricing = PRICING_USD_PER_MTOK[modelId] ?? DEFAULT_PRICING;
  const cost = ((inputTokens ?? 0) / 1_000_000) * pricing.input + ((outputTokens ?? 0) / 1_000_000) * pricing.output;
  return cost.toFixed(6);
}

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Caught by processExtractionQueue's try/catch and recorded as a clear,
    // non-internal errorMessage on the job — never an uncaught throw that
    // could crash the interval. See db/schema.ts's extractionJob.errorMessage.
    throw new Error(
      "ANTHROPIC_API_KEY is not set; it is required for scanned, mixed, or image-based invoice extraction.",
    );
  }
  anthropicClient ??= new Anthropic({ apiKey });
  return anthropicClient;
}

/**
 * The Claude Vision call. `effort` is `low` for a `text` classification
 * (the model mostly confirms what pdf-inspector's markdown already found)
 * and `medium` for anything that needs real reading (`scanned`/`mixed`/
 * `image`). The system prompt is cache-controlled (`cache_control:
 * {type: "ephemeral"}`) since it is identical on every call this pipeline
 * ever makes; only the document and its markdown anchor vary per call.
 */
export async function extractInvoice(doc: ExtractionDoc): Promise<ExtractInvoiceResult> {
  const client = getAnthropicClient();
  const effort = doc.pdfType === "text" ? "low" : "medium";

  const userContent: Anthropic.ContentBlockParam[] = [
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: doc.pdfBase64 },
    },
  ];
  if (doc.markdown) {
    userContent.push({
      type: "text",
      text: `pdf-inspector's machine-extracted text layer for this document, as ground truth for wording:\n\n${doc.markdown}`,
    });
  }
  userContent.push({ type: "text", text: "Extract every line item and the header fields from this invoice." });

  const message = await client.messages.parse({
    model: MODEL_ID,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: "text", text: SYSTEM_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
    output_config: {
      effort,
      format: zodOutputFormat(extractedInvoiceSchema),
    },
  });

  if (message.stop_reason === "max_tokens") {
    // Distinguished from the generic "no parsed_output" case below: this is
    // an actionable, specific failure (raise MAX_OUTPUT_TOKENS, or split the
    // document) rather than "the model returned nothing," which reads to an
    // operator as a totally different, unrelated problem.
    throw new Error(
      `Claude Vision's response was truncated at MAX_OUTPUT_TOKENS (${MAX_OUTPUT_TOKENS}) — likely a long invoice with many line items. Raise the limit or split the document.`,
    );
  }
  if (message.parsed_output == null) {
    throw new Error("Claude Vision returned no parsed_output for this invoice.");
  }

  return {
    raw: message.parsed_output,
    provider: "anthropic",
    modelId: MODEL_ID,
    promptVersion: PROMPT_VERSION,
    rawResponse: message,
    inputTokens: message.usage.input_tokens ?? null,
    outputTokens: message.usage.output_tokens,
    costUsd: estimateCostUsd(MODEL_ID, message.usage.input_tokens, message.usage.output_tokens),
  };
}

// ---------------------------------------------------------------------------
// Parse — the boundary between "whatever Claude returned" and our own types
// ---------------------------------------------------------------------------

export interface ExtractedInvoiceHeader {
  invoiceDate: string | null;
  invoiceNumber: string | null;
  totalGross: string | null;
  totalDiscount: string | null;
  totalNet: string | null;
  currency: string | null;
}

export interface ParsedExtraction {
  header: ExtractedInvoiceHeader;
  lines: DraftInvoiceLine[];
}

const KNOWN_LINE_TYPES = new Set<string>(invoiceLineTypeEnum);
const KNOWN_UOMS = new Set<string>(invoiceLineUomEnum);

function toDecimalString(value: number | null, scale: number): string | null {
  return value == null ? null : value.toFixed(scale);
}

function normalizeLineType(value: string | null): InvoiceLineType {
  if (value && KNOWN_LINE_TYPES.has(value)) {
    return value as InvoiceLineType;
  }
  return "unknown";
}

/** A UOM Claude names but that isn't one of the three known pack levels becomes "other" (an honest category), never null — a UOM Claude never mentioned stays null. */
function normalizeUom(value: string | null): InvoiceLineUom | null {
  if (value == null) {
    return null;
  }
  return KNOWN_UOMS.has(value) ? (value as InvoiceLineUom) : "other";
}

/**
 * Re-validates `raw` against `extractedInvoiceSchema` independently of
 * whatever validation the Anthropic SDK's own `zodOutputFormat` already did
 * — AI output crossing into the domain layer is a boundary like any other
 * (AGENTS.md: "validate every input with Zod at the boundary"), and this is
 * also the seam a test exercises directly with a plain object, without a
 * network call.
 *
 * `lineNumber` is never trusted from Claude: every line is renumbered
 * `1..N` by array position. Claude occasionally repeats or skips numbers
 * across a multi-page document, and `invoice_line_invoice_lineno_unique`
 * would reject the whole write on the first duplicate — document order
 * (the array's own order) is the only numbering signal this pipeline
 * actually needs.
 *
 * Every line starts unmatched (`matchedProductId`/`matchedVendorAliasId:
 * null`, `matchMethod: "unmatched"`, `matchConfidence: null`) and
 * `exceptionFlags: null` — NOT `["unmatched item"]`. Matching
 * (`matchLinesToProducts`, called by `runClaimedJob` right after this
 * function) may resolve some lines before anything is flagged; `runClaimedJob`
 * sets "unmatched item" afterward on whatever is STILL unmatched, so this
 * function itself must not pre-judge which lines that will be.
 */
export function parseLinesFromVision(raw: unknown): ParsedExtraction {
  const parsed = extractedInvoiceSchema.parse(raw);

  const header: ExtractedInvoiceHeader = {
    invoiceDate: parsed.invoiceDate,
    invoiceNumber: parsed.invoiceNumber,
    totalGross: toDecimalString(parsed.totalGross, 4),
    totalDiscount: toDecimalString(parsed.totalDiscount, 4),
    totalNet: toDecimalString(parsed.totalNet, 4),
    currency: parsed.currency && /^[A-Za-z]{3}$/.test(parsed.currency) ? parsed.currency.toUpperCase() : null,
  };

  const lines: DraftInvoiceLine[] = parsed.lines.map((line, index) => ({
    lineNumber: index + 1,
    rawText: line.rawText,
    lineType: normalizeLineType(line.lineType),
    vendorItemCode: line.vendorItemCode,
    description: line.description,
    packDescription: line.packDescription,
    quantity: toDecimalString(line.quantity, 3),
    uom: normalizeUom(line.uom),
    packSize: line.packSize,
    unitCost: toDecimalString(line.unitCost, 4),
    extendedCost: toDecimalString(line.extendedCost, 2),
    rawGross: toDecimalString(line.rawGross, 2),
    rawDiscount: toDecimalString(line.rawDiscount, 2),
    rawNet: toDecimalString(line.rawNet, 2),
    exceptionFlags: null,
    extractionConfidence: toDecimalString(line.confidence, 3),
    matchedProductId: null,
    matchedVendorAliasId: null,
    matchMethod: "unmatched",
    matchConfidence: null,
  }));

  return { header, lines };
}

// ---------------------------------------------------------------------------
// Checks — never fail the job; they set exception flags for a human to review
// ---------------------------------------------------------------------------

export type ArithmeticCheckResult =
  | { pass: true; overage?: number; shortfall?: number }
  | { pass: false; mismatch: number; details: string[] };

/** Rounding/printed-cents slack — real invoices round per line before summing. */
const ARITHMETIC_TOLERANCE_USD = 0.02;

/**
 * Sums every line's `rawGross` and compares it against the invoice's own
 * printed `totalGross`. A `null` header total means nothing was extracted to
 * check against — that is an absence of a claim, not a contradiction of one,
 * so it passes. A line with no `rawGross` is excluded from the sum (noted in
 * `details`) rather than treated as `0` — the same "don't coerce an unknown
 * into a plausible-looking number" rule `invoice-lines.ts` documents for
 * every other field here.
 */
export function arithmeticCheck(lines: DraftInvoiceLine[], expectedTotal: number | null): ArithmeticCheckResult {
  if (expectedTotal == null) {
    return { pass: true };
  }

  const details: string[] = [];
  let sum = 0;
  for (const line of lines) {
    if (line.rawGross == null) {
      details.push(`Line ${line.lineNumber}: no gross amount extracted, excluded from the check.`);
      continue;
    }
    sum += Number(line.rawGross);
  }

  const diff = Math.round((sum - expectedTotal) * 100) / 100;
  if (Math.abs(diff) <= ARITHMETIC_TOLERANCE_USD) {
    if (diff > 0) return { pass: true, overage: diff };
    if (diff < 0) return { pass: true, shortfall: -diff };
    return { pass: true };
  }

  details.push(
    `Sum of line gross amounts (${sum.toFixed(2)}) does not match the invoice's printed total (${expectedTotal.toFixed(2)}).`,
  );
  return { pass: false, mismatch: diff, details };
}

export type CrossCheckResult = { pass: true } | { pass: false; droppedLines: string[] };

// Uses the SAME header-pattern constants as parseLinesFromMarkdown (see the
// block above columnIndex()/cellAt()) — a single source of truth is itself
// part of the fix for open item #37. This function used to maintain its own,
// separately-drifting allowlist (missing "Item Name" among other gaps), which
// meant a real vendor's line-item table could be silently skipped by the
// parser AND go undetected by the safety net meant to catch exactly that.
function countMarkdownTableDataRows(markdown: string): number {
  let count = 0;
  const amountLikePatterns = [
    ...AMOUNT_HEADER_PATTERNS,
    ...GROSS_HEADER_PATTERNS,
    ...DISCOUNT_HEADER_PATTERNS,
    ...NET_HEADER_PATTERNS,
  ];
  for (const table of parseMarkdownTables(markdown)) {
    const descriptionIndex = columnIndex(table.headers, DESCRIPTION_HEADER_PATTERNS);
    const quantityIndex = columnIndex(table.headers, QUANTITY_HEADER_PATTERNS);
    const amountIndex = columnIndex(table.headers, amountLikePatterns);
    const codeIndex = columnIndex(table.headers, CODE_HEADER_PATTERNS);
    if (descriptionIndex < 0 || (quantityIndex < 0 && amountIndex < 0)) {
      continue;
    }
    count += table.rows.filter((row) => {
      const hasDescription = cellAt(row, descriptionIndex) != null;
      const hasLineSignal =
        cellAt(row, codeIndex) != null ||
        parsePrintedNumber(cellAt(row, quantityIndex)) != null ||
        parsePrintedNumber(cellAt(row, amountIndex)) != null;
      return hasDescription && hasLineSignal;
    }).length;
  }
  return count;
}

/**
 * A heuristic, not a guaranteed line-level diff: counts pdf-inspector's own
 * recognizable line-item rows and compares that count against how many lines
 * extraction returned. Metadata tables, multi-row headers, and section-label
 * rows are excluded. Fewer structured lines than source line-item rows is a
 * plausible signal that extraction dropped one, worth a human's attention — it
 * is not proof, and it produces no signal at all (`pass: true`) when there is
 * no markdown (a scanned/image PDF with no text layer to cross-check against)
 * or no table syntax in it (an invoice pdf-inspector rendered as prose).
 */
export function pdfInspectorCrossCheck(lines: DraftInvoiceLine[], markdown: string | null): CrossCheckResult {
  if (!markdown) {
    return { pass: true };
  }
  const tableRowCount = countMarkdownTableDataRows(markdown);
  if (tableRowCount === 0) {
    return { pass: true };
  }
  if (lines.length < tableRowCount) {
    const missing = tableRowCount - lines.length;
    return {
      pass: false,
      droppedLines: [
        `pdf-inspector's markdown contains ${tableRowCount} table row(s) but extraction produced only ${lines.length} line(s) — ${missing} may have been dropped.`,
      ],
    };
  }
  return { pass: true };
}

// ---------------------------------------------------------------------------
// The cron tick
// ---------------------------------------------------------------------------

async function setJobPhase(jobId: number, phase: ExtractionPhase): Promise<void> {
  // Best-effort, not CAS-guarded — `phase` is observability only (db/schema.ts's
  // extractionJob comment: "never a claim predicate"), so losing a race on it
  // costs a stale debugging value, never correctness.
  await db.update(extractionJob).set({ phase }).where(eq(extractionJob.id, jobId));
}

export type ProcessExtractionQueueResult =
  | { claimed: false }
  | { claimed: true; jobId: number; invoiceId: number; outcome: "done" }
  | { claimed: true; jobId: number; invoiceId: number; outcome: "failed"; errorMessage: string };

export interface ProcessExtractionQueueDeps {
  extractInvoice?: ExtractInvoiceFn;
  classifyPdf?: typeof classifyPdf;
  processPdf?: typeof processPdf;
  readPdfFile?: (filePath: string) => Promise<Buffer>;
}

/**
 * One cron tick: claims the oldest queued job (or returns `{claimed: false}`
 * if none), runs it end to end, and reports the outcome. Never throws — every
 * failure inside the claimed job's processing is caught and recorded on the
 * job itself (`status: "failed"`, a clear `errorMessage`) so `instrumentation.ts`'s
 * interval can call this in a plain loop without its own try/catch needing to
 * do anything but log defensively.
 */
export async function processExtractionQueue(
  workerId: string,
  deps: ProcessExtractionQueueDeps = {},
): Promise<ProcessExtractionQueueResult> {
  const job = await claimNextJob(workerId);
  if (!job) {
    return { claimed: false };
  }

  try {
    await runClaimedJob(job, deps);
    return { claimed: true, jobId: job.id, invoiceId: job.invoiceId, outcome: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof DomainError ? err.code : "PIPELINE_ERROR";
    let terminalizedAtomically = false;
    try {
      const actor = systemActor(job.organizationId);
      await db.transaction(async (tx) => {
        // `processing` must not become a dead-end when extraction fails. The
        // three writes are one terminal operation: clear drafts from any
        // prior extraction attempt, expose the invoice's Reject/re-extract
        // action in the review queue, and retain the diagnostic on this job.
        // A crash can therefore produce neither stale approvable lines nor a
        // needs_review invoice whose failed job is later reaped as running.
        await updateInvoiceStatusTx(tx, actor, job.invoiceId, "processing", "needs_review");
        await writeExtractedLines(tx, actor, job.invoiceId, []);
        await updateJobStatusTx(tx, job.id, "running", "failed", {
          errorMessage: message.slice(0, 2000),
          errorCode,
          completedAt: new Date(),
        });
      });
      terminalizedAtomically = true;
    } catch (terminalizeErr) {
      // The failure may have happened before `uploaded -> processing`, or a
      // concurrent reaper may already have moved the job. Preserve the
      // original pipeline error and fall back to recording the job alone.
      console.error(
        `[extraction-pipeline] could not atomically terminalize failed job ${job.id} / invoice ${job.invoiceId}`,
        terminalizeErr,
      );
    }
    if (!terminalizedAtomically) {
      try {
        await updateJobStatus(job.id, "running", "failed", {
          errorMessage: message.slice(0, 2000),
          errorCode,
          completedAt: new Date(),
        });
      } catch (casErr) {
        // The job may already have moved (e.g. a concurrent reap won this same
        // race) — never let a failure to RECORD a failure crash the worker.
        console.error(`[extraction-pipeline] could not mark job ${job.id} as failed`, casErr);
      }
    }
    return { claimed: true, jobId: job.id, invoiceId: job.invoiceId, outcome: "failed", errorMessage: message };
  }
}

async function runClaimedJob(job: ExtractionJobRow, deps: ProcessExtractionQueueDeps): Promise<void> {
  const actor = systemActor(job.organizationId);
  const invoiceRow = await getInvoice(actor, job.invoiceId);

  if (invoiceRow.status === "needs_review") {
    // A prior attempt of THIS job already wrote lines and moved the invoice
    // to needs_review before dying (crash/reap between that write and this
    // job's own CAS to done) — finish the one remaining step rather than
    // re-running extraction (which would re-derive the same drafts anyway,
    // at the cost of a second Vision call) or refusing outright.
    await updateJobStatus(job.id, "running", "done", { completedAt: new Date() });
    return;
  }
  if (invoiceRow.status === "uploaded") {
    await updateInvoiceStatus(actor, job.invoiceId, "uploaded", "processing");
  } else if (invoiceRow.status !== "processing") {
    throw new Error(
      `Invoice ${job.invoiceId} is ${invoiceRow.status}, not uploaded or processing — refusing to (re-)extract.`,
    );
  }

  if (!invoiceRow.filePath) {
    throw new Error(`Invoice ${job.invoiceId} has no stored file to extract.`);
  }
  const resolvedPath = resolveStoredPath(invoiceRow.filePath);

  await setJobPhase(job.id, "classify");
  const classifyFn = deps.classifyPdf ?? classifyPdf;
  const processPdfFn = deps.processPdf ?? processPdf;
  const classification = await classifyFn(resolvedPath);
  // Persist classification immediately rather than only on `done`: it is the
  // evidence that explains why a failed job did or did not require Vision.
  await db
    .update(extractionJob)
    .set({ pdfType: classification.pdfType, pagesNeedingOcr: classification.pagesNeedingOcr })
    .where(eq(extractionJob.id, job.id));

  let markdown: string | null = null;
  if (classification.pdfType === "text" || classification.pdfType === "mixed") {
    await setJobPhase(job.id, "text_extract");
    const processed = await processPdfFn(resolvedPath);
    markdown = processed.markdown;
  } else {
    await setJobPhase(job.id, "ocr");
  }

  let parsed: ParsedExtraction;
  let extraction: ExtractInvoiceResult | null = null;
  if (classification.pdfType === "text") {
    if (!markdown) {
      throw new Error("pdf-inspector classified this PDF as text-based but returned no usable Markdown.");
    }
    await setJobPhase(job.id, "parse");
    parsed = parseLinesFromMarkdown(markdown);
  } else {
    // Mixed PDFs still need Vision because the extracted text layer is
    // incomplete; attach whatever markdown exists as ground truth for the
    // pages pdf-inspector could read.
    if (classification.pdfType === "mixed") {
      await setJobPhase(job.id, "ocr");
    }
    const readPdfFile = deps.readPdfFile ?? readFile;
    const bytes = await readPdfFile(resolvedPath);
    const extractFn = deps.extractInvoice ?? extractInvoice;
    extraction = await extractFn({
      pdfType: classification.pdfType,
      markdown,
      pdfBase64: bytes.toString("base64"),
    });
    await setJobPhase(job.id, "parse");
    parsed = parseLinesFromVision(extraction.raw);
  }
  const { header, lines } = parsed;

  // Slice 3: resolve whatever this vendor's SKUs already have an alias for.
  // Runs inside the existing "parse" phase — `extractionPhaseEnum`
  // (db/enums.ts) is a closed set and matching is fast, in-process, and part
  // of turning raw output into the draft this job persists, not a separate
  // observability-worthy phase of its own. `invoiceRow.vendorId` is already
  // tenant-scoped (this file's own header comment on the trust boundary
  // matching.ts documents) — resolved by `getInvoice(actor, ...)` above,
  // itself only ever set from an ownership-checked value when the invoice
  // was created.
  await matchLinesToProducts(lines, actor.organizationId, invoiceRow.vendorId);
  for (const line of lines) {
    if (line.matchedProductId == null) {
      line.exceptionFlags = [...(line.exceptionFlags ?? []), UNMATCHED_ITEM_FLAG];
    }
  }

  const arithmetic = arithmeticCheck(lines, header.totalGross != null ? Number(header.totalGross) : null);
  const crossCheck = pdfInspectorCrossCheck(lines, markdown);
  if (!arithmetic.pass || !crossCheck.pass) {
    if (lines.length === 0) {
      // A check failure is normally surfaced by flagging every line
      // "doesn't add up" — but there are no lines to flag here, and writing
      // zero drafts to needs_review would silently strand the mismatch: an
      // empty line table looks identical whether the invoice genuinely had
      // nothing to extract or the pipeline dropped everything on the floor.
      // Failing the job instead puts a real error in front of an operator,
      // rather than a plausible-looking "reviewed, all clear" invoice with
      // nothing on it (AGENTS.md's "nothing looks broken until weeks later"
      // failure mode).
      const reasons = [
        ...(!arithmetic.pass ? arithmetic.details : []),
        ...(!crossCheck.pass ? crossCheck.droppedLines : []),
      ];
      throw new Error(
        `Invoice ${job.invoiceId}: extraction produced zero lines but a check failed — ${reasons.join(" ")}`,
      );
    }
    for (const line of lines) {
      line.exceptionFlags = [...(line.exceptionFlags ?? []), "doesn't add up"];
    }
  }

  await db.transaction((tx) => writeExtractedLines(tx, actor, job.invoiceId, lines));

  const retentionUntil = header.invoiceDate ? computeRetentionUntil(header.invoiceDate) : null;
  await updateInvoiceStatus(actor, job.invoiceId, "processing", "needs_review", {
    invoiceDate: header.invoiceDate,
    invoiceNumber: header.invoiceNumber,
    totalGross: header.totalGross,
    totalDiscount: header.totalDiscount,
    totalNet: header.totalNet,
    currency: header.currency,
    pageCount: classification.pageCount,
    retentionUntil,
  });

  await updateJobStatus(job.id, "running", "done", {
    pdfType: classification.pdfType,
    pagesNeedingOcr: classification.pagesNeedingOcr,
    provider: extraction?.provider ?? null,
    modelId: extraction?.modelId ?? null,
    promptVersion: extraction?.promptVersion ?? null,
    rawResponse: extraction?.rawResponse ?? null,
    inputTokens: extraction?.inputTokens ?? null,
    outputTokens: extraction?.outputTokens ?? null,
    costUsd: extraction?.costUsd ?? null,
    completedAt: new Date(),
  });
}
