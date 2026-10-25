/**
 * Content-Security-Policy construction, split out of `middleware.ts` so the
 * policy can be unit-tested without a `NextResponse`. `middleware.ts` still
 * owns the nonce and the response header — see the long comment there for why
 * the CSP is served per request and must never move into `next.config.ts`'s
 * `headers()`.
 */

/**
 * The one route whose response is deliberately embeddable: the invoice file
 * the review page shows in its "Source Document Preview" <iframe>.
 *
 * Everything else keeps `frame-ancestors 'none'` + `X-Frame-Options: DENY`.
 * Keep this in lockstep with the `/api/invoices/:id/file` entry in
 * `next.config.ts`, which relaxes the legacy header for the same path.
 */
const INVOICE_FILE_PATH = /^\/api\/invoices\/[0-9]+\/file$/;

export function isInvoiceFilePath(pathname: string): boolean {
  return INVOICE_FILE_PATH.test(pathname);
}

export function buildCsp(nonce: string, pathname: string): string {
  const isDev = process.env.NODE_ENV === "development";
  // Same-origin framing only, never `*` and never another site. The route
  // behind this is owner-gated and serves PDF / raster images only (see
  // `lib/storage/invoice-content-types.ts`), with `nosniff` set globally, so
  // nothing served here can execute script.
  const framable = isInvoiceFilePath(pathname);

  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' is for the barcode scanner: `barcode-detector`'s
    // ZXing-WASM polyfill calls WebAssembly.instantiate on a same-origin
    // .wasm module wherever the native BarcodeDetector is missing. It does
    // not permit eval()/new Function() — that needs the far broader
    // 'unsafe-eval', which stays out of production entirely.
    //
    // Development adds 'unsafe-eval' because Turbopack's HMR client and React
    // Fast Refresh evaluate modules at runtime. This is scoped to dev by
    // NODE_ENV and never reaches a deployed build.
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
    // Radix/shadcn primitives (the fill-level slider and dialog) set inline
    // style attributes for transforms and positioning. Inline styles cannot
    // execute script, so this is a far smaller concession than the same
    // keyword on script-src.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // Every fetch in the MVP is same-origin. Dev also needs the HMR
    // websocket. Revisit when a vision API or object storage arrives —
    // neither is in MVP scope (CLAUDE.md).
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    // Chrome renders a framed PDF through its built-in viewer, which counts
    // as plugin content; `object-src 'none'` on the PDF response itself is
    // the usual reason a framed PDF shows up blank. Relaxed to 'self' for the
    // invoice file route only.
    `object-src ${framable ? "'self'" : "'none'"}`,
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${framable ? "'self'" : "'none'"}`,
  ].join("; ");
}
