/**
 * Photographed invoices through the extraction pipeline.
 *
 * The upload form accepts JPEG/PNG/WebP, but `runClaimedJob` used to hand every
 * stored file to pdf-inspector (which throws "Not a PDF" on a photo) and
 * `extractInvoice` always sent a `document`/`application/pdf` block — so every
 * photographed invoice was accepted, stored, then failed extraction. These
 * tests pin the fix: a photo skips the pdf-inspector stages entirely, is
 * recorded as `pdfType: "image"`, and reaches Vision with its real media type;
 * a PDF is untouched; HEIC (which the Claude API cannot read) is refused at
 * upload validation and, if one is already stored, fails the job with an
 * actionable message instead of reaching Vision.
 *
 * The Claude Vision call is STUBBED throughout — no network, no key. What is
 * proven here is the routing and the request shape (`buildSourceBlock`), not
 * that the live API reads a given photo.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, closePool } from "@/db";
import { extractionJob, invoice } from "@/db/schema";
import {
  processExtractionQueue,
  buildSourceBlock,
  type ExtractionDoc,
  type ExtractInvoiceResult,
  type ProcessExtractionQueueDeps,
} from "@/lib/domain/extraction-pipeline";
import {
  ACCEPTED_INVOICE_CONTENT_TYPES,
  contentTypeForPath,
  extensionForContentType,
  isVisionImageContentType,
  MAX_VISION_IMAGE_BYTES,
  visionImageSizeProblem,
} from "@/lib/storage/invoice-content-types";
import { invoiceStorageKey } from "@/lib/storage/invoice-files";
import { uploadInvoiceSchema } from "@/lib/validation/invoices";
import { migrateTestDatabase, resetDatabase, createFixtures, type Fixtures } from "./helpers/test-db";

let fx: Fixtures;

beforeAll(async () => {
  await migrateTestDatabase();
});

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
// Pure helpers — no database
// ---------------------------------------------------------------------------

describe("buildSourceBlock", () => {
  test("defaults to a document block with media_type application/pdf, so every pre-photo caller is unchanged", () => {
    expect(buildSourceBlock({ pdfBase64: "QUJD" })).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "QUJD" },
    });
    expect(buildSourceBlock({ pdfBase64: "QUJD", mediaType: "application/pdf" })).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "QUJD" },
    });
  });

  test.each(["image/jpeg", "image/png", "image/webp"] as const)(
    "%s becomes an image block carrying that exact media_type — never a document",
    (mediaType) => {
      expect(buildSourceBlock({ pdfBase64: "QUJD", mediaType })).toEqual({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: "QUJD" },
      });
    },
  );
});

describe("contentTypeForPath", () => {
  test("maps every stored extension back to its content type", () => {
    expect(contentTypeForPath("7/42.pdf")).toBe("application/pdf");
    expect(contentTypeForPath("7/42.jpg")).toBe("image/jpeg");
    expect(contentTypeForPath("7/42.jpeg")).toBe("image/jpeg");
    expect(contentTypeForPath("7/42.png")).toBe("image/png");
    expect(contentTypeForPath("7/42.webp")).toBe("image/webp");
    expect(contentTypeForPath("7/42.heic")).toBe("image/heic");
    expect(contentTypeForPath("7/42.PDF")).toBe("application/pdf");
  });

  test("is the inverse of the key a real upload gets", () => {
    for (const type of ACCEPTED_INVOICE_CONTENT_TYPES) {
      expect(contentTypeForPath(invoiceStorageKey(3, 9, type))).toBe(type);
    }
  });

  test("returns null — never a guess — for .bin, no extension, a bare dotfile, or a dot in a directory name", () => {
    expect(contentTypeForPath("7/42.bin")).toBeNull();
    expect(contentTypeForPath("7/42")).toBeNull();
    expect(contentTypeForPath("7/.pdf")).toBeNull();
    expect(contentTypeForPath("v1.pdf/42")).toBeNull();
    expect(contentTypeForPath("7/42.exe")).toBeNull();
  });

  test("only JPEG, PNG and WebP are Vision-readable images — not HEIC, not a PDF", () => {
    expect(isVisionImageContentType("image/jpeg")).toBe(true);
    expect(isVisionImageContentType("image/png")).toBe(true);
    expect(isVisionImageContentType("image/webp")).toBe(true);
    expect(isVisionImageContentType("image/heic")).toBe(false);
    expect(isVisionImageContentType("application/pdf")).toBe(false);
  });
});

describe("visionImageSizeProblem", () => {
  test("a photo at or under the limit has no problem", () => {
    expect(visionImageSizeProblem("image/jpeg", 1)).toBeNull();
    expect(visionImageSizeProblem("image/webp", MAX_VISION_IMAGE_BYTES)).toBeNull();
  });

  test("a photo over the limit says its size and the limit in decimal MB", () => {
    const message = visionImageSizeProblem("image/jpeg", 12_300_000);
    expect(message).toContain("12.3 MB");
    expect(message).toContain("7.5 MB");
  });

  test("one byte over never reads as the limit itself", () => {
    // Rounding the size to the nearest tenth printed "7.5 MB, and photos over
    // 7.5 MB can't be read" — a refusal that contradicts itself. The size
    // rounds up, so it always reads larger than the cap beside it.
    const message = visionImageSizeProblem("image/jpeg", MAX_VISION_IMAGE_BYTES + 1);
    expect(message).toContain("This photo is 7.6 MB");
    expect(message).toContain("photos over 7.5 MB");
    expect(visionImageSizeProblem("image/jpeg", 8_000_000)).toContain("This photo is 8.0 MB");
  });

  test("the limit is the BASE64 one: 7.5 MB of file encodes to 10 MB", () => {
    expect(Math.ceil(MAX_VISION_IMAGE_BYTES / 3) * 4).toBeLessThanOrEqual(10_000_000);
  });

  test("a PDF is never bounded here, however large", () => {
    expect(visionImageSizeProblem("application/pdf", 24_000_000)).toBeNull();
  });
});

describe("upload validation accepts what extraction can read", () => {
  const base = { source: "photo" as const, fileSha256: "a".repeat(64), fileSizeBytes: 1024 };

  test.each(["application/pdf", "image/jpeg", "image/png", "image/webp"])("accepts %s", (contentType) => {
    expect(uploadInvoiceSchema.safeParse({ ...base, contentType }).success).toBe(true);
  });

  test("refuses image/heic, which the Claude API cannot read", () => {
    const parsed = uploadInvoiceSchema.safeParse({ ...base, contentType: "image/heic" });
    expect(parsed.success).toBe(false);
    expect(ACCEPTED_INVOICE_CONTENT_TYPES).not.toContain("image/heic");
  });

  test("refuses an oversize photo at upload, on the size field, with the limit and a way out", () => {
    const parsed = uploadInvoiceSchema.safeParse({
      ...base,
      contentType: "image/jpeg",
      fileSizeBytes: MAX_VISION_IMAGE_BYTES + 1,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      expect(issue.path).toEqual(["fileSizeBytes"]);
      expect(issue.message).toContain("7.5 MB");
      expect(issue.message).toContain("upload a PDF");
    }
  });

  test("accepts a photo at the limit, and a PDF far above it (the 25 MB ceiling still applies)", () => {
    const at = { ...base, contentType: "image/png", fileSizeBytes: MAX_VISION_IMAGE_BYTES };
    expect(uploadInvoiceSchema.safeParse(at).success).toBe(true);
    const bigPdf = { ...base, contentType: "application/pdf", fileSizeBytes: 20 * 1024 * 1024 };
    expect(uploadInvoiceSchema.safeParse(bigPdf).success).toBe(true);
    const tooBig = { ...base, contentType: "application/pdf", fileSizeBytes: 26 * 1024 * 1024 };
    expect(uploadInvoiceSchema.safeParse(tooBig).success).toBe(false);
  });

  test("a HEIC file already stored still gets its real extension, not .bin", () => {
    expect(extensionForContentType("image/heic")).toBe(".heic");
    expect(invoiceStorageKey(1, 1, "image/heic")).toBe("1/1.heic");
  });
});

// ---------------------------------------------------------------------------
// Through the real queue (real MariaDB, stubbed Vision)
// ---------------------------------------------------------------------------

/** First bytes of each format — the stubbed reader returns these, so the base64 assertion proves the file's own bytes reach Vision. */
const PNG_BYTES = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("fixture")]);
const JPEG_BYTES = Buffer.concat([Buffer.from("ffd8ffe0", "hex"), Buffer.from("fixture")]);
const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.from("0000", "hex"), Buffer.from("WEBPfixture")]);
const PDF_BYTES = Buffer.from("%PDF-1.4 test fixture");

