/**
 * Pure unit tests for `formatCalendarDate` — no database, no fixtures.
 *
 * The function exists because `invoice.invoice_date` / `invoice.retention_until`
 * are MariaDB `DATE` columns (no time-of-day), and the obvious
 * `new Date(str).toLocaleDateString()` path parses the string as UTC
 * midnight, then renders in the browser's local zone — every US timezone is
 * a negative UTC offset, so a document dated 2026-08-14 would print Aug 13.
 * `lib/domain/invoices.ts`'s `computeRetentionUntil` documents the identical
 * failure mode on the write side; this pins down the read side.
 */
import { describe, expect, it } from "bun:test";
import { formatCalendarDate } from "@/lib/utils";

describe("formatCalendarDate", () => {
  it("prints the same calendar day regardless of the host timezone", () => {
    // The load-bearing case: a date whose UTC-midnight instant falls on the
    // PREVIOUS calendar day in every negative-offset (US) timezone. If this
    // routed through `new Date(str)` + a local-zone `toLocaleDateString`,
    // it would print "Aug 13" outside UTC.
    expect(formatCalendarDate("2026-08-14")).toBe("Aug 14, 2026");
  });

  it("handles a year boundary without drifting a day either direction", () => {
    expect(formatCalendarDate("2026-01-01")).toBe("Jan 1, 2026");
    expect(formatCalendarDate("2025-12-31")).toBe("Dec 31, 2025");
  });

  it("handles a leap day", () => {
    expect(formatCalendarDate("2028-02-29")).toBe("Feb 29, 2028");
  });

  it("passes through a value it cannot parse as YYYY-MM-DD, rather than inventing a date", () => {
    expect(formatCalendarDate("not-a-date")).toBe("not-a-date");
  });
});
