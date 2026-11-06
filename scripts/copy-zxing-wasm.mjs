/**
 * Copy the app-provided barcode reader's engine (zxing_reader.wasm) out of
 * node_modules into public/, so the app serves it from its own origin.
 *
 * Runs before every `dev` and `build` (package.json), which covers local dev,
 * the Docker app container (`npm run dev`), the production-mode LAN runner
 * (`npm run build`), CI and the deploy pipeline (`bun run build`).
 *
 * Copied rather than committed so the file can never drift from the installed
 * `zxing-wasm` version: the JavaScript half of the reader and its engine must
 * match exactly. tests/barcode-reader.test.ts checks the copy against the
 * fingerprint the package itself publishes (ZXING_WASM_SHA256).
 *
 * Why the app serves it at all: see ZXING_WASM_PATH in lib/barcode-reader.ts.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the engine sits in node_modules: hoisted (bun, npm) or nested. */
const CANDIDATES = [
  "node_modules/zxing-wasm/dist/reader/zxing_reader.wasm",
  "node_modules/barcode-detector/node_modules/zxing-wasm/dist/reader/zxing_reader.wasm",
];

/** Copies the engine to `<publicDir>/zxing/zxing_reader.wasm`; returns that path. */
export function copyZxingWasm(publicDir = join(ROOT, "public")) {
  const source = CANDIDATES.map((c) => join(ROOT, c)).find((p) => existsSync(p));
  if (!source) {
    throw new Error(
      `zxing_reader.wasm not found in node_modules (looked in: ${CANDIDATES.join(", ")}). ` +
        "Run `bun install`. Without it, phones with no built-in barcode reader cannot scan.",
    );
  }
  const dest = join(publicDir, "zxing", "zxing_reader.wasm");
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  return dest;
}

// Guarded per AGENTS.md: importing this file (as the test does) must not copy.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`copy-zxing-wasm: ${copyZxingWasm()}`);
}
