import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { initialCurrencyInput } from "@/lib/invoice-review-currency";

describe("initialCurrencyInput", () => {
  test("starts empty when extraction found no currency, never with a guess", () => {
    expect(initialCurrencyInput(null)).toBe("");
    expect(initialCurrencyInput(undefined)).toBe("");
    expect(initialCurrencyInput("  ")).toBe("");
  });
  test("keeps what extraction found", () => {
    expect(initialCurrencyInput("CAD")).toBe("CAD");
  });
});

describe("the review form's currency input", () => {
  test("carries no placeholder, which would look filled in without being submitted", () => {
    const source = readFileSync("components/office/invoice-review-form.tsx", "utf8");
    const input = source.match(/<Input\s+id="header-currency"[\s\S]*?\/>/);
    expect(input).not.toBeNull();
    expect(input?.[0]).not.toContain("placeholder");
  });
});
