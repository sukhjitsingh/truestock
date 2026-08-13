/**
 * `lib/dev-origins.ts` — pure, no database, no browser.
 *
 * These exist because the preflight origin check got this wrong in the
 * direction that costs trust (open item 26): it reported "Origin allowed: NO"
 * and claimed no JavaScript would run, on plain `http://localhost:3000`, while
 * the page was fully hydrated. `allowedDevOrigins` is only the *configured*
 * half of the answer — Next allows `localhost` and `*.localhost` on its own,
 * and nothing in any config file says so.
 *
 * The first test below fails against the old
 * `parseDevOriginHosts().includes(hostname)` implementation, which is the point.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isDevOriginAllowed, parseDevOriginHosts } from "@/lib/dev-origins";

const original = process.env.DEV_LAN_ORIGIN;
afterEach(() => {
  if (original === undefined) delete process.env.DEV_LAN_ORIGIN;
  else process.env.DEV_LAN_ORIGIN = original;
});

describe("isDevOriginAllowed", () => {
  test("localhost is allowed with DEV_LAN_ORIGIN unset — the false alarm in open item 26", () => {
    delete process.env.DEV_LAN_ORIGIN;
    expect(isDevOriginAllowed("localhost")).toBe(true);
    // And it is NOT in the configured list, which is exactly why checking that
    // list alone produced a wrong verdict.
    expect(parseDevOriginHosts()).not.toContain("localhost");
  });

  test("a .localhost subdomain is allowed — Next's allowance is `localhost` and `*.localhost`", () => {
    delete process.env.DEV_LAN_ORIGIN;
    expect(isDevOriginAllowed("truestock.localhost")).toBe(true);
  });

  test("127.0.0.1 is allowed even unconfigured — Next's allowance does not cover the IP literal", () => {
    delete process.env.DEV_LAN_ORIGIN;
    expect(isDevOriginAllowed("127.0.0.1")).toBe(true);
  });

  test("a LAN IP is refused when DEV_LAN_ORIGIN is unset — the real failure this check exists for", () => {
    delete process.env.DEV_LAN_ORIGIN;
    expect(isDevOriginAllowed("192.168.12.33")).toBe(false);
  });

  test("the same LAN IP is allowed once DEV_LAN_ORIGIN names it", () => {
    process.env.DEV_LAN_ORIGIN = "http://192.168.12.33:3000,https://192.168.12.33:3443";
    expect(isDevOriginAllowed("192.168.12.33")).toBe(true);
    // A different LAN host is still refused — negative control, so the test
    // above cannot pass by the function simply returning true once configured.
    expect(isDevOriginAllowed("192.168.12.99")).toBe(false);
  });

  test("an empty hostname is refused rather than matching something", () => {
    process.env.DEV_LAN_ORIGIN = "http://192.168.12.33:3000";
    expect(isDevOriginAllowed("")).toBe(false);
  });

  test("`notlocalhost` does not match the localhost allowance by suffix", () => {
    delete process.env.DEV_LAN_ORIGIN;
    // `.endsWith("localhost")` would wrongly allow this; the check uses
    // `.endsWith(".localhost")`.
    expect(isDevOriginAllowed("notlocalhost")).toBe(false);
  });
});

describe("parseDevOriginHosts", () => {
  test("extracts hostnames from full origins and deduplicates http/https pairs", () => {
    process.env.DEV_LAN_ORIGIN = "http://192.168.12.33:3000,https://192.168.12.33:3443";
    expect(parseDevOriginHosts()).toEqual(["127.0.0.1", "192.168.12.33"]);
  });

  test("unset DEV_LAN_ORIGIN yields only the 127.0.0.1 literal", () => {
    delete process.env.DEV_LAN_ORIGIN;
    expect(parseDevOriginHosts()).toEqual(["127.0.0.1"]);
  });

  test("garbage entries are dropped rather than becoming empty-string hosts", () => {
    process.env.DEV_LAN_ORIGIN = "not-a-url,,http://10.0.0.5:3000";
    expect(parseDevOriginHosts()).toEqual(["127.0.0.1", "10.0.0.5"]);
  });
});
