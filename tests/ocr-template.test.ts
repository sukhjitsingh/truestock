/**
 * Deterministic OCR vendor-template parser (PDF/OCR spike) — golden fixtures,
 * cross-layout identity, and the fail-closed behaviour the whole approach
 * depends on.
 *
 * Pure: no database, no network. The fixtures are SYNTHETIC ("Example Draft
 * Distributing", invented items, codes and prices) and copy only the
 * STRUCTURE and OCR quirks of the one real scanned layout the template was
 * authored against: reflowed lines, glued quantities, stray junk tokens,
 * amounts in a different order per resolution, pipe tables, a unicode minus.
 * They stand in for the same page rendered at 100/150/200/300 dpi.
 *
 * The properties that matter, in order:
 *   1. Every layout variant yields BYTE-IDENTICAL lines (the template is
 *      anchored on content, not on line breaks).
 *   2. Anything the template cannot prove it read correctly returns
 *      `ok: false` — which means "escalate to Claude Vision" — instead of a
 *      plausible-but-wrong answer. That includes every single-digit
 *      misread of an amount or quantity, swept exhaustively below.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DraftInvoiceLine } from "@/lib/domain/invoice-lines";
import { extractWithOcrTemplate } from "@/lib/domain/ocr-template/engine";
import { verifyOcrExtraction } from "@/lib/domain/ocr-template/gate";
import { normalizeOcrText } from "@/lib/domain/ocr-template/normalize";
import { draftDistributorScanned } from "@/lib/domain/ocr-template/templates/draft-distributor-scanned";
import type { OcrTemplateHeader, OcrTemplateResult } from "@/lib/domain/ocr-template/types";

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "ocr-template");
const VARIANTS = ["invoice-a-dpi100.md", "invoice-a-dpi150.md", "invoice-a-dpi200.md", "invoice-a-dpi300.md"] as const;

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

/** Replaces `from` with `to`, failing loudly if the fixture drifted and `from` is gone (a silent no-op would turn a mutation test into a false pass). */
function mutate(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`fixture no longer contains: ${from}`);
  return text.replace(from, to);
}

