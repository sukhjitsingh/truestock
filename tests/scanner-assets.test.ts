/**
 * The barcode scanner's wasm must load from this origin.
 *
 * `barcode-detector`'s polyfill fetches its WebAssembly module from a jsDelivr
 * URL by default; the CSP's `connect-src 'self'` blocks that, and the failure
 * is silent — the camera opens and nothing ever decodes (found in QA with a
 * fake camera feed after `delete window.BarcodeDetector`). These tests pin the
 * pieces that keep it working, because none of them fail anything on their own
 * if one is lost: the build still passes, the page still renders, search-only
 * counting still works.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCsp } from "@/lib/csp";
import {
  ZXING_WASM_PUBLIC_PATH,
  ZXING_WASM_URL,
  locateScannerFile,
} from "@/lib/scanner-assets";
import { copyZxingWasm } from "../scripts/lib/copy-zxing-wasm.mjs";

const repoRoot = path.resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

describe("locateScannerFile", () => {
  test("the wasm comes from this origin", () => {
    expect(locateScannerFile("zxing_reader.wasm", "https://cdn.example/dist/")).toBe(
      ZXING_WASM_URL,
    );
    expect(ZXING_WASM_URL.startsWith("/")).toBe(true);
  });

  test("anything else keeps the library's default resolution", () => {
    expect(locateScannerFile("zxing_reader.js", "/base/")).toBe("/base/zxing_reader.js");
  });

  test("the served URL and the copy target are the same file", () => {
    expect(ZXING_WASM_PUBLIC_PATH).toBe(`public${ZXING_WASM_URL}`);
  });
});

describe("the CSP does not need a third-party origin for the scanner", () => {
  for (const [label, pathname] of [
    ["a count page", "/count/1/scan"],
    ["an invoice file", "/api/invoices/1/file"],
  ] as const) {
    test(`${label}: connect-src and script-src name no external host`, () => {
      const csp = buildCsp("nonce123", pathname);
      const directives = Object.fromEntries(
        csp.split(";").map((d) => {
          const [name, ...values] = d.trim().split(/\s+/);
          return [name, values];
        }),
      );
      for (const name of ["connect-src", "script-src"]) {
        const hosts = (directives[name] as string[]).filter((v) => /^(https?:)?\/\//.test(v));
        expect(hosts).toEqual([]);
      }
    });
  }
});

describe("scanner component", () => {
  const src = read("components/count/barcode-scanner.tsx");

  test("overrides locateFile before the polyfill detector is constructed", () => {
    const override = src.indexOf("setZXingModuleOverrides({ locateFile: locateScannerFile })");
    const construct = src.indexOf("new mod.BarcodeDetector(");
    expect(override).toBeGreaterThan(-1);
    expect(construct).toBeGreaterThan(-1);
    expect(override).toBeLessThan(construct);
  });

  test("never names a CDN itself", () => {
    expect(src).not.toMatch(/jsdelivr|unpkg|cdnjs/i);
  });
});

describe("the wasm is copied into public/ on every dev start and build", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  test("predev and prebuild run the copy script", () => {
    expect(pkg.scripts.predev).toContain("scripts/copy-zxing-wasm.mjs");
    expect(pkg.scripts.prebuild).toContain("scripts/copy-zxing-wasm.mjs");
  });

  test("the script's destination literal matches ZXING_WASM_PUBLIC_PATH", () => {
    // The .mjs cannot import the .ts constant, so it repeats it; this fails
    // if the two drift and the build quietly copies to a path nothing serves.
    expect(read("scripts/copy-zxing-wasm.mjs")).toContain(`"${ZXING_WASM_PUBLIC_PATH}"`);
  });

  test("the generated file is gitignored, not committed", () => {
    expect(read(".gitignore")).toMatch(/^\/public\/vendor\/$/m);
  });

  test("copies a real wasm module out of node_modules", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zxing-wasm-"));
    try {
      const dest = path.join(dir, "vendor", "zxing_reader.wasm");
      const { bytes, to } = copyZxingWasm({ repoRoot, publicPath: dest }) as {
        bytes: number;
        to: string;
      };
      expect(to).toBe(dest);
      expect(bytes).toBeGreaterThan(100_000);
      // "\0asm" — a WebAssembly binary, not an HTML error page or an empty file.
      expect([...readFileSync(dest).subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing package fails loudly instead of shipping a dead scanner", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zxing-wasm-"));
    try {
      expect(() =>
        copyZxingWasm({ repoRoot: dir, publicPath: path.join(dir, "out.wasm") }),
      ).toThrow(/copy-zxing-wasm/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
