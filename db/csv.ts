/**
 * RFC4180 CSV parser with comment and blank-line support.
 *
 * Pure functions for parsing CSV text. No database access, no side effects.
 * Exported so tests can import parseCsv without triggering a live seed against
 * the active DATABASE_URL (see db/seed.ts's module-scope main() guard).
 *
 * Three small, well-formed files don't justify a dependency (PapaParse is
 * reserved for the Toast PMIX import, per docs/spec.md §11) — but this still
 * parses RFC4180 quoting (commas and "" escaped quotes inside quoted fields)
 * since locations.csv uses it, and it fails loudly — throws — on any row whose
 * column count doesn't match the header, rather than silently importing a
 * shifted row.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Parse RFC4180 CSV with comment and blank-line support. Comment lines (those
 * whose first non-whitespace character is '#') and blank lines are skipped.
 * This check happens only at the start of the raw line, never mid-parse, so a
 * legitimate field value containing '#' is untouched. The column-count throw
 * for real rows is kept loud — that behaviour is deliberate and is the only
 * thing that was broken.
 *
 * Why comment support matters: locations.csv, products.csv, and vendors.csv
 * are maintained by hand, and a CSV earns a comment explaining what goes in
 * it. Without this skip, a comment line breaks the entire seed pipeline,
 * aborting before locations are even written. This failure was invisible to
 * tests (which don't run the seed) and was discovered only by executing it.
 */
export function parseCsv(raw: string): Record<string, string>[] {
  const text = raw.replace(/\r\n/g, "\n");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Filter out blank lines and comment lines. A comment line is one whose
  // first non-whitespace character is '#'. This is checked only at the start
  // of the raw line, so '#' appearing inside a field value is left alone.
  const filtered = rows.filter((r) => {
    if (r.length === 1 && r[0].trim() === "") {
      // Blank line — skip it.
      return false;
    }
    if (r.length > 0) {
      const firstField = r[0].trim();
      if (firstField.startsWith("#")) {
        // Comment line — skip it.
        return false;
      }
    }
    return true;
  });

  if (filtered.length === 0) {
    throw new Error("CSV file has no rows");
  }
  const header = filtered[0];
  return filtered.slice(1).map((cols, idx) => {
    if (cols.length !== header.length) {
      throw new Error(
        `CSV row ${idx + 2} has ${cols.length} columns, expected ${header.length} ` +
          `(header: ${JSON.stringify(header)}, row: ${JSON.stringify(cols)})`,
      );
    }
    const record: Record<string, string> = {};
    header.forEach((key, i) => {
      record[key] = cols[i];
    });
    return record;
  });
}

/**
 * Read a CSV file from disk and parse it. Pure function — returns parsed rows,
 * no database side effects.
 */
export function readCsv(relativePath: string): Record<string, string>[] {
  const fullPath = path.join(process.cwd(), relativePath);
  const raw = readFileSync(fullPath, "utf-8");
  return parseCsv(raw);
}
