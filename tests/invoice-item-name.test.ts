import { describe, expect, test } from "bun:test";
import { fillFromItemName, readItemName } from "@/lib/invoice-item-name";
import { parseLineSizeMl } from "@/lib/invoice-line-size";
import { effectivePackSize } from "@/lib/domain/cost-derivation";

// Every name below is fabricated.
const FULL = "SAMPLE VODKA 80 111111 • 1.0L • 12 Case • SCREW CAP";

describe("readItemName", () => {
  test("reads code, case pack and size from the full shape", () => {
    expect(readItemName(FULL)).toEqual({ vendorItemCode: "111111", packSize: 12, packDescription: "12/1.0L" });
  });

  test("the closure segment is optional", () => {
    expect(readItemName("SAMPLE GIN 80 222222 • 750ML • 6 Case")).toEqual({
      vendorItemCode: "222222",
      packSize: 6,
      packDescription: "6/750ML",
    });
  });

  test("proof 80 is never a code: only the all-digit 5+ trailing token is", () => {
    expect(readItemName("SAMPLE VODKA 80 • 1.0L • 12 Case").vendorItemCode).toBeNull();
    expect(readItemName("SAMPLE VODKA 80 111111 • 1.0L • 12 Case").vendorItemCode).toBe("111111");
  });

  test("a 4-digit trailing number is not a code, a 5-digit one is", () => {
    expect(readItemName("SAMPLE RYE 1234 • 1.0L • 12 Case").vendorItemCode).toBeNull();
    expect(readItemName("SAMPLE RYE 12345 • 1.0L • 12 Case").vendorItemCode).toBe("12345");
  });

  test("a code must be all digits and the last token of the first segment", () => {
    expect(readItemName("SAMPLE RYE 11111A • 1.0L").vendorItemCode).toBeNull();
    expect(readItemName("SAMPLE RYE 111111 EXTRA • 1.0L").vendorItemCode).toBeNull();
    // A code in a later segment is not read.
    expect(readItemName("SAMPLE RYE • 111111 • 1.0L").vendorItemCode).toBeNull();
  });

  test("a bare number with no name before it is not a code", () => {
    expect(readItemName("111111 • 1.0L • 12 Case").vendorItemCode).toBeNull();
  });

  test("no bullet means the cell is left alone, even if it reads like the shape", () => {
    expect(readItemName("SAMPLE VODKA 80 111111 1.0L 12 Case")).toEqual({
      vendorItemCode: null,
      packSize: null,
      packDescription: null,
    });
    expect(readItemName("SAMPLE VODKA 80 111111")).toEqual({ vendorItemCode: null, packSize: null, packDescription: null });
    expect(readItemName(null)).toEqual({ vendorItemCode: null, packSize: null, packDescription: null });
    expect(readItemName("")).toEqual({ vendorItemCode: null, packSize: null, packDescription: null });
  });

  test("<n> Case must be the whole segment", () => {
    for (const bad of ["12 Cases", "Case of 12", "12 Case Pack", "x12 Case", "12 Cased", "0 Case", "10000 Case"]) {
      expect(readItemName(`SAMPLE VODKA 111111 • 1.0L • ${bad}`).packSize).toBeNull();
    }
    expect(readItemName("SAMPLE VODKA 111111 • 1.0L • 12 case").packSize).toBe(12);
    expect(readItemName("SAMPLE VODKA 111111 • 1.0L • 12Case").packSize).toBe(12);
  });

  test("volume must be a whole segment: 1.75L, 750ML, 750 ml, 1.0L", () => {
    const vol = (v: string) => readItemName(`SAMPLE VODKA 111111 • ${v} • 12 Case`).packDescription;
    expect(vol("1.75L")).toBe("12/1.75L");
    expect(vol("750ML")).toBe("12/750ML");
    expect(vol("750 ml")).toBe("12/750ML");
    expect(vol("1.0L")).toBe("12/1.0L");
    expect(vol("375ml")).toBe("12/375ML");
    for (const bad of ["750ML BOTTLE", "SIZE 750ML", "750", "12OZ", "0L", "1.0LB"]) {
      expect(vol(bad)).toBeNull();
    }
  });

  test("a size with no case pack does NOT fabricate an n/size pack description", () => {
    expect(readItemName("SAMPLE VODKA 111111 • 1.0L • SCREW CAP")).toEqual({
      vendorItemCode: "111111",
      packSize: null,
      packDescription: null,
    });
  });

  test("a case pack with no size gives the pack size and no pack description", () => {
    expect(readItemName("SAMPLE VODKA 111111 • 12 Case")).toEqual({
      vendorItemCode: "111111",
      packSize: 12,
      packDescription: null,
    });
  });

  test("two conflicting packs or two sizes are ambiguous and read as null", () => {
    expect(readItemName("SAMPLE VODKA 111111 • 1.0L • 12 Case • 6 Case").packSize).toBeNull();
    expect(readItemName("SAMPLE VODKA 111111 • 1.0L • 750ML • 12 Case").packDescription).toBeNull();
  });

  test("the first segment is never read as a pack or size", () => {
    expect(readItemName("12 Case • 1.0L")).toEqual({ vendorItemCode: null, packSize: null, packDescription: null });
  });
});

describe("fillFromItemName: a real column always wins", () => {
  const base = { description: FULL, vendorItemCode: null, packDescription: null, packSize: null };

  test("fills every null field", () => {
    expect(fillFromItemName(base)).toEqual({ vendorItemCode: "111111", packDescription: "12/1.0L", packSize: 12 });
  });

  test("a code already present is not overwritten", () => {
    expect(fillFromItemName({ ...base, vendorItemCode: "REAL-1" }).vendorItemCode).toBe("REAL-1");
  });

  test("a pack description and size already present are not overwritten", () => {
    const out = fillFromItemName({ ...base, packDescription: "6/750ML", packSize: 6 });
    expect(out.packDescription).toBe("6/750ML");
    expect(out.packSize).toBe(6);
  });

  test("a present pack description does not block a still-null pack size from the name", () => {
    const out = fillFromItemName({ ...base, packDescription: "CS" });
    expect(out.packDescription).toBe("CS");
    expect(out.packSize).toBe(12);
  });

  test("a cell without a bullet changes nothing", () => {
    const line = { description: "SAMPLE VODKA 111111", vendorItemCode: null, packDescription: null, packSize: null };
    expect(fillFromItemName(line)).toEqual({ vendorItemCode: null, packDescription: null, packSize: null });
  });
});

describe("downstream of the reader", () => {
  test("12/1.0L and 12/750ML parse as sizes through parseLineSizeMl", () => {
    const l = (p: string) => parseLineSizeMl({ packDescription: p, description: null });
    expect(l("12/1.0L")).toBe(1000);
    expect(l("12/750ML")).toBe(750);
    expect(l("6/1.75L")).toBe(1750);
  });

  test("the verbatim description still yields the size when no pack description was read", () => {
    const r = readItemName("SAMPLE VODKA 111111 • 1.0L • SCREW CAP");
    expect(parseLineSizeMl({ packDescription: r.packDescription, description: "SAMPLE VODKA 111111 • 1.0L • SCREW CAP" })).toBe(
      1000,
    );
  });

  test("each and keg lines keep an effective pack of 1 whatever the name said", () => {
    const { packSize } = readItemName(FULL);
    expect(effectivePackSize({ uom: "each", packSize })).toBe(1);
    expect(effectivePackSize({ uom: "keg", packSize })).toBe(1);
    expect(effectivePackSize({ uom: "case", packSize })).toBe(12);
  });
});
