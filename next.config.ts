import type { NextConfig } from "next";

// Baseline security headers (open-items.md #5). This app self-hosts — no
// platform-side mitigation exists, so these are the whole defense, not a
// supplement to one.
//
// The Content-Security-Policy is deliberately NOT here. It lives in
// middleware.ts because it has to carry a per-request nonce, and a static
// header cannot. Setting it in both places is actively harmful: two CSP
// headers are intersected by the browser, so the stricter nonce-less one
// would go on silently blocking Next's inline scripts. See middleware.ts for
// the full reasoning and the failure it caused.
//
// No `upgrade-insecure-requests` is needed — Hostinger's SSL is
// auto-provisioned and there is no mixed-content path to begin with.
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
