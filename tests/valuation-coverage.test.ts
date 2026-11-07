/**
 * The caveat that goes beside every dollar total (lib/valuation-coverage.ts).
 * The case that matters: a count with lines but no costs must never read as a
 * plain $0.00 — that figure means "unknown", not "worth nothing" (DB-1).
 */
import { describe, test, expect } from "bun:test";
import { describeValuationCoverage } from "@/lib/valuation-coverage";

describe("describeValuationCoverage", () => {
  test("no lines at all: $0.00 is simply true, so no caveat", () => {
    const c = describeValuationCoverage({ pricedLineCount: 0, excludedLineCount: 0 });
    expect(c.state).toBe("empty");
    expect(c.label).toBeNull();
    expect(c.incomplete).toBe(false);
    expect(c.suppressFigure).toBe(false);
  });

  test("lines but none costed: the figure is suppressed, not printed as $0.00", () => {
    const c = describeValuationCoverage({ pricedLineCount: 0, excludedLineCount: 7 });
    expect(c.state).toBe("none");
    expect(c.label).toBe("No costs on file");
    expect(c.suppressFigure).toBe(true);
    expect(c.incomplete).toBe(true);
    expect(c.totalLineCount).toBe(7);
  });

  test("partly costed: the figure stays, with how much of the count backs it", () => {
    const c = describeValuationCoverage({ pricedLineCount: 5, excludedLineCount: 2 });
    expect(c.state).toBe("partial");
    expect(c.label).toBe("5 of 7 lines costed");
    expect(c.suppressFigure).toBe(false);
    expect(c.incomplete).toBe(true);
  });

  test("a single uncosted line among many still flags the total", () => {
    const c = describeValuationCoverage({ pricedLineCount: 96, excludedLineCount: 1 });
    expect(c.state).toBe("partial");
    expect(c.label).toBe("96 of 97 lines costed");
    expect(c.incomplete).toBe(true);
  });

  test("every line costed: no caveat", () => {
    const c = describeValuationCoverage({ pricedLineCount: 12, excludedLineCount: 0 });
    expect(c.state).toBe("full");
    expect(c.label).toBeNull();
    expect(c.incomplete).toBe(false);
    expect(c.suppressFigure).toBe(false);
  });

  test("negative counts are clamped rather than producing a nonsense label", () => {
    const c = describeValuationCoverage({ pricedLineCount: -1, excludedLineCount: 3 });
    expect(c.pricedLineCount).toBe(0);
    expect(c.state).toBe("none");
  });
});
