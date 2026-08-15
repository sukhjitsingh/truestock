/**
 * The extraction pipeline itself — Phase 2.5, Slice 2.
 *
 * `processExtractionQueue` is the cron tick body (`instrumentation.ts` calls
 * it on an interval): claim -> CAS invoice `uploaded -> processing` -> classify
 * (`@firecrawl/pdf-inspector`) -> extract (Claude Vision) -> parse -> checks ->
 * write lines + header -> CAS invoice `processing -> needs_review` -> CAS job
 * `running -> done`. Every other function here is one stage of that pipeline,
 * exported individually so each is unit-testable without a network call or a
 * real PDF.
 *
 * ## Scope this slice deliberately does NOT cover
 *
 * `matchedProductId`/`matchMethod` stay `unmatched` on every line this
 * pipeline writes (Slice 3's `vendor_item_alias` matching does not exist
 * yet). Of the four exception badges `invoice_line.exceptionFlags` can carry
 * ("price jump", "duplicate", "doesn't add up", "unmatched item"), this
 * pipeline only ever emits two: "unmatched item" (universal this slice, for
 * the same reason `matchMethod` is universal) and "doesn't add up" (from
 * `arithmeticCheck`/`pdfInspectorCrossCheck` failing). "price jump" needs
 * `product_cost_history` (Slice 4) and "duplicate" needs cross-invoice
 * comparison — neither exists yet, so neither is invented here.
 *
 * ## Why every job routes through Claude Vision, not a markdown-only path
 *
 * `03-program-design.md` names a `parseLinesFromMarkdown` for `TextBased`
 * PDFs, as a non-AI alternative to the vision call. This file does not build
 * it: every classification (`text`, `mixed`, `scanned`, `image`) calls
 * `extractInvoice`, varying only `effort` (`low` for `text`, `medium`
 * otherwise) and whether pdf-inspector's markdown is attached as anchor text
 * alongside the raw PDF bytes. Two reasons. First, a real invoice's layout
 * (multi-column, footnoted discounts, a totals block that doesn't reconcile
 * to the line items without an aside) is exactly what a bespoke
 * markdown-table parser gets wrong first, and this project has exactly zero
 * real invoice samples to develop or test one against yet — the AI path
 * degrades to "extraction confidence is a little lower without an OCR page,"
 * not "silently drops a column." Second, one call path is one thing to keep
 * correct instead of two, and `pdfInspectorCrossCheck` still gets full value
 * from pdf-inspector's markdown as an independent check against whatever
 * Claude returns, whichever classification produced it. Flagged here as an
 * interpretation of an ambiguous brief, not a silent scope cut — worth
 * revisiting once real invoices are on hand to benchmark a markdown-only
 * path's accuracy against this one's token cost.
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
import { claimNextJob, updateJobStatus, type ExtractionJobRow } from "@/lib/domain/extraction";
import { getInvoice, updateInvoiceStatus, computeRetentionUntil } from "@/lib/domain/invoices";
import { writeExtractedLines, type DraftInvoiceLine, type InvoiceLineType, type InvoiceLineUom } from "@/lib/domain/invoice-lines";
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
    throw new Error("ANTHROPIC_API_KEY is not set.");
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
    exceptionFlags: ["unmatched item"],
    extractionConfidence: toDecimalString(line.confidence, 3),
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

function countMarkdownTableDataRows(markdown: string): number {
  const pipeRows = markdown.split("\n").filter((row) => /^\s*\|.*\|\s*$/.test(row));
  // Every markdown pipe-table pdf-inspector emits has one header row and one
  // separator row (`|---|---|`) ahead of its data rows.
  const separatorRows = pipeRows.filter((row) => /^\s*\|[\s:|-]+\|\s*$/.test(row)).length;
  return Math.max(0, pipeRows.length - separatorRows * 2);
}

/**
 * A heuristic, not a guaranteed line-level diff: counts pdf-inspector's own
 * markdown table rows and compares that count against how many lines Claude
 * actually returned. Fewer structured lines than markdown table rows is a
 * plausible signal that Claude dropped one, worth a human's attention — it
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
  const classification = await classifyPdf(resolvedPath);

  let markdown: string | null = null;
  if (classification.pdfType === "text" || classification.pdfType === "mixed") {
    await setJobPhase(job.id, "text_extract");
    const processed = await processPdf(resolvedPath);
    markdown = processed.markdown;
  } else {
    await setJobPhase(job.id, "ocr");
  }

  const bytes = await readFile(resolvedPath);
  const extractFn = deps.extractInvoice ?? extractInvoice;
  const extraction = await extractFn({
    pdfType: classification.pdfType,
    markdown,
    pdfBase64: bytes.toString("base64"),
  });

  await setJobPhase(job.id, "parse");
  const { header, lines } = parseLinesFromVision(extraction.raw);

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
    provider: extraction.provider,
    modelId: extraction.modelId,
    promptVersion: extraction.promptVersion,
    rawResponse: extraction.rawResponse,
    inputTokens: extraction.inputTokens,
    outputTokens: extraction.outputTokens,
    costUsd: extraction.costUsd,
    completedAt: new Date(),
  });
}