function visionResult(): ExtractInvoiceResult {
  return {
    raw: {
      invoiceDate: "2026-08-01",
      invoiceNumber: "PHOTO-1",
      totalGross: 50,
      totalDiscount: null,
      totalNet: 50,
      currency: "USD",
      lines: [
        {
          rawText: "1 case Photographed Item",
          lineType: "product",
          vendorItemCode: "PHOTO-SKU-1",
          description: "Photographed Item",
          packDescription: null,
          quantity: 1,
          uom: "case",
          packSize: 12,
          unitCost: 50,
          extendedCost: 50,
          rawGross: 50,
          rawDiscount: null,
          rawNet: 50,
          confidence: 0.9,
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
}

/** Puts the fixture invoice back in `uploaded` with the given stored path and queues its job. */
async function queueInvoiceAt(filePath: string): Promise<void> {
  await db
    .update(invoice)
    .set({ status: "uploaded", filePath, pageCount: null })
    .where(eq(invoice.id, fx.invoiceId));
  await db
    .update(extractionJob)
    .set({ status: "queued", phase: null, pdfType: null, pagesNeedingOcr: null, completedAt: null })
    .where(eq(extractionJob.id, fx.extractionJobId));
}

/** Every pdf-inspector entry point, wired to record and throw — a photo must reach none of them. */
function pdfInspectorTripwires() {
  const calls = { classifyPdf: 0, processPdf: 0, processPdfWithOcr: 0 };
  const deps: ProcessExtractionQueueDeps = {
    classifyPdf: async () => {
      calls.classifyPdf += 1;
      throw new Error("classifyPdf must not be called for a photo");
    },
    processPdf: async () => {
      calls.processPdf += 1;
      throw new Error("processPdf must not be called for a photo");
    },
    processPdfWithOcr: async () => {
      calls.processPdfWithOcr += 1;
      throw new Error("processPdfWithOcr must not be called for a photo");
    },
  };
  return { calls, deps };
}

async function readState() {
  const [savedInvoice, savedJob, savedLines] = await Promise.all([
    db.query.invoice.findFirst({ where: (row, { eq }) => eq(row.id, fx.invoiceId) }),
    db.query.extractionJob.findFirst({ where: (row, { eq }) => eq(row.id, fx.extractionJobId) }),
    db.query.invoiceLine.findMany({ where: (row, { eq }) => eq(row.invoiceId, fx.invoiceId) }),
  ]);
  return { savedInvoice, savedJob, savedLines };
}

describe("photo queue routing", () => {
  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixtures();
  });

  const photoCases = [
    { contentType: "image/png", bytes: PNG_BYTES },
    { contentType: "image/jpeg", bytes: JPEG_BYTES },
    { contentType: "image/webp", bytes: WEBP_BYTES },
  ] as const;

  for (const { contentType, bytes } of photoCases) {
    test(`a ${contentType} upload skips pdf-inspector, reaches Vision as that media type, and ends done / needs_review like a PDF`, async () => {
      await queueInvoiceAt(invoiceStorageKey(fx.organizationId, fx.invoiceId, contentType));
      const { calls, deps } = pdfInspectorTripwires();
      const docs: ExtractionDoc[] = [];

      const result = await processExtractionQueue(`photo-${contentType}`, {
        ...deps,
        readPdfFile: async () => bytes,
        extractInvoice: async (doc) => {
          docs.push(doc);
          return visionResult();
        },
      });

      expect(result).toMatchObject({
        claimed: true,
        jobId: fx.extractionJobId,
        invoiceId: fx.invoiceId,
        outcome: "done",
      });
      expect(calls).toEqual({ classifyPdf: 0, processPdf: 0, processPdfWithOcr: 0 });

      expect(docs).toHaveLength(1);
      expect(docs[0].mediaType).toBe(contentType);
      expect(docs[0].pdfType).toBe("image");
      expect(docs[0].markdown).toBeNull();
      // The file's own bytes — not a re-encoding, not a placeholder.
      expect(docs[0].pdfBase64).toBe(bytes.toString("base64"));

      const { savedInvoice, savedJob, savedLines } = await readState();
      expect(savedInvoice?.status).toBe("needs_review");
      expect(savedInvoice?.pageCount).toBe(1);
      expect(savedInvoice?.invoiceNumber).toBe("PHOTO-1");
      expect(savedJob).toMatchObject({
        status: "done",
        phase: "parse",
        pdfType: "image",
        pagesNeedingOcr: [0],
        provider: "anthropic",
        modelId: "claude-sonnet-5",
      });
      expect(savedLines.map((line) => line.vendorItemCode)).toEqual(["PHOTO-SKU-1"]);
    });
  }

  test("the doc the pipeline builds for a photo yields an image block through buildSourceBlock, not a document block", async () => {
    await queueInvoiceAt(invoiceStorageKey(fx.organizationId, fx.invoiceId, "image/jpeg"));
    const blocks: ReturnType<typeof buildSourceBlock>[] = [];

    await processExtractionQueue("photo-source-block", {
      ...pdfInspectorTripwires().deps,
      readPdfFile: async () => JPEG_BYTES,
      extractInvoice: async (doc) => {
        blocks.push(buildSourceBlock(doc));
        return visionResult();
      },
    });

    expect(blocks).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: JPEG_BYTES.toString("base64") },
      },
    ]);
  });

  test("a scanned PDF still classifies and still reaches Vision as a plain document — no mediaType key on the doc", async () => {
    await queueInvoiceAt(invoiceStorageKey(fx.organizationId, fx.invoiceId, "application/pdf"));
    let classifyCalls = 0;
    const docs: ExtractionDoc[] = [];

    const result = await processExtractionQueue("pdf-regression", {
      classifyPdf: async () => {
        classifyCalls += 1;
        return { pdfType: "scanned", pageCount: 2, confidence: 1, pagesNeedingOcr: [0, 1] };
      },
      processPdfWithOcr: async () => ({ markdown: "", pagesRecommendingHosted: [1, 2], pagesRoutedToOcr: [] }),
      readPdfFile: async () => PDF_BYTES,
      extractInvoice: async (doc) => {
        docs.push(doc);
        return visionResult();
      },
    });

    expect(result).toMatchObject({ claimed: true, outcome: "done" });
    expect(classifyCalls).toBe(1);
    expect(docs).toHaveLength(1);
    expect("mediaType" in docs[0]).toBe(false);
    expect(buildSourceBlock(docs[0])).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: PDF_BYTES.toString("base64") },
    });

    const { savedInvoice, savedJob } = await readState();
    expect(savedInvoice?.status).toBe("needs_review");
    expect(savedInvoice?.pageCount).toBe(2);
    expect(savedJob).toMatchObject({ status: "done", pdfType: "scanned", pagesNeedingOcr: [0, 1] });
  });

  test("a stored .heic fails the job with an actionable message, leaves processing, and never reaches the file read or Vision", async () => {
    await queueInvoiceAt(invoiceStorageKey(fx.organizationId, fx.invoiceId, "image/heic"));
    const { calls, deps } = pdfInspectorTripwires();
    let fileRead = false;
    let visionCalled = false;

    const result = await processExtractionQueue("heic", {
      ...deps,
      readPdfFile: async () => {
        fileRead = true;
        return Buffer.from("heic bytes");
      },
      extractInvoice: async () => {
        visionCalled = true;
        return visionResult();
      },
    });

    const message = "HEIC photos aren't supported — re-upload as JPEG or PDF.";
    expect(result).toMatchObject({
      claimed: true,
      jobId: fx.extractionJobId,
      invoiceId: fx.invoiceId,
      outcome: "failed",
      errorMessage: message,
    });
    expect(fileRead).toBe(false);
    expect(visionCalled).toBe(false);
    expect(calls).toEqual({ classifyPdf: 0, processPdf: 0, processPdfWithOcr: 0 });

    const { savedInvoice, savedJob, savedLines } = await readState();
    // Out of `processing` and into the review queue where Reject/re-extract lives.
    expect(savedInvoice?.status).toBe("needs_review");
    expect(savedJob).toMatchObject({ status: "failed", errorMessage: message });
    expect(savedLines).toHaveLength(0);
  });

  test("a stored photo over the Vision limit fails the job with the size in the message and never reaches Vision", async () => {
    await queueInvoiceAt(invoiceStorageKey(fx.organizationId, fx.invoiceId, "image/jpeg"));
    const { calls, deps } = pdfInspectorTripwires();
    let visionCalled = false;

    const result = await processExtractionQueue("oversize-photo", {
      ...deps,
      // The REAL bytes decide, not whatever size the upload declared.
      readPdfFile: async () => Buffer.alloc(MAX_VISION_IMAGE_BYTES + 1),
      extractInvoice: async () => {
        visionCalled = true;
        return visionResult();
      },
    });

    expect(result).toMatchObject({
      claimed: true,
      jobId: fx.extractionJobId,
      outcome: "failed",
      errorMessage: expect.stringMatching(/photos over 7\.5 MB can't be read.*lower resolution/),
    });
    expect(visionCalled).toBe(false);
    expect(calls).toEqual({ classifyPdf: 0, processPdf: 0, processPdfWithOcr: 0 });

    const { savedInvoice, savedJob, savedLines } = await readState();
    expect(savedInvoice?.status).toBe("needs_review");
    expect(savedJob?.status).toBe("failed");
    expect(savedLines).toHaveLength(0);
  });

  test("a photo exactly at the limit is still sent", async () => {
    await queueInvoiceAt(invoiceStorageKey(fx.organizationId, fx.invoiceId, "image/png"));
    let visionCalled = false;

    const result = await processExtractionQueue("limit-photo", {
      ...pdfInspectorTripwires().deps,
      readPdfFile: async () => Buffer.alloc(MAX_VISION_IMAGE_BYTES),
      extractInvoice: async () => {
        visionCalled = true;
        return visionResult();
      },
    });

    expect(result).toMatchObject({ claimed: true, outcome: "done" });
    expect(visionCalled).toBe(true);
  });

  test("a large PDF is not held to the photo limit", async () => {
    await queueInvoiceAt(invoiceStorageKey(fx.organizationId, fx.invoiceId, "application/pdf"));
    const docs: ExtractionDoc[] = [];

    const result = await processExtractionQueue("big-pdf", {
      classifyPdf: async () => ({ pdfType: "scanned", pageCount: 9, confidence: 1, pagesNeedingOcr: [0] }),
      processPdfWithOcr: async () => ({ markdown: "", pagesRecommendingHosted: [1], pagesRoutedToOcr: [] }),
      readPdfFile: async () => Buffer.alloc(MAX_VISION_IMAGE_BYTES + 1),
      extractInvoice: async (doc) => {
        docs.push(doc);
        return visionResult();
      },
    });

    expect(result).toMatchObject({ claimed: true, outcome: "done" });
    expect(docs).toHaveLength(1);
  });

  test("a stored file with an unrecognised extension fails the job rather than being guessed to be a PDF", async () => {
    await queueInvoiceAt(`${fx.organizationId}/${fx.invoiceId}.bin`);
    let classifyCalls = 0;
    let visionCalled = false;

    const result = await processExtractionQueue("unknown-ext", {
      classifyPdf: async () => {
        classifyCalls += 1;
        return { pdfType: "text", pageCount: 1, confidence: 1, pagesNeedingOcr: [] };
      },
      readPdfFile: async () => PDF_BYTES,
      extractInvoice: async () => {
        visionCalled = true;
        return visionResult();
      },
    });

    expect(result).toMatchObject({
      claimed: true,
      outcome: "failed",
      errorMessage: expect.stringContaining("not a recognised type"),
    });
    expect(classifyCalls).toBe(0);
    expect(visionCalled).toBe(false);

    const { savedInvoice, savedJob } = await readState();
    expect(savedInvoice?.status).toBe("needs_review");
    expect(savedJob?.status).toBe("failed");
  });
});