function expectOk(result: OcrTemplateResult): Extract<OcrTemplateResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok:true, got ${result.reason}: ${result.detail}`);
  return result;
}

/** Hand-written golden — deliberately NOT generated from the engine's own output. */
function expected(overrides: Partial<DraftInvoiceLine>): DraftInvoiceLine {
  return {
    lineNumber: 0,
    rawText: null,
    lineType: "product",
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

const EXPECTED_LINES: DraftInvoiceLine[] = [
  expected({
    lineNumber: 1,
    rawText: "1/6 KEG EMPTY DEPOSIT 1 $25.00 $25.00 -$25.00",
    lineType: "deposit_return",
    description: "1/6 KEG EMPTY DEPOSIT",
    quantity: "1.000",
    unitCost: "25.0000",
    extendedCost: "25.00",
    rawGross: "-25.00",
    rawNet: "25.00",
  }),
  expected({
    lineNumber: 2,
    rawText: "70101 Sample Brewer's Amber Ale 1/6 Keg 1 $80.00 $80.00 $105.00",
    vendorItemCode: "70101",
    description: "Sample Brewer's Amber Ale",
    packDescription: "1/6 Keg",
    quantity: "1.000",
    uom: "keg",
    unitCost: "80.0000",
    extendedCost: "80.00",
    rawGross: "105.00",
    rawNet: "80.00",
  }),
  expected({
    lineNumber: 3,
    rawText: "7220 Sample Lager 1/2 Keg 1 $140.00 $140.00 $190.00",
    vendorItemCode: "7220",
    description: "Sample Lager",
    packDescription: "1/2 Keg",
    quantity: "1.000",
    uom: "keg",
    unitCost: "140.0000",
    extendedCost: "140.00",
    rawGross: "190.00",
    rawNet: "140.00",
  }),
  expected({
    lineNumber: 4,
    rawText: "50123 Sample Hard Cider 4/6 Bottle 2 $21.50 $43.00 $43.00",
    vendorItemCode: "50123",
    description: "Sample Hard Cider",
    packDescription: "4/6 Bottle",
    quantity: "2.000",
    unitCost: "21.5000",
    extendedCost: "43.00",
    rawGross: "43.00",
    rawNet: "43.00",
  }),
  expected({
    lineNumber: 5,
    rawText: "6045 Sample Seltzer Mango 6/4 Can 1 $31.75 $31.75 $31.75",
    vendorItemCode: "6045",
    description: "Sample Seltzer Mango",
    packDescription: "6/4 Can",
    quantity: "1.000",
    unitCost: "31.7500",
    extendedCost: "31.75",
    rawGross: "31.75",
    rawNet: "31.75",
  }),
  expected({
    lineNumber: 6,
    rawText: "6046 Sample Seltzer Lime 6/4 Can 1 $31.75 $31.75 $31.75",
    vendorItemCode: "6046",
    description: "Sample Seltzer Lime",
    packDescription: "6/4 Can",
    quantity: "1.000",
    unitCost: "31.7500",
    extendedCost: "31.75",
    rawGross: "31.75",
    rawNet: "31.75",
  }),
];

const EXPECTED_HEADER: OcrTemplateHeader = {
  invoiceDate: "2027-03-14",
  invoiceNumber: "4455667",
  totalGross: "376.5000",
  totalDiscount: null,
  totalNet: null,
  currency: null,
};

describe("normalizeOcrText", () => {
  test("flattens markdown structure and newlines into single-spaced tokens", () => {
    expect(normalizeOcrText("# Title\n\n|a|b|\n|---|---|\n**c**  d")).toBe("Title a b c d");
  });

  test("reads accounting parentheses as negative money, but never a bare (1)", () => {
    expect(normalizeOcrText("($25.00) Refused (1) $25.00")).toBe("-$25.00 Refused (1) $25.00");
  });

  test("normalises dollar variants, glued quantities, minus signs and curly quotes", () => {
    expect(normalizeOcrText("1$17.00")).toBe("1 $17.00");
    expect(normalizeOcrText("$25.00$25.00")).toBe("$25.00 $25.00");
    expect(normalizeOcrText("＄5.00 $ 6.00")).toBe("$5.00 $6.00");
    expect(normalizeOcrText("−$5.00")).toBe("-$5.00");
    expect(normalizeOcrText("Brewer’s “Pale”")).toBe(`Brewer's "Pale"`);
  });

  test("never repairs characters: a misread digit must reach the gate as the wrong number it is", () => {
    expect(normalizeOcrText("S92.OO l5 O1 $9Z.00")).toBe("S92.OO l5 O1 $9Z.00");
  });

  test("is deterministic and idempotent on every fixture", () => {
    for (const name of VARIANTS) {
      const once = normalizeOcrText(fixture(name));
      expect(normalizeOcrText(fixture(name))).toBe(once);
      expect(normalizeOcrText(once)).toBe(once);
    }
  });
});

describe("golden extraction across layout variants", () => {
  for (const name of VARIANTS) {
    test(`${name} yields the golden header, lines and a passing gate`, () => {
      const result = expectOk(extractWithOcrTemplate(fixture(name)));
      expect(result.templateKey).toBe("draft-distributor-scanned-v1");
      expect(result.header).toEqual(EXPECTED_HEADER);
      expect(result.lines).toEqual(EXPECTED_LINES);
      expect(result.gate).toEqual({
        pass: true,
        failedChecks: [],
        sumGross: "376.50",
        printedTotal: "376.50",
        diff: "0.00",
      });
    });
  }

  test("lines are BYTE-identical across all four layout variants", () => {
    const serialised = VARIANTS.map((name) => JSON.stringify(expectOk(extractWithOcrTemplate(fixture(name))).lines));
    expect(new Set(serialised).size).toBe(1);
  });

  test("the four variants really are different pages (the identity above is not vacuous)", () => {
    const normalised = VARIANTS.map((name) => normalizeOcrText(fixture(name)));
    expect(new Set(normalised).size).toBe(VARIANTS.length);
  });
});

