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
