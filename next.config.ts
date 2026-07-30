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

// Hosts allowed to request Next's own dev resources (/_next/*, /__nextjs*).
// Next 16 blocks cross-origin access to them by default and only ever trusts
// `localhost` plus the dev server's own -H value — which docker/app/Dockerfile
// sets to 0.0.0.0, so a LAN IP is NOT covered by it.
//
// Entries are bare HOSTNAMES, not origins: no scheme, no port. Passing
// "http://192.168.1.10:3000" here silently matches nothing. Verified against
// node_modules/next/dist/server/lib/router-utils/block-cross-site-dev.js,
// which compares `parseUrl(origin).hostname` against this list.
//
// Only the HMR websocket actually trips this — same-origin document and asset
// GETs send no Origin header and are never blocked — so getting it wrong costs
// you hot reload, not the app. Set by scripts/dev-lan.sh; empty otherwise, and
// `next dev` is the only thing that reads it.
// `127.0.0.1` is listed because Next's built-in allowance covers `localhost`
// and `*.localhost` ONLY — the IP literal is a different host to that check,
// so `/_next/*` returns 403 and the client bundle never runs. The page still
// renders and returns 200; it simply never hydrates, which is the same silent
// failure shape as the CSP incident. Confirmed by request, not by reading:
// the same chunk returns 403 for an `Origin` of 127.0.0.1:3000 and 200 for
// localhost:3000.
//
// It is listed here rather than left alone because lib/auth.ts deliberately
// trusts `http://127.0.0.1:3000` as a dev origin, and docker-compose.yml
// publishes on 127.0.0.1 by default. Those said 127.0.0.1 was supported while
// this said otherwise, and the disagreement was invisible.
// DEV_LAN_ORIGIN is comma-separated (http on :3000 and https on :3443 are two
// origins), but this list wants HOSTNAMES — so both collapse to the same entry
// and the Set removes the duplicate.
const devLanHosts = (process.env.DEV_LAN_ORIGIN ?? "")
  .split(",")
  .map((origin) => URL.parse(origin.trim())?.hostname)
  .filter((host): host is string => Boolean(host));
const devOrigins = [...new Set(["127.0.0.1", ...devLanHosts])];

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins,
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
