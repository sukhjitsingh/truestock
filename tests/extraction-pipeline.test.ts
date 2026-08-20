/**
 * Extraction pipeline internals — Phase 2.5, Slice 2. Covers the pure,
 * network-free stages `lib/domain/extraction-pipeline.ts` exports
 * specifically so they're testable without a Vision call or a real PDF
 * (`parseLinesFromVision`, `arithmeticCheck`, `pdfInspectorCrossCheck`), plus
 * `writeExtractedLines`'s cross-tenant ownership check [invariant 9], which
 * this pipeline is the only caller of.
 *
 * Deliberately separate from `tests/extraction-job-lifecycle.test.ts` (the
 * job claim/reap/transition machinery) and `tests/invoice-write-path.test.ts`
 * (upload/confirm) — this file is about what happens to the DATA once a job
 * is running, not the job's own state machine.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { extractionJob, invoice } from "@/db/schema";
import {
  parseLinesFromMarkdown,
  parseLinesFromVision,
  arithmeticCheck,
  pdfInspectorCrossCheck,
  processExtractionQueue,
} from "@/lib/domain/extraction-pipeline";
import { writeExtractedLines, type DraftInvoiceLine } from "@/lib/domain/invoice-lines";
import { NotFoundError } from "@/lib/domain/errors";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";

let fx: Fixtures;

beforeAll(async () => {
  await migrateTestDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  fx = await createFixtures();
});

afterAll(async () => {
  await closePool();
});

/** A minimal, fully-null/unmatched draft line — every test overrides only the fields it cares about. */
function draftLine(overrides: Partial<DraftInvoiceLine> = {}): DraftInvoiceLine {
  return {
    lineNumber: 1,
    rawText: null,
    lineType: "unknown",
    vendorItemCode: null,
    description: null,
    packDescription: null,
    quantity: null,
    uom: null,
    packSize: null,
    unitCost: null,
    extendedCost: null,
    rawGross: null,
    rawDiscount: null,
    rawNet: null,
    exceptionFlags: null,
    extractionConfidence: null,
    matchedProductId: null,
    matchedVendorAliasId: null,
    matchMethod: "unmatched",
    matchConfidence: null,
    ...overrides,
  };
}

const PERFORMANCE_TEXT_INVOICE_MARKDOWN = `
Performance Foodservice - Arizona
Fed ID: 84-0629503  Delv Date: 07/30/26

| DATE | INVOICE | TRIP | ACCT NO | STOP | PAGE |
|---|---|---|---|---|---|
| 07/30/26 | 693655 | 455 | 4733 | 160 | 1 |

| QUANTITY | QUANTITY | UNIT | SIZE | BRAND | ITEM NUMBER | DESCRIPTION | PORTION | PORTION | PORTION | PORTION | TAX | UNIT PRICE | EXTENSION |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ORDER | SHIP | UNIT | SIZE | BRAND | ITEM NUMBER | DESCRIPTION | # OF | RU | UN | RC UN | TAX | UNIT PRICE | EXTENSION |
|  | 1 | CS | 4/10 LB | WSTCRK | FD252 | CHICKEN LEG QTR RAW CVP FRFZ | 640 | 1 | OZ | .038 |  | 24.53 | 24.53 |
|  | 2 | CS | 1/25 LB | PKFRSH | NH700 | ONION RED MED FRESH | 400 | 1 | OZ | .021 |  | 8.55 | 17.10 |
|  | 1 | EA | 1/1 CNT | CATG78 | F4794 | FUEL SURCHARGE | 1 | 1 | EA | 9.000 |  | 9.00 | 9.00 |

559.86  PAY THIS AMOUNT
ALL PAYMENTS IN U.S. CURRENCY
`;

/**
 * Open items #34/#35/#36/#37. Reproduces the STRUCTURE of a real Southern
 * Glazer's Wine & Spirits "Order History" portal-export invoice (hand-traced
 * against a real invoice by a prior session, see open item #36) with entirely
 * FABRICATED product names, account info, and prices — never the real
 * invoice's numbers. Arithmetic is self-consistent: line gross/discount/net
 * amounts sum exactly to the header's Gross/Discount/Net Total.
 *
 * Shape under test: "Item Name" as the description header (#37), a compound
 * "N Cases"/"N Units" quantity cell (never a bare number), "Gross/Discount/Net
 * Amount" per-line columns (not the bare "Gross/Discount/Net" this pipeline
 * also has to recognize), a "Document Date" header (not "Invoice Date"), and
 * a header/totals table whose first cell is polluted by a legal footnote
 * concatenated onto the "Total Cases" figure while its other cells
 * ("Gross Total"/"Discount Total"/"Net Total") stay clean and sit as an
 * embedded label row with no separator of its own, immediately followed by
 * the row holding the actual totals.
 */
