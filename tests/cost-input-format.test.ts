/**
 * Pure unit tests for `formatCostForInput` — no database, no fixtures.
 *
 * The function exists because `unit_cost` is `DECIMAL(10,4)` and mysql2 hands
 * it back as a string with all four places (`"144.0000"`), which is what the
 * editable cost cells in the catalog table and the product edit form were
 * rendering. Read-only money was never wrong — `formatMoney` has always been
 * exactly 2dp — so the fix belongs on the *input* path only.
 *
 * The rule these tests pin down is the one that is easy to "simplify" into a
 * bug: **it trims, it never rounds.** A field the user is about to submit must
 * show everything that is stored in it. Rounding `12.3456` to `12.35` for
 * display would make the next save silently write away real precision, and the
 * user would have no way to know — the number on screen looked like the number
 * in the database.
 */
import { describe, expect, it } from "bun:test";
import { formatCostForInput } from "@/lib/utils";

describe("formatCostForInput", () => {
  it("trims a DECIMAL(10,4) round-trip down to cents", () => {
    expect(formatCostForInput("144.0000")).toBe("144.00");
    expect(formatCostForInput("82.0000")).toBe("82.00");
    expect(formatCostForInput("0.0000")).toBe("0.00");
  });

  it("pads up to two places rather than leaving a bare tenth", () => {
    expect(formatCostForInput("21.5")).toBe("21.50");
    expect(formatCostForInput("21.5000")).toBe("21.50");
  });

  it("keeps sub-cent precision instead of rounding it away", () => {
    // The load-bearing case. A per-unit cost derived from a case price is
    // genuinely fractional; showing 12.35 here would lose 0.0056 on the next
    // save with nothing on screen looking wrong.
    expect(formatCostForInput("12.3456")).toBe("12.3456");
    expect(formatCostForInput("8.1200")).toBe("8.12");
    expect(formatCostForInput("8.1230")).toBe("8.123");
  });

  it("leaves an integer, an empty value and a null alone", () => {
    // No decimal point means nothing to trim — and an empty field must stay
    // empty rather than becoming "0.00", which would read as a real cost of
    // zero on a product whose cost is simply not on file yet.
    expect(formatCostForInput("144")).toBe("144");
    expect(formatCostForInput("")).toBe("");
    expect(formatCostForInput("   ")).toBe("");
    expect(formatCostForInput(null)).toBe("");
    expect(formatCostForInput(undefined)).toBe("");
  });

  it("passes anything it does not recognise straight through", () => {
    // Never invent a value. If the driver ever hands back something this
    // pattern does not match, showing it verbatim is the honest failure.
    expect(formatCostForInput("1.2e3")).toBe("1.2e3");
    expect(formatCostForInput("abc")).toBe("abc");
  });

  it("handles a negative the same way", () => {
    expect(formatCostForInput("-5.0000")).toBe("-5.00");
  });
});