describe("deposits", () => {
  test("a returned-keg credit is a deposit_return with a negative gross, and it is counted in the gate sum", () => {
    const result = expectOk(extractWithOcrTemplate(fixture("invoice-a-dpi150.md")));
    expect(result.lines[0].lineType).toBe("deposit_return");
    expect(result.lines[0].rawGross).toBe("-25.00");
    // Products alone sum to 401.50; only the -25.00 credit reaches the printed 376.50.
    expect(result.gate.sumGross).toBe("376.50");
  });

  test("the same row printed as a positive amount is a deposit charge", () => {
    let text = mutate(fixture("invoice-a-dpi150.md"), "($25.00)", "$25.00");
    text = mutate(text, "Total $376.50 $376.50", "Total $426.50 $426.50");
    const result = expectOk(extractWithOcrTemplate(text));
    expect(result.lines[0].lineType).toBe("deposit");
    expect(result.lines[0].rawGross).toBe("25.00");
  });

  test("a deposit is never folded into product cost: the keg row's cost excludes the deposit embedded in its total", () => {
    const keg = expectOk(extractWithOcrTemplate(fixture("invoice-a-dpi150.md"))).lines[1];
    expect(keg.unitCost).toBe("80.0000");
    expect(keg.extendedCost).toBe("80.00");
    expect(keg.rawGross).toBe("105.00");
  });

  test("dropping the deposit row makes the sum miss the printed total, so deposits really are in the check", () => {
    const text = mutate(
      fixture("invoice-a-dpi150.md"),
      "#### 1/6 KEG EMPTY DEPOSIT\n\n$25.00 ($25.00) Refused (1) $25.00\n\n",
      "",
    );
    const result = extractWithOcrTemplate(text);
    if (result.ok || result.reason !== "gate-failed") throw new Error("expected gate-failed");
    expect(result.gate.failedChecks.map((failure) => failure.check)).toEqual(["gross-sum-mismatch"]);
    expect(result.gate.diff).toBe("25.00");
  });
});

describe("the gate refuses what it cannot prove", () => {
  test("a single flipped digit in a lone printed total fails the sum check", () => {
    const text = mutate(fixture("invoice-a-dpi150.md"), "Total $376.50 $376.50", "Total $376.90");
    const result = extractWithOcrTemplate(text);
    if (result.ok || result.reason !== "gate-failed") throw new Error("expected gate-failed");
    expect(result.gate.failedChecks.map((failure) => failure.check)).toEqual(["gross-sum-mismatch"]);
    expect(result.gate.diff).toBe("-0.40");
  });

  test("two printings of the total that disagree make the total unreadable, which fails closed", () => {
    const text = mutate(fixture("invoice-a-dpi150.md"), "Total $376.50 $376.50", "Total $376.50 $376.90");
    const result = extractWithOcrTemplate(text);
    if (result.ok || result.reason !== "gate-failed") throw new Error("expected gate-failed");
    expect(result.header.totalGross).toBeNull();
    expect(result.gate.failedChecks.map((failure) => failure.check)).toEqual(["printed-total-missing"]);
  });

  test("a missing printed total fails (unlike the pipeline's arithmeticCheck, which passes on null)", () => {
    const text = mutate(fixture("invoice-a-dpi150.md"), "Total $376.50 $376.50\n\n$0.00 Receipt Check Num\n", "");
    const result = extractWithOcrTemplate(text);
    if (result.ok || result.reason !== "gate-failed") throw new Error("expected gate-failed");
    expect(result.gate.failedChecks.map((failure) => failure.check)).toEqual(["printed-total-missing"]);
  });

  test("every single-digit misread of an amount or quantity is refused, except a last-cents-digit slip of the TOTAL column", () => {
    const base = fixture("invoice-a-dpi150.md");
    const flips: { index: number; lastCentsDigit: boolean }[] = [];

    // Every digit of every money token, bar the final "$0.00" amount-received
    // field (not part of any extracted value, so flipping it changes nothing).
    const money = [...base.matchAll(/\$\d[\d,]*\.\d{2}/g)].slice(0, -1);
    for (const match of money) {
      const start = match.index as number;
      for (let offset = 0; offset < match[0].length; offset++) {
        if (/\d/.test(match[0][offset])) {
          flips.push({ index: start + offset, lastCentsDigit: offset === match[0].length - 1 });
        }
      }
    }
    // Every quantity digit: a bare number directly before a `$`, and the
    // deposit row's "Refused (1)" (not the phone number, which is no quantity).
    for (const match of base.matchAll(/(?<![\w$.,/()-])\d{1,3}(?=\s*\$)/g)) {
      flips.push({ index: match.index as number, lastCentsDigit: false });
    }
    for (const match of base.matchAll(/(?<=Refused \()\d{1,3}(?=\))/g)) {
      flips.push({ index: match.index as number, lastCentsDigit: false });
    }
    expect(flips.length).toBeGreaterThan(60);

    let accepted = 0;
    for (const { index, lastCentsDigit } of flips) {
      const digit = Number(base[index]);
      const mutated = base.slice(0, index) + String((digit + 1) % 10) + base.slice(index + 1);
      const result = extractWithOcrTemplate(mutated);
      if (!result.ok) continue;
      accepted++;
      // The only way through is a +1 cent slip in the last cents digit of a
      // row's TOTAL: the gate tolerates 2 cents on the sum (the pipeline's own
      // tolerance, kept so rounding noise is not rejected) and the TOTAL is
      // the one amount no other relationship on the row cross-checks.
      expect(lastCentsDigit).toBe(true);
      expect(result.gate.sumGross).toBe("376.51");
    }
    // Pin the tolerated set so a loosened gate cannot hide inside "accepted":
    // 10 = the cents digit of each product row's TOTAL, where rows that print
    // two or three equal amounts (43.00, 31.75) let any of them be the one
    // that slipped (1 + 1 + 2 + 3 + 3).
    expect(accepted).toBe(10);
  });
});

