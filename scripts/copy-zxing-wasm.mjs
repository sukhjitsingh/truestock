/**
 * `predev` / `prebuild` hook: self-host the barcode scanner's .wasm so the CSP
 * (`connect-src 'self'`) does not block it. See lib/scanner-assets.ts.
 *
 * The output is gitignored (`public/vendor/`): it is a build artifact derived
 * from the installed `zxing-wasm`, never source.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyZxingWasm } from "./lib/copy-zxing-wasm.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Mirrors ZXING_WASM_PUBLIC_PATH in lib/scanner-assets.ts (a .ts file this .mjs
// cannot import); tests/scanner-assets.test.ts fails if the two drift.
const publicPath = "public/vendor/zxing_reader.wasm";

const { to, bytes } = copyZxingWasm({ repoRoot, publicPath });
console.log(`copy-zxing-wasm: ${path.relative(repoRoot, to)} (${bytes} bytes)`);
