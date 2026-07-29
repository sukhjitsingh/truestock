import { NextResponse, type NextRequest } from "next/server";

/**
 * Content-Security-Policy, generated per request so it can carry a nonce.
 *
 * This does NOT do authorization. CLAUDE.md invariant 7 is explicit that
 * authorization is checked inside every server action and route handler
 * precisely because several Next.js CVEs are middleware bypasses — nothing
 * here is load-bearing for access control, and nothing should be added that
 * is. It sets a response header and stops.
 *
 * Why it exists at all: the CSP used to be a static header in
 * next.config.ts, and it broke the entire client bundle. Next's App Router
 * ships two kinds of inline <script> to the browser — the request id
 * (`self.__next_r`) and the streamed RSC payload (`self.__next_f.push`) —
 * and `script-src 'self'` blocks both. The symptom is vicious: the server
 * renders every page correctly and returns 200, so curl, `next build` and
 * any status-code check all pass, while in a real browser nothing hydrates.
 * A form's onSubmit never attaches, so the browser falls back to a native
 * GET submit and puts the typed password in the URL. That was observed, not
 * theorised — it is how the dev password ended up in the container logs.
 *
 * A nonce is the fix rather than 'unsafe-inline': Next stamps the nonce it
 * reads from this request header onto its own inline scripts, so they run
 * while an injected one still does not. Note that when a nonce is present
 * browsers deliberately ignore 'unsafe-inline', so the two cannot be mixed
 * as a belt-and-braces measure — the nonce has to actually be correct.
 */
function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";

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
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function middleware(request: NextRequest) {
  const nonce = crypto.randomUUID();
  const csp = buildCsp(nonce);

  // Next reads the CSP off the *request* headers to discover the nonce and
  // apply it to the inline scripts it generates. Setting it only on the
  // response would ship a nonce that nothing on the page carries — which
  // fails exactly like having no nonce at all.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Static assets and images are served straight from disk and carry no
    // inline script, so nonce generation on them is pure overhead. The
    // document requests are what need this.
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