const SOUTHERN_GLAZERS_SYNTHETIC_MARKDOWN = `
## INVOICE FOR:

**Invoice Number: 9000001**

|Document Date|Account ID|Address|||
|---|---|---|---|---|
|03/15/2026|99999|100 SAMPLE ST ANYTOWN, Arizona 85000|||
|Total Cases|Total Units|Gross Total|Discount Total|Net Total|
|2 *Taxes and Fees are included in Gross Total and Net Total above. Please refer to post-delivery invoice for additional details and final pricing information.|3|$300.00|$60.00|$240.00|

# Associated Items

|Item Name|Quantity|Gross Amount|Discount Amount|Net Amount|
|---|---|---|---|---|
|SAMPLE VODKA 80 111111 • 1.0L • 12 Case • SCREW CAP|1 Cases|$180.00|$36.00|$144.00|
|SAMPLE GIN 80 222222 • 1.0L • 6 Case • ALTERNATIVE • GLASS|1 Units|$60.00|$12.00|$48.00|
|SAMPLE BOURBON 90 333333 • 1.0L • 12 Case • SCREW CAP • GLASS|1 Units|$60.00|$12.00|$48.00|
`;

describe("parseLinesFromMarkdown", () => {
  test("maps a text invoice's multi-row table without Claude and leaves unprinted values null", () => {
    const parsed = parseLinesFromMarkdown(PERFORMANCE_TEXT_INVOICE_MARKDOWN);

    expect(parsed.header).toEqual({
      invoiceDate: "2026-07-30",
      invoiceNumber: "693655",
      totalGross: null,
      totalDiscount: null,
      totalNet: "559.8600",
      currency: "USD",
    });
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.lines[0]).toMatchObject({
      lineNumber: 1,
      lineType: "product",
      vendorItemCode: "FD252",
      description: "WSTCRK CHICKEN LEG QTR RAW CVP FRFZ",
      packDescription: "4/10 LB",
      quantity: "1.000",
      uom: "case",
      packSize: 4,
      unitCost: "24.5300",
      extendedCost: "24.53",
      rawGross: null,
      rawNet: null,
      extractionConfidence: null,
    });
    expect(parsed.lines[2].lineType).toBe("freight");
  });

  test("fails explicitly when text exists but no recognizable line-item table exists", () => {
    expect(() => parseLinesFromMarkdown("Invoice 1234\nNo table was recovered.")).toThrow(
      "no recognizable invoice line-item table",
    );
  });

  test("classifies common standalone charges conservatively without keyword-matching product names", () => {
    const parsed = parseLinesFromMarkdown(`
| DESCRIPTION | ITEM NUMBER | QUANTITY | AMOUNT |
|---|---|---|---|
| STATE LIQUOR TAX | TAX-1 | 1 | 12.00 |
| CRV FEE | FEE-1 | 1 | 3.00 |
| BOTTLE DEPOSIT CREDIT | DEP-1 | 1 | (5.00) |
| DELIVERY VODKA 750ML | SKU-1 | 1 | 20.00 |
`);

    expect(parsed.lines.map((line) => line.lineType)).toEqual(["tax", "fee", "deposit_return", "product"]);
  });

  test("does not coerce formatting-only or JavaScript numeric syntax into plausible invoice amounts", () => {
    const parsed = parseLinesFromMarkdown(`
| DESCRIPTION | ITEM NUMBER | QUANTITY | AMOUNT |
|---|---|---|---|
| FORMAT ONLY | SKU-1 | 1 | $ |
| COMMA ONLY | SKU-2 | 1 | , |
| HEX TOKEN | SKU-3 | 1 | 0x10 |
| EXPONENT TOKEN | SKU-4 | 1 | 1e3 |
`);

    expect(parsed.lines.map((line) => line.extendedCost)).toEqual([null, null, null, null]);
  });

  test(
    "parses a real vendor portal-export shape (Southern Glazer's, open item #37) end to end: 'Item Name' as the " +
      "description header, compound 'N Cases'/'N Units' quantity cells split into quantity+uom, 'Gross/Discount/Net " +
      "Amount' per-line columns, a 'Document Date' header resolving invoiceDate, and the footnote-polluted " +
      "Gross/Discount/Net Total row embedded (with no separator of its own) inside the SAME table as the address " +
      "block. Also proves open item #5's >=2-row unrecognized-table guard does NOT false-positive on that " +
      "address/totals table, which would otherwise satisfy its row/numeric-cell thresholds — if it did, this whole " +
      "parse would throw and every assertion below would never run.",
    () => {
      const parsed = parseLinesFromMarkdown(SOUTHERN_GLAZERS_SYNTHETIC_MARKDOWN);

      expect(parsed.header.invoiceDate).toBe("2026-03-15");
      expect(parsed.header.invoiceNumber).toBe("9000001");
      // Header totals are formatted at scale 4 (toDecimalString(value, 4)),
      // same as PERFORMANCE_TEXT_INVOICE_MARKDOWN's totalNet: "559.8600" above.
      expect(parsed.header.totalGross).toBe("300.0000");
      expect(parsed.header.totalDiscount).toBe("60.0000");
      expect(parsed.header.totalNet).toBe("240.0000");

      expect(parsed.lines).toHaveLength(3);
      // The compound "Item Name" cell is kept intact, unsplit — AGENTS.md:
      // "leave a field null rather than guessing" applies just as much to
      // guessing where to CUT a field as to guessing its value.
      expect(parsed.lines[0].description).toBe("SAMPLE VODKA 80 111111 • 1.0L • 12 Case • SCREW CAP");
      expect(parsed.lines[0].quantity).toBe("1.000");
      expect(parsed.lines[0].uom).toBe("case"); // from the compound cell "1 Cases"
      expect(parsed.lines[1].uom).toBe("each"); // from "1 Units"
      expect(parsed.lines[2].uom).toBe("each"); // from "1 Units"

      expect(parsed.lines.map((line) => line.rawGross)).toEqual(["180.00", "60.00", "60.00"]);
      expect(parsed.lines.map((line) => line.rawDiscount)).toEqual(["36.00", "12.00", "12.00"]);
      expect(parsed.lines.map((line) => line.rawNet)).toEqual(["144.00", "48.00", "48.00"]);

      // This vendor's format never prints unit cost, extension, a separate
      // item code, or a pack size — asserting null (not a guess) is itself
      // part of proving "no silent fabrication."
      for (const line of parsed.lines) {
        expect(line.unitCost).toBeNull();
        expect(line.extendedCost).toBeNull();
        expect(line.vendorItemCode).toBeNull();
        expect(line.packSize).toBeNull();
      }
    },
  );

  test("the Southern Glazer's-shaped fixture's line gross amounts sum exactly to the invoice's printed totalGross, proving the arithmetic cross-check would pass for this vendor shape", () => {
    const parsed = parseLinesFromMarkdown(SOUTHERN_GLAZERS_SYNTHETIC_MARKDOWN);
    const sumRawGross = parsed.lines.reduce((total, line) => total + Number(line.rawGross), 0);
    expect(sumRawGross.toFixed(2)).toBe("300.00");
    expect(Number(parsed.header.totalGross)).toBeCloseTo(300, 2);
  });

  test("open item #35: an out-of-range US-style date (month 13, day 45) resolves invoiceDate to null instead of a silently rolled-over Date.UTC value", () => {
    const parsed = parseLinesFromMarkdown(`
| Invoice Date | Description | Quantity | Amount |
|---|---|---|---|
| 13/45/2026 | Sample Widget | 1 | 10.00 |
`);
    expect(parsed.header.invoiceDate).toBeNull();
  });

  test("open item #35: an out-of-range ISO-style date (month 13, day 45) resolves invoiceDate to null instead of a silently rolled-over Date.UTC value", () => {
    const parsed = parseLinesFromMarkdown(`
| Invoice Date | Description | Quantity | Amount |
|---|---|---|---|
| 2026-13-45 | Sample Widget | 1 | 10.00 |
`);
    expect(parsed.header.invoiceDate).toBeNull();
  });

  test(
    "an ordinary bare Subtotal/Tax/Total summary block does NOT trip the >=2-row unrecognized-table guard, even " +
      "though it satisfies the row/numeric-cell thresholds and its labels don't match TOTAL_LABEL_HEADER_PATTERNS " +
      "(which requires 'gross'/'discount'/'net' combined with 'total', not bare 'Subtotal'/'Tax'/'Total') — a " +
      "regression guard for a real false-positive: this 2-column summary shape is common on ordinary printed " +
      "invoices and previously made the guard throw away the WHOLE extraction, including a real, correctly-parsed " +
      "line-item table sitting right next to it",
    () => {
      const parsed = parseLinesFromMarkdown(`
| DESCRIPTION | ITEM NUMBER | QUANTITY | AMOUNT |
|---|---|---|---|
| DELIVERY VODKA 750ML | SKU-1 | 1 | 20.00 |

| Label | Amount |
|---|---|
| Subtotal | $100.00 |
| Tax | $8.00 |
| Total | $108.00 |
`);

      expect(parsed.lines).toHaveLength(1);
      expect(parsed.lines[0].description).toBe("DELIVERY VODKA 750ML");
    },
  );

  test("a genuinely unrecognized 3+ column real line-item table (unrecognized description header, but a real repeating product/quantity/price shape) still throws — the 3-column floor above narrows the false-positive, it does not gut the detection", () => {
    expect(() =>
      parseLinesFromMarkdown(`
| Merchandise | Qty | Price |
|---|---|---|
| Product A | 3 | 9.99 |
| Product B | 2 | 5.00 |
`),
    ).toThrow("refusing to write a partial result");
  });
});