describe("verifyOcrExtraction on its own", () => {
  const header: OcrTemplateHeader = EXPECTED_HEADER;
  const withLine = (index: number, patch: Partial<DraftInvoiceLine>) =>
    EXPECTED_LINES.map((line, i) => (i === index ? { ...line, ...patch } : line));
  const checks = (lines: DraftInvoiceLine[], h = header) =>
    verifyOcrExtraction(h, lines).failedChecks.map((failure) => failure.check);

  test("passes the golden lines", () => {
    expect(verifyOcrExtraction(header, EXPECTED_LINES).pass).toBe(true);
  });

  test("a flipped digit in one line's gross fails the sum", () => {
    expect(checks(withLine(2, { rawGross: "180.00" }))).toEqual(["gross-sum-mismatch"]);
  });

  test("a flipped quantity digit fails the line's own arithmetic, which no total can see", () => {
    expect(checks(withLine(3, { quantity: "7.000" }))).toEqual(["line-arithmetic"]);
  });

  test("a one-cent unit-cost slip passes only inside the 1-cent line tolerance", () => {
    expect(checks(withLine(1, { unitCost: "80.0100" }))).toEqual([]);
    expect(checks(withLine(1, { unitCost: "80.0200" }))).toEqual(["line-arithmetic"]);
  });

  test("a line with an unread quantity cannot be verified, so it fails rather than being skipped", () => {
    expect(checks(withLine(3, { quantity: null }))).toEqual(["line-arithmetic"]);
    expect(checks(withLine(3, { unitCost: null }))).toEqual(["line-arithmetic"]);
    expect(checks(withLine(3, { extendedCost: null }))).toEqual(["line-arithmetic"]);
  });

  test("a missing printed total fails", () => {
    expect(checks(EXPECTED_LINES, { ...header, totalGross: null })).toEqual(["printed-total-missing"]);
  });

  test("no lines fails", () => {
    expect(checks([])).toEqual(["no-lines"]);
  });

  test("a line with no gross fails instead of being quietly left out of the sum", () => {
    expect(checks(withLine(4, { rawGross: null }))).toEqual(["line-gross-missing"]);
  });

  test("a deposit credit must be negative", () => {
    expect(checks(withLine(0, { rawGross: "25.00" }))).toContain("line-sign");
  });

  test("leaving the deposit credit out of the sum is a mismatch", () => {
    expect(checks(EXPECTED_LINES.filter((line) => line.lineType !== "deposit_return"))).toEqual(["gross-sum-mismatch"]);
  });

  test("never throws, even on malformed input", () => {
    const result = verifyOcrExtraction(header, null as unknown as DraftInvoiceLine[]);
    expect(result.pass).toBe(false);
    expect(result.failedChecks.map((failure) => failure.check)).toContain("gate-internal-error");
  });
});

