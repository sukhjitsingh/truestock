import { describe, expect, test } from "bun:test";
import { headerCorrectionSchema } from "@/lib/validation/invoices";
import { initialCurrencyInput } from "@/lib/invoice-review-currency";

describe("initialCurrencyInput", () => {
  test("starts with a real USD value when extraction found no currency", () => {
    expect(initialCurrencyInput(null)).toBe("USD");
    expect(initialCurrencyInput(undefined)).toBe("USD");
    expect(initialCurrencyInput("  ")).toBe("USD");
  });
  test("keeps what extraction found", () => {
    expect(initialCurrencyInput("CAD")).toBe("CAD");
  });
  test("the starting value is one the header schema accepts, so it is submitted", () => {
    const parsed = headerCorrectionSchema.safeParse({ currency: initialCurrencyInput(null) });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.currency).toBe("USD");
  });
});
