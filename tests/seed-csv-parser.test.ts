/**
 * CSV parser tests — Finding 1 / docs/mvp-gaps.md.
 *
 * parseCsv is exported from db/csv.ts and handles comment lines (#) and
 * blank lines. Without this skip, a comment line breaks the entire seed
 * pipeline (vendors.csv comment caused seedVendors to throw and abort the
 * entire main() sequence, leaving locations seeded and nothing else).
 * This failure was invisible to tests (which don't run the seed) and was
 * discovered only by executing it.
 */
import { describe, test, expect } from "bun:test";
import { parseCsv } from "@/db/csv";

describe("parseCsv comment and blank-line skipping", () => {
  test("skips comment lines — those starting with '#' after trimming", () => {
    const csv = `name,value
# This is a comment
Coors,5.00
# Another comment
Bud,4.50`;

    const result = parseCsv(csv);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Coors");
    expect(result[1].name).toBe("Bud");
  });

  test("skips blank lines", () => {
    const csv = `name,value
Coors,5.00

Bud,4.50

`;

    const result = parseCsv(csv);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Coors");
    expect(result[1].name).toBe("Bud");
  });

  test("skips both comment and blank lines in combination", () => {
    const csv = `name,contact,order_method,lead_time_days
# Edit this file to list your supplier relationships here, or add vendors through /office/vendors.
# Columns: supplier name, contact info (phone/email/name), ordering method (website/phone/rep/etc), lead time in days.

Breakthru Beverage,orders@breakthru.example,website,3
# Another vendor below

Southern Wine & Spirits,swine@example.com,phone,2`;

    const result = parseCsv(csv);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Breakthru Beverage");
    expect(result[1].name).toBe("Southern Wine & Spirits");
  });

  test("preserves '#' inside field values — only skips lines starting with '#'", () => {
    const csv = `name,notes
ACME Inc,Direct: #555-1234
Zulu's #1 Distributor,No special notes`;

    const result = parseCsv(csv);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("ACME Inc");
    expect(result[0].notes).toBe("Direct: #555-1234");
    expect(result[1].name).toBe("Zulu's #1 Distributor");
  });

  test("returns empty array if only comments/blanks remain after header is skipped", () => {
    const csv = `name,value
# Comment 1
# Comment 2

`;

    const result = parseCsv(csv);
    expect(result).toHaveLength(0);
  });

  test("throws if the entire file is comments and blanks (no header)", () => {
    const csv = `# Comment 1
# Comment 2

`;

    expect(() => parseCsv(csv)).toThrow("CSV file has no rows");
  });

  test("still throws loudly on real row with wrong column count", () => {
    const csv = `name,contact,order_method,lead_time_days
Breakthru,orders@example.com
# This comment is skipped
Southern Wine,swine@example.com,phone,2`;

    expect(() => parseCsv(csv)).toThrow(/CSV row \d+ has \d+ columns, expected 4/);
  });
});
