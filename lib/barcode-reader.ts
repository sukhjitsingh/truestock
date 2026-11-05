/**
 * Which barcode reader the scanner uses: the phone's built-in one, or the
 * reader this app provides.
 *
 * Pure on purpose (no DOM, no imports), so the rule is tested without a phone,
 * the same way lib/rescan-guard.ts is.
 *
 * ## The rule
 *
 * Use the built-in reader only if it exists AND can read every retail
 * symbology a bottle or case carries. A built-in reader that exists but cannot
 * read UPC/EAN counts as "not present": choosing it would open a camera that
 * never recognises a bottle, with nothing on screen saying why. Otherwise use
 * the app-provided reader, which is always available because the app serves
 * its engine itself (see ZXING_WASM_PATH).
 */

/** Every code a liquor bottle or its case carries. The built-in reader must
 *  support all four to be used. */
export const RETAIL_BARCODE_FORMATS = ["upc_a", "upc_e", "ean_13", "ean_8"] as const;

/** What the scanner asks for. Deliberately narrow: each extra format costs
 *  detection time on every frame of a requestAnimationFrame loop on a phone. */
export const SCAN_BARCODE_FORMATS = [...RETAIL_BARCODE_FORMATS, "code_128", "code_39"] as const;

/**
 * Where the app-provided reader's engine is served from — this app's own
 * origin, copied out of node_modules by scripts/copy-zxing-wasm.mjs on every
 * `dev` and `build`.
 *
 * It must be same-origin. By default the `zxing-wasm` package downloads its
 * engine from cdn.jsdelivr.net, and the app's Content-Security-Policy
 * (`connect-src 'self'`, middleware.ts) refuses that — so on any phone without
 * a usable built-in reader the scanner opened, decoded nothing, and failed
 * silently. Found 2026-11-05 (docs/plans/barcode-integrity, slice 1).
 */
export const ZXING_WASM_PATH = "/zxing/zxing_reader.wasm";

export type ReaderChoice =
  | { kind: "built-in"; formats: string[] }
  | { kind: "app"; formats: string[] };

export function chooseBarcodeReader(builtIn: {
  /** Whether `window.BarcodeDetector` exists. */
  available: boolean;
  /** What `BarcodeDetector.getSupportedFormats()` returned, or null if it
   *  could not be asked (missing method, or it threw). */
  supportedFormats: readonly string[] | null;
}): ReaderChoice {
  if (builtIn.available && builtIn.supportedFormats) {
    const supported = new Set(builtIn.supportedFormats);
    if (RETAIL_BARCODE_FORMATS.every((f) => supported.has(f))) {
      return { kind: "built-in", formats: SCAN_BARCODE_FORMATS.filter((f) => supported.has(f)) };
    }
  }
  return { kind: "app", formats: [...SCAN_BARCODE_FORMATS] };
}
