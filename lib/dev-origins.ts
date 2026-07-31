/**
 * Parse DEV_LAN_ORIGIN into an allowlist of hostnames for dev-only checks.
 *
 * Extracted to a single place because it is used in two contexts:
 *   1. next.config.ts's `allowedDevOrigins` for Next's /_next/* block-list
 *   2. Preflight's server-side origin check to catch misconfiguration early
 *
 * DEV_LAN_ORIGIN is a comma-separated list of full origins (scheme + host +
 * port), set by scripts/dev-lan.sh. Both http and https variants point to the
 * same server, so we extract the hostname from each and deduplicate.
 *
 * Example: "http://192.168.1.10:3000,https://192.168.1.10:3443"
 *          → ["127.0.0.1", "192.168.1.10"]
 *
 * This function is also used by lib/auth.ts, which needs the full origins
 * (scheme + port), not just hostnames. That is handled differently there —
 * it splits DEV_LAN_ORIGIN directly in the trustedOrigins array and does not
 * call this function.
 */
export function parseDevOriginHosts(): string[] {
  const devLanHosts = (process.env.DEV_LAN_ORIGIN ?? "")
    .split(",")
    .map((origin) => URL.parse(origin.trim())?.hostname)
    .filter((host): host is string => Boolean(host));
  // 127.0.0.1 is listed explicitly because Next's built-in allowance covers
  // `localhost` and `*.localhost` only — the IP literal is a different host,
  // so /_next/* returns 403 and the client bundle never runs. See next.config.ts
  // for the full reasoning.
  return [...new Set(["127.0.0.1", ...devLanHosts])];
}
