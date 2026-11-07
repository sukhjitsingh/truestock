/**
 * Runs in the browser before the app's own client code (Next.js
 * `instrumentation-client`). Its one job: stop zod probing for `eval`.
 *
 * zod 4 builds object schemas with a JIT fast path and decides whether it may
 * use it by trying `Function("")` inside a try/catch. Under our production CSP
 * (`lib/csp.ts`: `script-src 'self' 'nonce-…' 'wasm-unsafe-eval'`, with
 * `'unsafe-eval'` only in dev) the probe is
 * refused, caught, and the schema silently falls back to the interpreted
 * parser — so nothing breaks — but the browser still raises a
 * `securitypolicyviolation` for it, on every page whose bundle constructs a
 * `z.object` at module load (the catalog table, the invoice review form, the
 * audit packet). That is noise a CSP report endpoint cannot tell from a real
 * injection attempt, and it makes the browser harness's "no CSP violations"
 * check fail on a page that is fine.
 *
 * `jitless: true` skips the probe and takes the same interpreted path the
 * catch would have. The server keeps its JIT: this file never loads there,
 * and the server has no such CSP. The CSP itself is untouched — the nonce in
 * `middleware.ts` stays the only thing that lets a script run.
 *
 * Imported from `zod/v4/core` rather than `zod` so this runs on every page
 * without pulling the whole schema library into the shared bundle. zod keeps
 * its config on `globalThis`, so setting it here reaches every copy.
 */
import { config } from "zod/v4/core";

config({ jitless: true });
