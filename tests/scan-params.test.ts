/**
 * The scan page's deep-link params (lib/scan-params.ts). The URL is client
 * input: a forged or stale value must fall back to "no leg chosen" (the
 * location picker) and never start a leg on a location the page didn't load.
 */
import { describe, test, expect } from "bun:test";
import { parseScanParams } from "@/lib/scan-params";

const VALID = [1, 2, 3, 40];
const NONE = { locationId: null, productId: null };

describe("parseScanParams", () => {
  test("a valid location id in the active list is accepted", () => {
    expect(parseScanParams({ locationId: "3" }, VALID)).toEqual({ locationId: 3, productId: null });
    expect(parseScanParams({ locationId: "40" }, VALID).locationId).toBe(40);
  });

  test("missing params -> nothing chosen", () => {
    expect(parseScanParams({}, VALID)).toEqual(NONE);
    expect(parseScanParams({ locationId: undefined }, VALID)).toEqual(NONE);
  });

  test("empty value -> nothing chosen", () => {
    expect(parseScanParams({ locationId: "" }, VALID)).toEqual(NONE);
  });

  test("a repeated param uses the FIRST value", () => {
    expect(parseScanParams({ locationId: ["2", "3"] }, VALID).locationId).toBe(2);
    // First is bad, second good: still rejected, not rescued.
    expect(parseScanParams({ locationId: ["abc", "3"] }, VALID)).toEqual(NONE);
    expect(parseScanParams({ locationId: [] }, VALID)).toEqual(NONE);
  });

  test("non-numeric -> rejected", () => {
    expect(parseScanParams({ locationId: "abc" }, VALID)).toEqual(NONE);
    expect(parseScanParams({ locationId: "3abc" }, VALID)).toEqual(NONE);
    expect(parseScanParams({ locationId: "NaN" }, VALID)).toEqual(NONE);
  });

  test("negative, zero -> rejected", () => {
    expect(parseScanParams({ locationId: "-1" }, VALID)).toEqual(NONE);
    expect(parseScanParams({ locationId: "0" }, VALID)).toEqual(NONE);
    expect(parseScanParams({ locationId: "-0" }, VALID)).toEqual(NONE);
  });

  test("floats -> rejected", () => {
    expect(parseScanParams({ locationId: "2.5" }, VALID)).toEqual(NONE);
    // Number("2.0") === 2 — a forgiving parser would accept it.
    expect(parseScanParams({ locationId: "2.0" }, VALID)).toEqual(NONE);
  });

  test("exponent notation -> rejected (Number('1e3') would be 1000)", () => {
    expect(parseScanParams({ locationId: "1e3" }, [1000])).toEqual(NONE);
  });

  test("signs, hex and leading zeros -> rejected", () => {
    expect(parseScanParams({ locationId: "+3" }, VALID)).toEqual(NONE);
    expect(parseScanParams({ locationId: "0x3" }, VALID)).toEqual(NONE);
    expect(parseScanParams({ locationId: "03" }, VALID)).toEqual(NONE);
  });

  test("whitespace -> rejected, not trimmed", () => {
    expect(parseScanParams({ locationId: " 3" }, VALID)).toEqual(NONE);
    expect(parseScanParams({ locationId: "3 " }, VALID)).toEqual(NONE);
    expect(parseScanParams({ locationId: " " }, VALID)).toEqual(NONE);
  });

  test("an unsafe / huge integer -> rejected even if it 'matches' after rounding", () => {
    const huge = "9007199254740993"; // 2^53 + 1: Number() rounds it to 2^53
    expect(parseScanParams({ locationId: huge }, [9007199254740992])).toEqual(NONE);
    expect(parseScanParams({ locationId: "99999999999999999999999" }, VALID)).toEqual(NONE);
  });

  test("a well-formed id that is NOT an active location -> rejected", () => {
    // Retired (invariant 6) or another tenant's (invariant 9): never trusted.
    expect(parseScanParams({ locationId: "4" }, VALID)).toEqual(NONE);
    expect(parseScanParams({ locationId: "3" }, [])).toEqual(NONE);
  });

  describe("productId", () => {
    test("accepted alongside a valid location", () => {
      expect(parseScanParams({ locationId: "2", productId: "17" }, VALID)).toEqual({
        locationId: 2,
        productId: 17,
      });
    });

    test("first value of an array", () => {
      expect(parseScanParams({ locationId: "2", productId: ["17", "18"] }, VALID).productId).toBe(
        17,
      );
    });

    test("held to the same strictness as locationId", () => {
      for (const bad of ["", "0", "-4", "4.2", "1e3", " 7", "abc", "9007199254740993"]) {
        expect(parseScanParams({ locationId: "2", productId: bad }, VALID)).toEqual({
          locationId: 2,
          productId: null,
        });
      }
    });

    test("is dropped when there is no valid location to count it in", () => {
      expect(parseScanParams({ productId: "17" }, VALID)).toEqual(NONE);
      expect(parseScanParams({ locationId: "99", productId: "17" }, VALID)).toEqual(NONE);
    });
  });

  test("unrelated params are ignored", () => {
    expect(parseScanParams({ locationId: "1", utm_source: "x" }, VALID)).toEqual({
      locationId: 1,
      productId: null,
    });
  });
});
