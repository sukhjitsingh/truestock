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

/**
 * Will Next actually serve `/_next/*` to this hostname in dev?
 *
 * This is deliberately NOT the same question as "is it in
 * `parseDevOriginHosts()`", and conflating the two produced a false alarm that
 * cost real trust (open item 26). `allowedDevOrigins` is only the *configured*
 * half; Next allows `localhost` and `*.localhost` on its own, without them
 * appearing in any list. So the preflight check reported "Origin allowed: NO"
 * on plain `http://localhost:3000` — and went on to claim no JavaScript runs —
 * while the page was fully hydrated and working.
 *
 * That direction of error is the expensive one. A warning that fires when
 * nothing is wrong is one people learn to scroll past, which is exactly when it
 * stops being able to warn them about the LAN misconfiguration it exists for.
 *
 * Kept as a pure function of the hostname so it can be tested without a
 * browser, a request, or a running dev server.
 */
export function isDevOriginAllowed(hostname: string): boolean {
  if (!hostname) return false;
  // Next's built-in dev allowance, which no configuration expresses.
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  return parseDevOriginHosts().includes(hostname);
}
