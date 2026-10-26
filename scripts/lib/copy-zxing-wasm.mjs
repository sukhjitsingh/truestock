/**
 * Copies the barcode scanner's WebAssembly module out of node_modules into
 * `public/vendor/`, so the browser loads it from this origin (see
 * lib/scanner-assets.ts for why). Split from the CLI wrapper
 * (`scripts/copy-zxing-wasm.mjs`) so a test can import it — a module that runs
 * on import cannot be.
 *
 * Resolved through the package's own `exports` map, so it follows whatever
 * version bun installed rather than a hard-coded node_modules path, and it
 * throws if the module is missing instead of shipping a scanner that cannot
 * decode.
 */
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

/** The export `zxing-wasm` publishes its reader module under. */
const WASM_SPECIFIER = "zxing-wasm/reader/zxing_reader.wasm";

/**
 * @param {{ repoRoot: string, publicPath: string }} args
 *   `publicPath` is repo-relative, e.g. `public/vendor/zxing_reader.wasm`; an
 *   absolute path is used as-is (tests copy into a temp dir).
 * @returns {{ from: string, to: string, bytes: number }}
 */
export function copyZxingWasm({ repoRoot, publicPath }) {
  const require = createRequire(path.join(repoRoot, "package.json"));
  let from;
  try {
    from = require.resolve(WASM_SPECIFIER);
  } catch (err) {
    throw new Error(
      `copy-zxing-wasm: cannot resolve ${WASM_SPECIFIER} — is zxing-wasm installed? ` +
        `(run \`bun install\`). ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!existsSync(from)) {
    throw new Error(`copy-zxing-wasm: ${from} does not exist`);
  }

  const to = path.resolve(repoRoot, publicPath);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);

  const bytes = statSync(to).size;
  if (bytes === 0) {
    throw new Error(`copy-zxing-wasm: copied ${from} but ${to} is empty`);
  }
  return { from, to, bytes };
}
