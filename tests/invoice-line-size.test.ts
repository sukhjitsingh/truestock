import { describe, expect, test } from "bun:test";
import { lineSizeWarning, parseLineSizeMl } from "@/lib/invoice-line-size";

const pack = (packDescription: string | null, description: string | null = null) => ({
  packDescription,
  description,
});
const bottle = (sizeMl: number) => ({ unitType: "bottle", sizeMl });

describe("parseLineSizeMl", () => {
  test("reads pack descriptions", () => {
    expect(parseLineSizeMl(pack("12/750ML"))).toBe(750);
    expect(parseLineSizeMl(pack("6/1.75L"))).toBe(1750);
    expect(parseLineSizeMl(pack("12 x 1 L"))).toBe(1000);
    expect(parseLineSizeMl(pack("24/355 ml"))).toBe(355);
  });
  test("litres and ml are equivalent", () => {
    expect(parseLineSizeMl(pack("1L"))).toBe(parseLineSizeMl(pack("1000ML")));
    expect(parseLineSizeMl(pack("0.75L"))).toBe(750);
    expect(parseLineSizeMl(pack("1.5L"))).toBe(1500);
  });
  test("falls back to the description when the pack text has no volume", () => {
    expect(parseLineSizeMl(pack("CS", "Jameson Irish Whiskey 1.75L"))).toBe(1750);
    expect(parseLineSizeMl(pack(null, "Tito's Vodka 750ML"))).toBe(750);
  });
  test("never guesses", () => {
    expect(parseLineSizeMl(pack(null, null))).toBeNull();
    expect(parseLineSizeMl(pack("12/12OZ"))).toBeNull();
    expect(parseLineSizeMl(pack("12 LB"))).toBeNull();
    expect(parseLineSizeMl(pack("12/750"))).toBeNull();
    expect(parseLineSizeMl(pack("CS", "Mixed case 750ML and 1L"))).toBeNull();
  });
});

describe("lineSizeWarning", () => {
  test("warns when a 1.75 L line is matched to a 750 ml product", () => {
    expect(lineSizeWarning(pack("6/1.75L"), bottle(750))).toBe(
      "Size check: this line reads 1.75 L, but the matched product is 750 ml.",
    );
  });
  test("warns the other way round", () => {
    expect(lineSizeWarning(pack("12/750ML"), bottle(1750))).toContain("750 ml");
  });
  test("is quiet when the sizes agree, in any spelling", () => {
    expect(lineSizeWarning(pack("12/750ML"), bottle(750))).toBeNull();
    expect(lineSizeWarning(pack("12/1L"), bottle(1000))).toBeNull();
    expect(lineSizeWarning(pack("12/1000ML"), bottle(1000))).toBeNull();
    expect(lineSizeWarning(pack("6/1.75L"), bottle(1750))).toBeNull();
  });
  test("tolerates rounding but not a real size difference", () => {
    expect(lineSizeWarning(pack("1L"), bottle(1010))).toBeNull();
    expect(lineSizeWarning(pack("12/700ML"), bottle(750))).not.toBeNull();
  });
  test("is quiet when the line size cannot be read or nothing is matched", () => {
    expect(lineSizeWarning(pack("CS"), bottle(750))).toBeNull();
    expect(lineSizeWarning(pack(null), bottle(750))).toBeNull();
    expect(lineSizeWarning(pack("6/1.75L"), null)).toBeNull();
    expect(lineSizeWarning(pack("6/1.75L"), undefined)).toBeNull();
  });
  test("prints the product size through formatProductSize, kegs included", () => {
    expect(lineSizeWarning(pack("1/750ML"), { unitType: "keg", sizeMl: 19533 })).toBe(
      "Size check: this line reads 750 ml, but the matched product is Sixtel keg.",
    );
  });
});
