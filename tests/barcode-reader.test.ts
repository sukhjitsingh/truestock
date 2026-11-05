/**
 * Which barcode reader the scanner uses, and whether the app-provided one can
 * actually load. docs/plans/barcode-integrity, slice 1.
 *
 * The second half is the one that matters most: the app reader's engine must
 * be served from this app's own origin, and it must be byte-for-byte the
 * engine the installed `zxing-wasm` expects. A stale or wrong copy would load
 * and then misbehave, so the copy is checked against the fingerprint the
 * package itself publishes, not against a value pinned here.
 */
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZXING_WASM_SHA256 } from "barcode-detector/pure";
import {
  chooseBarcodeReader,
  RETAIL_BARCODE_FORMATS,
  SCAN_BARCODE_FORMATS,
  ZXING_WASM_PATH,
} from "@/lib/barcode-reader";
import { copyZxingWasm } from "../scripts/copy-zxing-wasm.mjs";

describe("chooseBarcodeReader — built-in first, app reader as the fallback", () => {
  test("no built-in reader → the app reader, asking for every scan format", () => {
    expect(chooseBarcodeReader({ available: false, supportedFormats: null })).toEqual({
      kind: "app",
      formats: [...SCAN_BARCODE_FORMATS],
    });
  });

  test("a built-in reader that supports everything → the built-in reader", () => {
    const choice = chooseBarcodeReader({
      available: true,
      supportedFormats: ["qr_code", ...SCAN_BARCODE_FORMATS, "pdf417"],
    });
    expect(choice).toEqual({ kind: "built-in", formats: [...SCAN_BARCODE_FORMATS] });
  });

  test("a built-in reader with only the retail formats is still used, asked only for what it has", () => {
    const choice = chooseBarcodeReader({ available: true, supportedFormats: [...RETAIL_BARCODE_FORMATS] });
    expect(choice).toEqual({ kind: "built-in", formats: [...RETAIL_BARCODE_FORMATS] });
  });

  test("a built-in reader missing ANY retail format counts as not present", () => {
    for (const missing of RETAIL_BARCODE_FORMATS) {
      const supported = SCAN_BARCODE_FORMATS.filter((f) => f !== missing);
      expect(chooseBarcodeReader({ available: true, supportedFormats: supported }).kind).toBe("app");
    }
  });

  test("a built-in reader that cannot say what it supports → the app reader", () => {
    expect(chooseBarcodeReader({ available: true, supportedFormats: null }).kind).toBe("app");
    expect(chooseBarcodeReader({ available: true, supportedFormats: [] }).kind).toBe("app");
  });

  test("a QR-only built-in reader (common on desktop) → the app reader", () => {
    expect(chooseBarcodeReader({ available: true, supportedFormats: ["qr_code", "aztec"] }).kind).toBe("app");
  });
});

describe("the app reader's engine is served by the app, and is the right file", () => {
  test("it is served from this app's own origin, never a CDN", () => {
    expect(ZXING_WASM_PATH.startsWith("/")).toBe(true);
    expect(ZXING_WASM_PATH).not.toMatch(/^\/\//);
  });

  test("the copy matches the fingerprint the installed zxing-wasm publishes", () => {
    const publicDir = mkdtempSync(join(tmpdir(), "truestock-zxing-"));
    const dest: string = copyZxingWasm(publicDir);
    expect(dest).toBe(join(publicDir, ...ZXING_WASM_PATH.split("/").filter(Boolean)));
    const sha = createHash("sha256").update(readFileSync(dest)).digest("hex");
    expect(sha).toBe(ZXING_WASM_SHA256);
  });
});