describe("text-PDF queue routing", () => {
  test("a text job reaches needs_review/done without invoking the Claude dependency", async () => {
    await db
      .update(invoice)
      .set({
        status: "uploaded",
        pageCount: null,
        invoiceDate: null,
        invoiceNumber: null,
        totalGross: null,
        totalDiscount: null,
        totalNet: null,
        currency: null,
        retentionUntil: null,
      })
      .where(eq(invoice.id, fx.invoiceId));
    await db
      .update(extractionJob)
      .set({
        status: "queued",
        phase: null,
        pdfType: null,
        completedAt: null,
      })
      .where(eq(extractionJob.id, fx.extractionJobId));

    let claudeWasCalled = false;
    const result = await processExtractionQueue("text-routing-test", {
      classifyPdf: async () => ({
        pdfType: "text",
        pageCount: 1,
        confidence: 1,
        pagesNeedingOcr: [],
      }),
      processPdf: async () => ({ markdown: PERFORMANCE_TEXT_INVOICE_MARKDOWN, pagesWithTables: [1] }),
      extractInvoice: async () => {
        claudeWasCalled = true;
        throw new Error("Claude must not be called for a text PDF");
      },
    });

    expect(result).toMatchObject({
      claimed: true,
      jobId: fx.extractionJobId,
      invoiceId: fx.invoiceId,
      outcome: "done",
    });
    expect(claudeWasCalled).toBe(false);

    const [savedInvoice, savedJob, savedLines] = await Promise.all([
      db.query.invoice.findFirst({ where: (row, { eq }) => eq(row.id, fx.invoiceId) }),
      db.query.extractionJob.findFirst({ where: (row, { eq }) => eq(row.id, fx.extractionJobId) }),
      db.query.invoiceLine.findMany({
        where: (row, { eq }) => eq(row.invoiceId, fx.invoiceId),
        orderBy: (row, { asc }) => asc(row.lineNumber),
      }),
    ]);
    expect(savedInvoice?.status).toBe("needs_review");
    expect(savedInvoice?.invoiceNumber).toBe("693655");
    expect(savedJob).toMatchObject({
      status: "done",
      phase: "parse",
      pdfType: "text",
      provider: null,
      modelId: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
    expect(savedLines.map((line) => line.vendorItemCode)).toEqual(["FD252", "NH700", "F4794"]);
    expect(savedLines.map((line) => line.exceptionFlags)).toEqual([
      ["unmatched item"],
      ["unmatched item"],
      ["unmatched item"],
    ]);
  });

  test("a text parser failure fails the job but moves the invoice out of processing into the review queue", async () => {
    await db
      .update(invoice)
      .set({ status: "uploaded" })
      .where(eq(invoice.id, fx.invoiceId));
    await db
      .update(extractionJob)
      .set({ status: "queued", phase: null, pdfType: null, completedAt: null })
      .where(eq(extractionJob.id, fx.extractionJobId));

    const result = await processExtractionQueue("text-parser-failure-test", {
      classifyPdf: async () => ({
        pdfType: "text",
        pageCount: 1,
        confidence: 1,
        pagesNeedingOcr: [],
      }),
      processPdf: async () => ({ markdown: "Invoice 693655\nNo table was recovered.", pagesWithTables: [] }),
      extractInvoice: async () => {
        throw new Error("Claude must not be called for a text PDF");
      },
    });

    expect(result).toMatchObject({
      claimed: true,
      jobId: fx.extractionJobId,
      invoiceId: fx.invoiceId,
      outcome: "failed",
      errorMessage: expect.stringContaining("no recognizable invoice line-item table"),
    });
    const [savedInvoice, savedJob, savedLines] = await Promise.all([
      db.query.invoice.findFirst({ where: (row, { eq }) => eq(row.id, fx.invoiceId) }),
      db.query.extractionJob.findFirst({ where: (row, { eq }) => eq(row.id, fx.extractionJobId) }),
      db.query.invoiceLine.findMany({ where: (row, { eq }) => eq(row.invoiceId, fx.invoiceId) }),
    ]);
    expect(savedInvoice?.status).toBe("needs_review");
    expect(savedJob?.status).toBe("failed");
    expect(savedJob?.pdfType).toBe("text");
    expect(savedJob?.errorMessage).toContain("no recognizable invoice line-item table");
    expect(savedLines).toHaveLength(0);
  });

  test("a scanned job without the Anthropic key fails specifically in the Vision branch and clears stale drafts", async () => {
    await db
      .update(invoice)
      .set({ status: "uploaded" })
      .where(eq(invoice.id, fx.invoiceId));
    await db
      .update(extractionJob)
      .set({ status: "queued", phase: null, pdfType: null, completedAt: null })
      .where(eq(extractionJob.id, fx.extractionJobId));

    const missingKeyMessage =
      "ANTHROPIC_API_KEY is not set; it is required for scanned, mixed, or image-based invoice extraction.";
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    let result: Awaited<ReturnType<typeof processExtractionQueue>>;
    try {
      result = await processExtractionQueue("scanned-missing-key-test", {
        classifyPdf: async () => ({
          pdfType: "scanned",
          pageCount: 1,
          confidence: 1,
          pagesNeedingOcr: [0],
        }),
        readPdfFile: async () => Buffer.from("%PDF-1.4 test fixture"),
      });
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousApiKey;
      }
    }

    expect(result).toMatchObject({
      claimed: true,
      jobId: fx.extractionJobId,
      invoiceId: fx.invoiceId,
      outcome: "failed",
      errorMessage: missingKeyMessage,
    });
    const [savedInvoice, savedJob, savedLines] = await Promise.all([
      db.query.invoice.findFirst({ where: (row, { eq }) => eq(row.id, fx.invoiceId) }),
      db.query.extractionJob.findFirst({ where: (row, { eq }) => eq(row.id, fx.extractionJobId) }),
      db.query.invoiceLine.findMany({ where: (row, { eq }) => eq(row.invoiceId, fx.invoiceId) }),
    ]);
    expect(savedInvoice?.status).toBe("needs_review");
    expect(savedJob).toMatchObject({
      status: "failed",
      phase: "ocr",
      pdfType: "scanned",
      pagesNeedingOcr: [0],
      errorMessage: missingKeyMessage,
    });
    expect(savedLines).toHaveLength(0);
  });

  test("open item #34: a mixed-classified job fetches pdf-inspector's markdown as pdfInspectorCrossCheck ground truth AND calls Claude Vision for the actual line extraction, saving the Vision-derived lines rather than anything derived from the markdown", async () => {
    await db
      .update(invoice)
      .set({ status: "uploaded" })
      .where(eq(invoice.id, fx.invoiceId));
    await db
      .update(extractionJob)
      .set({ status: "queued", phase: null, pdfType: null, completedAt: null })
      .where(eq(extractionJob.id, fx.extractionJobId));

    let processPdfCalled = false;
    let extractInvoiceCalled = false;
    // Small markdown table returned as "ground truth" by processPdf — has a
    // DIFFERENT description than the Vision result below, so the assertions
    // can prove which one the saved line actually came from.
    const MIXED_GROUND_TRUTH_MARKDOWN = [
      "| Description | Quantity | Amount |",
      "|---|---|---|",
      "| Markdown Ground Truth Item | 1 | 999.00 |",
    ].join("\n");

    const result = await processExtractionQueue("mixed-routing-test", {
      classifyPdf: async () => ({
        pdfType: "mixed",
        pageCount: 1,
        confidence: 0.6,
        pagesNeedingOcr: [0],
      }),
      processPdf: async () => {
        processPdfCalled = true;
        return { markdown: MIXED_GROUND_TRUTH_MARKDOWN, pagesWithTables: [1] };
      },
      readPdfFile: async () => Buffer.from("%PDF-1.4 test fixture"),
      extractInvoice: async () => {
        extractInvoiceCalled = true;
        return {
          raw: {
            invoiceDate: "2026-08-01",
            invoiceNumber: "MIXED-1",
            totalGross: 50,
            totalDiscount: null,
            totalNet: 50,
            currency: "USD",
            lines: [
              {
                rawText: "1 case Vision Extracted Item (from Vision)",
                lineType: "product",
                vendorItemCode: "VISION-SKU-1",
                description: "Vision Extracted Item (from Vision)",
                packDescription: null,
                quantity: 1,
                uom: "case",
                packSize: 12,
                unitCost: 50,
                extendedCost: 50,
                rawGross: 50,
                rawDiscount: null,
                rawNet: 50,
                confidence: 0.95,
              },
            ],
          },
          provider: "anthropic",
          modelId: "claude-sonnet-5",
          promptVersion: "invoice-extraction-v1",
          rawResponse: {},
          inputTokens: 100,
          outputTokens: 50,
          costUsd: "0.001000",
        };
      },
    });

    expect(result).toMatchObject({
      claimed: true,
      jobId: fx.extractionJobId,
      invoiceId: fx.invoiceId,
      outcome: "done",
    });
    // Both halves of the mixed branch must run: markdown fetched as
    // cross-check ground truth, AND Vision called for the actual extraction.
    expect(processPdfCalled).toBe(true);
    expect(extractInvoiceCalled).toBe(true);

    const [savedJob, savedLines] = await Promise.all([
      db.query.extractionJob.findFirst({ where: (row, { eq }) => eq(row.id, fx.extractionJobId) }),
      db.query.invoiceLine.findMany({
        where: (row, { eq }) => eq(row.invoiceId, fx.invoiceId),
        orderBy: (row, { asc }) => asc(row.lineNumber),
      }),
    ]);
    expect(savedJob?.pdfType).toBe("mixed");
    expect(savedLines).toHaveLength(1);
    // The saved line carries the Vision-derived fields, never anything
    // derived from MIXED_GROUND_TRUTH_MARKDOWN's "Markdown Ground Truth Item".
    expect(savedLines[0].description).toBe("Vision Extracted Item (from Vision)");
    expect(savedLines[0].vendorItemCode).toBe("VISION-SKU-1");
  });
});

describe("parseLinesFromVision", () => {
  test(
    "re-validates raw Vision output against the schema independently of the SDK's own zodOutputFormat check, and rejects an out-of-bounds field the same way any other boundary input would be rejected. " +
      "MUTATION-CHECKED reasoning: if parseLinesFromVision skipped its own extractedInvoiceSchema.parse() and merely cast `raw`, a hallucinated 600-character description (over invoice_line.description's varchar(512)) would sail through this function and fail only much later as an opaque MariaDB 'Data too long' error inside writeExtractedLines's INSERT — not a clean, attributable Zod error at the AI/domain boundary this test is checking for.",
    () => {
      const raw = {
        invoiceDate: "2026-08-01",
        invoiceNumber: "INV-1",
        totalGross: 100,
        totalDiscount: null,
        totalNet: 100,
        currency: "USD",
        lines: [
          {
            rawText: "1 case Coors Light",
            lineType: "product",
            vendorItemCode: "SKU-1",
            description: "x".repeat(513), // one over invoice_line.description's varchar(512)
            packDescription: null,
            quantity: 1,
            uom: "case",
            packSize: 24,
            unitCost: 100,
            extendedCost: 100,
            rawGross: 100,
            rawDiscount: null,
            rawNet: 100,
            confidence: 0.9,
          },
        ],
      };

      expect(() => parseLinesFromVision(raw)).toThrow();
    },
  );

  test("renumbers lines 1..N by array position, ignoring whatever lineNumber-like ordering Claude implied — a repeated or skipped number across a multi-page document must not collide against invoice_line_invoice_lineno_unique", () => {
    const raw = {
      invoiceDate: null,
      invoiceNumber: null,
      totalGross: null,
      totalDiscount: null,
      totalNet: null,
      currency: null,
      lines: [
        { rawText: "first", lineType: "product", vendorItemCode: null, description: null, packDescription: null, quantity: null, uom: null, packSize: null, unitCost: null, extendedCost: null, rawGross: null, rawDiscount: null, rawNet: null, confidence: null },
        { rawText: "second", lineType: "product", vendorItemCode: null, description: null, packDescription: null, quantity: null, uom: null, packSize: null, unitCost: null, extendedCost: null, rawGross: null, rawDiscount: null, rawNet: null, confidence: null },
      ],
    };

    const { lines } = parseLinesFromVision(raw);
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2]);
    expect(lines.map((l) => l.rawText)).toEqual(["first", "second"]);
  });

  test(
    "an unrecognised lineType degrades to 'unknown' rather than failing the whole document's extraction over one bad line, and an unrecognised uom degrades to the honest category 'other' rather than null — but a uom Claude never mentioned at all stays null, not 'other'. " +
      "MUTATION-CHECKED reasoning: collapsing 'a value Claude got wrong' and 'a value Claude never provided' onto the same fallback would make every draft line look equally uncertain about UOM, hiding the difference between 'the model tried and said something unexpected' and 'nothing was printed to read.'",
    () => {
      const raw = {
        invoiceDate: null,
        invoiceNumber: null,
        totalGross: null,
        totalDiscount: null,
        totalNet: null,
        currency: null,
        lines: [
          { rawText: "a", lineType: "surcharge", vendorItemCode: null, description: null, packDescription: null, quantity: null, uom: "gallon", packSize: null, unitCost: null, extendedCost: null, rawGross: null, rawDiscount: null, rawNet: null, confidence: null },
          { rawText: "b", lineType: "product", vendorItemCode: null, description: null, packDescription: null, quantity: null, uom: null, packSize: null, unitCost: null, extendedCost: null, rawGross: null, rawDiscount: null, rawNet: null, confidence: null },
        ],
      };

      const { lines } = parseLinesFromVision(raw);
      expect(lines[0].lineType).toBe("unknown");
      expect(lines[0].uom).toBe("other");
      expect(lines[1].uom).toBeNull();
    },
  );

  test("a malformed 3-letter currency check rejects garbage but accepts and uppercases a valid ISO code", () => {
    const rawGarbage = {
      invoiceDate: null,
      invoiceNumber: null,
      totalGross: null,
      totalDiscount: null,
      totalNet: null,
      currency: "US Dollars",
      lines: [],
    };
    expect(parseLinesFromVision(rawGarbage).header.currency).toBeNull();

    const rawValid = { ...rawGarbage, currency: "usd" };
    expect(parseLinesFromVision(rawValid).header.currency).toBe("USD");
  });
});

