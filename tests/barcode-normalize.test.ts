/**
 * lib/barcode.ts — one barcode, one written form (docs/plans/barcode-integrity,
 * Fix 1). Pure: no database, no camera.
 *
 * Every literal below was computed with an independent check-digit and UPC-E
 * implementation (recorded in docs/plans/barcode-integrity/00-status.md), not
 * with the module under test — a test that derives its expectations from the
 * code it checks can only agree with it.
 */
import { describe, test, expect } from "bun:test";
import { normalizeBarcode } from "@/lib/barcode";

const STANDARD = "00082000000013";

describe("normalizeBarcode — the standard 14-digit form", () => {
  test("UPC-A becomes the 14-digit form, and its format is kept", () => {
    expect(normalizeBarcode("082000000013", "upc_a")).toEqual({ barcode: STANDARD, format: "upc_a" });
  });

  test("EAN-13 with a leading zero becomes the same 14 digits", () => {
    expect(normalizeBarcode("0082000000013", "ean_13")).toEqual({ barcode: STANDARD, format: "ean_13" });
  });

  test("a 14-digit GTIN is unchanged", () => {
    expect(normalizeBarcode(STANDARD).barcode).toBe(STANDARD);
  });

  test("UPC-E with format upc_e expands, then pads", () => {
    expect(normalizeBarcode("08200103", "upc_e")).toEqual({ barcode: STANDARD, format: "upc_e" });
  });

  test("THE BUG: three readings of one bottle are one barcode", () => {
    const readings = [
      normalizeBarcode("082000000013", "upc_a").barcode,
      normalizeBarcode("0082000000013", "ean_13").barcode,
      normalizeBarcode("08200103", "upc_e").barcode,
    ];
    expect(new Set(readings).size).toBe(1);
  });

  test("UPC-E expansion — each of the four rules", () => {
    // Final digit 0–2: manufacturer d1 d2 d6 00, product 00 d3 d4 d5
    expect(normalizeBarcode("08200103", "upc_e").barcode).toBe("00082000000013");
    // Final digit 3: manufacturer d1 d2 d3 00, product 000 d4 d5
    expect(normalizeBarcode("01234531", "upc_e").barcode).toBe("00012300000451");
    // Final digit 4: manufacturer d1 d2 d3 d4 0, product 0000 d5
    expect(normalizeBarcode("01234543", "upc_e").barcode).toBe("00012340000053");
    // Final digit 5–9: manufacturer d1..d5, product 0000 d6
    expect(normalizeBarcode("01234572", "upc_e").barcode).toBe("00012345000072");
  });

  test("an 8-digit code with an EAN-8 format is padded", () => {
    expect(normalizeBarcode("96385074", "ean_8")).toEqual({ barcode: "00000096385074", format: "ean_8" });
  });

  test("EAN-13 not starting with zero is padded by one", () => {
    expect(normalizeBarcode("5012345678900", "ean_13").barcode).toBe("05012345678900");
  });

  test("a 14-digit code with a non-zero indicator digit is unchanged", () => {
    expect(normalizeBarcode("10082000000010").barcode).toBe("10082000000010");
  });
});

describe("normalizeBarcode — never merges what it cannot prove", () => {
  test("an 8-digit code with no format is left as read — never guessed", () => {
    for (const format of [undefined, null, "unknown", ""]) {
      expect(normalizeBarcode("08200103", format).barcode).toBe("08200103");
    }
  });

  test("an 8-digit code claimed as UPC-E with a wrong check digit is left as read", () => {
    expect(normalizeBarcode("08200104", "upc_e").barcode).toBe("08200104");
  });

  test("an 8-digit code claimed as EAN-8 with a wrong check digit is left as read", () => {
    expect(normalizeBarcode("96385075", "ean_8").barcode).toBe("96385075");
  });

  test("NEAR MISS: one wrong digit is never merged with the real code", () => {
    const nearMiss = normalizeBarcode("082000000014", "upc_a").barcode;
    expect(nearMiss).toBe("082000000014");
    expect(nearMiss).not.toBe(STANDARD);
  });

  test("lengths that are not GS1 retail lengths are left as read", () => {
    for (const code of ["123456", "1234567890", "12345678901"]) {
      expect(normalizeBarcode(code).barcode).toBe(code);
    }
  });

  test("Code 128 is left as read, case preserved, only trimmed", () => {
    expect(normalizeBarcode(" X004YKHTYX ", "code_128")).toEqual({ barcode: "X004YKHTYX", format: "code_128" });
    expect(normalizeBarcode("x004ykhtyx", "code_128").barcode).toBe("x004ykhtyx");
  });
});

describe("normalizeBarcode — format and robustness", () => {
  test("an unknown format name is recorded as null, never as client text", () => {
    for (const format of ["qr_code", "<script>", "", "UPC_A"]) {
      expect(normalizeBarcode("082000000013", format).format).toBeNull();
    }
  });

  test("a missing format still normalizes a 12/13/14-digit code — old offline-queue writes carry none", () => {
    expect(normalizeBarcode("0082000000013")).toEqual({ barcode: STANDARD, format: null });
  });

  test("idempotent: normalizing the output again changes nothing", () => {
    const cases: [string, string | null][] = [
      ["082000000013", "upc_a"], ["0082000000013", "ean_13"], ["08200103", "upc_e"],
      ["96385074", "ean_8"], ["08200103", null], ["082000000014", "upc_a"], [" X004YKHTYX ", "code_128"],
    ];
    for (const [raw, format] of cases) {
      const once = normalizeBarcode(raw, format);
      expect(normalizeBarcode(once.barcode, once.format)).toEqual(once);
    }
  });

  test("total: never throws on junk", () => {
    for (const junk of ["", "   ", "x".repeat(64), "0".repeat(64), "１２３"]) {
      expect(() => normalizeBarcode(junk, "upc_a")).not.toThrow();
    }
  });
});
