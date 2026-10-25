/**
 * The invoice review page embeds `/api/invoices/:id/file` in an <iframe>.
 * Out of the box every response carries `X-Frame-Options: DENY` and
 * `frame-ancestors 'none'` (and `object-src 'none'`, which Chrome's PDF viewer
 * also trips over), so the preview comes up blank even though the route
 * returns 200 — exactly the failure class AGENTS.md warns about.
 *
 * These tests pin the header VALUES. They cannot prove a browser renders the
 * preview: that needs a real Chrome pass on /office/invoices/:id (see
 * docs/plans/ui-ux-redesign/00-status.md). What they do guard is the part that
 * is easy to break silently — the relaxation must stay scoped to that one path.
 */
import { describe, expect, test } from "bun:test";
import { buildCsp, isInvoiceFilePath } from "@/lib/csp";
import nextConfig from "@/next.config";

const NONCE = "test-nonce";
const FILE_PATH = "/api/invoices/42/file";

describe("buildCsp", () => {
  test("every ordinary page keeps frame-ancestors 'none' and object-src 'none'", () => {
    for (const p of ["/", "/office", "/office/invoices/42", "/count", "/api/invoices/42"]) {
      const csp = buildCsp(NONCE, p);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
    }
  });

  test("the invoice file route is framable by its own origin only", () => {
    const csp = buildCsp(NONCE, FILE_PATH);
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
    // Never a wildcard, never another site.
    expect(csp).not.toMatch(/frame-ancestors[^;]*(\*|https?:)/);
  });

  test("relaxing framing leaves the rest of the policy untouched", () => {
    const strip = (csp: string) =>
      csp
        .split("; ")
        .filter((d) => !d.startsWith("frame-ancestors") && !d.startsWith("object-src"))
        .join("; ");
    expect(strip(buildCsp(NONCE, FILE_PATH))).toBe(strip(buildCsp(NONCE, "/office")));
    // Nonce still present, 'unsafe-inline' still absent from script-src.
    const script = buildCsp(NONCE, FILE_PATH)
      .split("; ")
      .find((d) => d.startsWith("script-src"))!;
    expect(script).toContain(`'nonce-${NONCE}'`);
    expect(script).not.toContain("'unsafe-inline'");
  });
});

describe("isInvoiceFilePath", () => {
  test("matches exactly /api/invoices/<numeric id>/file", () => {
    expect(isInvoiceFilePath("/api/invoices/1/file")).toBe(true);
    expect(isInvoiceFilePath("/api/invoices/123456/file")).toBe(true);
  });

  test("rejects look-alikes", () => {
    for (const p of [
      "/api/invoices/42",
      "/api/invoices/42/file/",
      "/api/invoices/42/file/extra",
      "/api/invoices/42/filex",
      "/api/invoices/abc/file",
      "/api/invoices//file",
      "/api/invoices/42/../file",
      "/x/api/invoices/42/file",
      "/api/audit-packets/42",
      "/office/invoices/42/file",
    ]) {
      expect(isInvoiceFilePath(p)).toBe(false);
    }
  });
});

describe("next.config.ts headers()", () => {
  test("the legacy header is DENY globally and SAMEORIGIN only for the file route, declared after it", async () => {
    const entries = await nextConfig.headers!();
    const xfo = (e: (typeof entries)[number]) =>
      e.headers.find((h) => h.key === "X-Frame-Options")?.value;

    const globalIdx = entries.findIndex((e) => e.source === "/(.*)");
    const fileIdx = entries.findIndex((e) => e.source === "/api/invoices/:id(\\d+)/file");
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    expect(fileIdx).toBeGreaterThanOrEqual(0);

    expect(xfo(entries[globalIdx])).toBe("DENY");
    expect(xfo(entries[fileIdx])).toBe("SAMEORIGIN");
    // Next resolves a duplicate key in favour of the LATER entry.
    expect(fileIdx).toBeGreaterThan(globalIdx);

    // Nothing else relaxes framing.
    const relaxed = entries.filter((e) => xfo(e) !== undefined && xfo(e) !== "DENY");
    expect(relaxed.map((e) => e.source)).toEqual(["/api/invoices/:id(\\d+)/file"]);
  });

  test("the CSP stays out of next.config.ts (a static header cannot carry a nonce)", async () => {
    const entries = await nextConfig.headers!();
    for (const e of entries) {
      expect(e.headers.some((h) => h.key.toLowerCase() === "content-security-policy")).toBe(false);
    }
  });
});