describe("arithmeticCheck", () => {
  test("a null expected total passes unconditionally — an absent header total is an absence of a claim to check against, not a contradiction of one", () => {
    const lines = [draftLine({ rawGross: "999999.99" })];
    expect(arithmeticCheck(lines, null)).toEqual({ pass: true });
  });

  test(
    "a line with no rawGross is excluded from the sum rather than treated as 0, so a genuinely-matching invoice still passes even though one line couldn't be read. " +
      "MUTATION-CHECKED reasoning: coercing a null rawGross to 0 would make this same input compute a mismatch (missing $20) and incorrectly flag every line 'doesn't add up' for a document that actually reconciles once you account for what wasn't extracted.",
    () => {
      const lines = [draftLine({ lineNumber: 1, rawGross: "80.00" }), draftLine({ lineNumber: 2, rawGross: null })];
      const result = arithmeticCheck(lines, 80);
      expect(result.pass).toBe(true);
    },
  );

  test("a sum within the $0.02 rounding tolerance passes and reports the small overage/shortfall", () => {
    const over = arithmeticCheck([draftLine({ rawGross: "100.01" })], 100);
    expect(over).toEqual({ pass: true, overage: 0.01 });

    const under = arithmeticCheck([draftLine({ rawGross: "99.99" })], 100);
    expect(under).toEqual({ pass: true, shortfall: 0.01 });
  });

  test("a sum outside tolerance fails with the mismatch amount and a human-readable detail", () => {
    const result = arithmeticCheck([draftLine({ rawGross: "50.00" })], 100);
    expect(result.pass).toBe(false);
    if (!result.pass) {
      expect(result.mismatch).toBeCloseTo(-50, 2);
      expect(result.details[0]).toContain("does not match");
    }
  });
});

