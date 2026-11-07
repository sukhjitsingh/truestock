/**
 * Where the barcode scanner's WebAssembly module is loaded from.
 *
 * `barcode-detector`'s polyfill (used wherever the browser has no native
 * `BarcodeDetector` — iOS Safari, desktop Chrome/Firefox) decodes with
 * `zxing-wasm`, whose DEFAULT is to fetch its `.wasm` from a jsDelivr URL.
 * That fetch is blocked by the CSP's `connect-src 'self'` (lib/csp.ts), and
 * the failure is silent in the way this app's worst failures are: the camera
 * opens, the preview plays, and nothing ever decodes. Search-only counting
 * still works, so nobody sees it until a counter wonders why scanning "does
 * nothing". It was found in QA by deleting `window.BarcodeDetector` and
 * pointing a fake camera at a printed EAN.
 *
 * The module is served from this origin instead: `scripts/copy-zxing-wasm.mjs`
 * copies it from node_modules into `public/vendor/` before every dev start and
 * build (the `predev` / `prebuild` scripts), so it always matches the installed
 * `zxing-wasm` version. Widening `connect-src` to the CDN was rejected — it
 * would trade a working scanner for a third-party fetch on every count screen
 * and a hard dependency on that CDN being up inside a dim bar.
 *
 * Pure and dependency-free so the build script, the scanner component and the
 * tests can all share one definition of the path.
 */

/** Public URL path of the self-hosted module. Must equal `public` + this. */
export const ZXING_WASM_URL = "/vendor/zxing_reader.wasm";

/** Repo-relative location the copy script writes to (Next serves `public/` at `/`). */
export const ZXING_WASM_PUBLIC_PATH = `public${ZXING_WASM_URL}`;

/**
 * Emscripten `locateFile` override: the `.wasm` comes from this origin, every
 * other asset keeps the library's default resolution.
 */
export function locateScannerFile(path: string, prefix: string): string {
  return path.endsWith(".wasm") ? ZXING_WASM_URL : prefix + path;
}