describe("fail-closed behaviour (ok:false means escalate to Claude Vision)", () => {
  test("an unrelated document has no template", () => {
    const result = extractWithOcrTemplate("# Quarterly report\n\nRevenue grew 4%.");
    expect(result).toEqual({
      ok: false,
      reason: "no-template",
      detail: "No registered template (of 1) matched this document.",
    });
  });

  test("a document missing one structural anchor is not claimed", () => {
    const text = mutate(fixture("invoice-a-dpi150.md"), "Load Sheet", "Load Sheat");
    expect(extractWithOcrTemplate(text)).toMatchObject({ ok: false, reason: "no-template" });
  });

  test("an empty registry has no template", () => {
    expect(extractWithOcrTemplate(fixture("invoice-a-dpi150.md"), [])).toMatchObject({
      ok: false,
      reason: "no-template",
    });
  });

  test("two templates claiming one document are both refused, never picked between", () => {
    const result = extractWithOcrTemplate(fixture("invoice-a-dpi150.md"), [
      draftDistributorScanned,
      { ...draftDistributorScanned, key: "duplicate" },
    ]);
    expect(result).toMatchObject({ ok: false, reason: "no-template" });
    expect(result.ok ? "" : result.detail).toContain("refusing");
  });

  test("a row with an extra amount (a printed discount) is not guessed at", () => {
    const text = mutate(fixture("invoice-a-dpi150.md"), "1 $80.00 $105.00 $80.00", "1 $80.00 $5.00 $105.00 $75.00");
    expect(extractWithOcrTemplate(text)).toMatchObject({ ok: false, reason: "parse-failed" });
  });

  test("amounts detached from their rows (phone-photo reading order) fail closed", () => {
    const detached = [
      "Date Customer Invoice Load Sheet Route 03/14/2027 4455667 998877 12 TS Mon ID PRODUCT QTY PRICE",
      "1/6 KEG EMPTY DEPOSIT Refused (1) $25.00",
      "70101 Sample Brewer's Amber Ale 1/6 Keg $80.00 7220 Sample Lager 1/2 Keg 1 $140.00",
      "50123 Sample Hard Cider 4/6 Bottle 2 $21.50 6045 Sample Seltzer Mango 6/4 Can $31.75",
      "TOTAL NET DISC $25.00 ($25.00) $105.00 $190.00 $140.00 $80.00 $43.00 $43.00 $31.75 $31.75",
      "Total $376.50",
    ].join("\n\n");
    expect(extractWithOcrTemplate(detached)).toMatchObject({ ok: false, reason: "parse-failed" });
  });

  test("a quantity of zero leaves two equally valid pairings, so the row is refused rather than guessed", () => {
    const text = mutate(fixture("invoice-a-dpi150.md"), "2 $21.50 $43.00 $43.00", "0 $5.00 $0.00 $7.00");
    expect(extractWithOcrTemplate(text)).toMatchObject({ ok: false, reason: "parse-failed" });
  });

  test("a quantity the OCR dropped stays null (never guessed as 1) and the unverifiable line fails the gate", () => {
    // The real scan loses a lone "1" at one resolution; the amounts still pair
    // up (net == price) so the engine can build the row, but it cannot certify it.
    const text = mutate(fixture("invoice-a-dpi150.md"), "1 $31.75 $31.75 $31.75 4", "$31.75 $31.75 $31.75 4");
    const result = extractWithOcrTemplate(text);
    if (result.ok || result.reason !== "gate-failed") throw new Error("expected gate-failed");
    expect(result.lines.slice(0, 5)).toEqual(EXPECTED_LINES.slice(0, 5));
    expect(result.lines[5]).toEqual({
      ...EXPECTED_LINES[5],
      rawText: "6046 Sample Seltzer Lime 6/4 Can $31.75 $31.75 $31.75",
      quantity: null,
    });
    expect(result.gate.failedChecks).toEqual([
      expect.objectContaining({ check: "line-arithmetic", lineNumber: 6 }),
    ]);
    // The sum still ties out, so this failure is purely the unread quantity.
    expect(result.gate.diff).toBe("0.00");
  });

  test("an impossible calendar date leaves invoiceDate null instead of a wrong date", () => {
    const text = mutate(fixture("invoice-a-dpi150.md"), "03/14/2027", "13/45/2027");
    expect(expectOk(extractWithOcrTemplate(text)).header.invoiceDate).toBeNull();
  });

  test("garbage input returns ok:false and never throws", () => {
    const inputs: unknown[] = [
      "",
      "   \n\t  ",
      "\u0000￿|||###***",
      "$1.00 ".repeat(50_000),
      "1/6 Keg ".repeat(20_000),
      "|---|---|\n".repeat(5_000),
      undefined,
      null,
      42,
      { markdown: "x" },
    ];
    for (const input of inputs) {
      const result = extractWithOcrTemplate(input as string);
      expect(result.ok).toBe(false);
    }
  });
});