describe("pdfInspectorCrossCheck", () => {
  const MARKDOWN_TWO_ROW_TABLE = ["| Item | Qty |", "|---|---|", "| Coors Light | 2 |", "| Bud Light | 1 |"].join("\n");

  test("no markdown (scanned/image PDF with no text layer) produces no signal — pass: true", () => {
    expect(pdfInspectorCrossCheck([draftLine()], null)).toEqual({ pass: true });
  });

  test("markdown with no table syntax (prose-rendered invoice) produces no signal", () => {
    expect(pdfInspectorCrossCheck([draftLine()], "Just some prose, no pipe tables here.")).toEqual({ pass: true });
  });

  test(
    "fewer structured lines than markdown table rows fails with a dropped-line count. " +
      "MUTATION-CHECKED reasoning: if the header/separator rows weren't subtracted before comparing, a 2-data-row table (4 raw pipe rows including header+separator) would always outnumber a correctly-extracted 2-line document, permanently flagging every mixed/text invoice as if a line had been dropped when none was.",
    () => {
      const result = pdfInspectorCrossCheck([draftLine({ lineNumber: 1 })], MARKDOWN_TWO_ROW_TABLE);
      expect(result.pass).toBe(false);
      if (!result.pass) {
        expect(result.droppedLines[0]).toContain("2 table row(s)");
        expect(result.droppedLines[0]).toContain("only 1 line(s)");
      }
    },
  );

  test("lines count matching (or exceeding) the table row count passes", () => {
    const lines = [draftLine({ lineNumber: 1 }), draftLine({ lineNumber: 2 })];
    expect(pdfInspectorCrossCheck(lines, MARKDOWN_TWO_ROW_TABLE)).toEqual({ pass: true });
  });
});

