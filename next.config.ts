import type { NextConfig } from "next";

// Baseline security headers (open-items.md #5). This app self-hosts — no
// platform-side mitigation exists, so these are the whole defense, not a
// supplement to one.
//
// CSP notes, all deliberate, none of them a default we forgot to tighten:
// - `script-src 'self' 'wasm-unsafe-eval'`: the barcode scanner
//   (`barcode-detector`'s ZXing-WASM polyfill, used wherever the native
//   `BarcodeDetector` API isn't available) calls `WebAssembly.instantiate` /
//   `instantiateStreaming` on a same-origin-fetched .wasm module. Neither
//   works without `wasm-unsafe-eval`. This does NOT enable arbitrary
//   `eval()`/`new Function()` — that would need the much broader
//   `unsafe-eval`, which is deliberately absent.
// - `style-src 'self' 'unsafe-inline'`: Radix/shadcn primitives (the slider
//   and dialog used for fill-level entry) set inline `style` attributes for
//   transforms and positioning. Inline *styles* can't run script, so this is
//   a much smaller concession than `unsafe-inline` on `script-src`, which
//   stays out entirely.
// - `connect-src 'self'`: every fetch in the MVP is same-origin (server
//   actions, route handlers). No AI vision API, no object storage — neither
//   is in scope (CLAUDE.md), so nothing external needs an allowance here.
//   Revisit this the day either is added.
// - `frame-ancestors 'none'`: this app is never meant to be framed by
//   anything, including itself.
// - No `upgrade-insecure-requests` needed — Hostinger's SSL is
//   auto-provisioned and there is no mixed-content path to begin with.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = [
  {
    // HTTPS is mandatory here anyway (camera/barcode APIs refuse to run over
    // plain HTTP), so this just tells the browser to stop asking. No
    // `preload` — submitting to the browser preload list is a one-way door
    // and shouldn't happen as a side effect of a config file.
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Belt-and-braces alongside `frame-ancestors` above for the handful of
  // older clients that only honor the legacy header.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // Camera access must stay usable for the barcode scanner and any
    // future fill-level photo capture; everything else this app has no use
    // for is explicitly denied rather than left to the browser default.
    key: "Permissions-Policy",
    value:
      "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
];

const nextConfig: NextConfig = {
  // Hostinger managed Node hosting: emit a minimal self-contained server.
  // Do not remove — the deployed footprint depends on it (CLAUDE.md, spec §11).
  output: "standalone",
  // Photos are served from storage with signed URLs; disabling the built-in
  // optimizer also removes that self-hosted attack surface. As of 2026-07,
  // this also keeps `sharp`'s libvips CVEs dormant (open-items.md #5) — do
  // not flip this back on without re-auditing that dependency first.
  images: { unoptimized: true },
  // Don't advertise the framework in responses — a small, free reduction in
  // fingerprinting surface (open-items.md #5).
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
