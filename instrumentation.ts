/**
 * Process-lifecycle hook (Next.js 16, stable — no `experimental.instrumentationHook`
 * flag needed). `register()` runs once per server process, before any route
 * handler serves a request, in every runtime Next starts (`nodejs` AND `edge`
 * for `middleware.ts`).
 *
 * All Node-only work — `node:os`, and the extraction pipeline / reap sweep,
 * which pull in the mysql2 driver — lives in `instrumentation-node.ts` and is
 * reached ONLY through the dynamic `import()` below, inside the
 * `NEXT_RUNTIME === "nodejs"` branch. That indirection is load-bearing, not
 * style: Next also builds an edge-runtime bundle of this exact file for
 * `middleware.ts`, and a bundler resolves a module's TOP-LEVEL imports for
 * every target it builds, regardless of what a runtime `if` inside a
 * function guards. A static `import { hostname } from "node:os"` at the top
 * of this file — which is what shipped originally — is therefore evaluated
 * in the edge bundle too, and the edge runtime has no `node:os`. Shipped and
 * broke exactly that way: "Failed to load external module node:os: Native
 * module not found: node:os", thrown from module evaluation before
 * `register()` ever runs, on every request once middleware touched it.
 * Fixed 2026-08-15 by moving everything Node-only behind this dynamic
 * import — the pattern Next's own instrumentation docs prescribe for exactly
 * this split. See `instrumentation-node.ts` for the cron itself (extraction
 * every 2 minutes, reap sweep every 5).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { registerCron } = await import("./instrumentation-node");
  registerCron();
}