describe("writeExtractedLines ownership check", () => {
  test(
    "an actor from a DIFFERENT organization cannot write draft lines onto another tenant's invoice — NotFoundError, never a write. " +
      "MUTATION-CHECKED reasoning: if writeExtractedLines only existence-checked invoiceId (a bare `WHERE id = ?`, no organizationId predicate) rather than ownership-checking it [invariant 9], this call would succeed and silently overwrite fx.owner's real invoice_line rows with fx.otherOwner's extraction output — cross-tenant data corruption with no error anywhere.",
    async () => {
      const attempt = db.transaction((tx) =>
        writeExtractedLines(tx, fx.otherOwner, fx.invoiceId, [draftLine({ rawText: "attacker line" })]),
      );
      await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
    },
  );

  test("the same actor writing onto their OWN invoice succeeds, replacing prior drafts wholesale (delete-then-insert, not merge)", async () => {
    const written = await db.transaction((tx) =>
      writeExtractedLines(tx, fx.owner, fx.invoiceId, [
        draftLine({ lineNumber: 1, rawText: "new draft line", rawGross: "42.00" }),
      ]),
    );
    expect(written).toBe(1);

    const rows = await db.query.invoiceLine.findMany({ where: (l, { eq }) => eq(l.invoiceId, fx.invoiceId) });
    expect(rows).toHaveLength(1);
    expect(rows[0].rawText).toBe("new draft line");
  });

  test("writing an empty line set clears prior drafts and returns 0, without inserting anything", async () => {
    const written = await db.transaction((tx) => writeExtractedLines(tx, fx.owner, fx.invoiceId, []));
    expect(written).toBe(0);

    const rows = await db.query.invoiceLine.findMany({ where: (l, { eq }) => eq(l.invoiceId, fx.invoiceId) });
    expect(rows).toHaveLength(0);
  });
});
