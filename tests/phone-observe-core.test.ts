/**
 * `scripts/phone/lib/observe-core.mjs` — pure, no database, no browser, no adb.
 *
 * The phone observer attaches to a browser that also holds the owner's other
 * tabs, and records a session in which a password gets typed. What it may write
 * to disk is therefore a privacy contract, not a tuning knob, and a regression
 * is silent: the session log still looks complete. So each way of leaking gets
 * its own assertion here — a password never reaches the log (not even its
 * length), a query string never appears, a tab on another origin is rejected,
 * and the page agent cannot smuggle an unlisted field through by adding it.
 *
 * Only the pure module is imported. `observe.mjs` talks to adb and a browser at
 * module scope and would try to attach on import.
 */
import { describe, expect, test } from "bun:test";
import {
  buildRequestEvent,
  buildSummary,
  checkOutDir,
  classifyNextRequest,
  classifyRequestScope,
  computeCounts,
  describeEvent,
  headlineCounts,
  isNotable,
  isSameOrigin,
  normalizeOrigin,
  parseAdbDevices,
  parseDevtoolsSockets,
  pickDevice,
  pickSocket,
  redactUrl,
  safeText,
  sanitizeElement,
  sanitizeField,
  sanitizeInteraction,
  sanitizeSnapshot,
  screenshotSkipReason,
  selectTimeline,
  shotName,
  slugForPath,
} from "@/scripts/phone/lib/observe-core.mjs";

const ORIGIN = "https://192.168.12.33:3443";
const SECRET = "hunter2-secret";
const TOKEN = "SECRETVALUE";

describe("origin gate", () => {
  test("accepts exactly the observed origin, any path/query/hash", () => {
    expect(isSameOrigin(`${ORIGIN}/count/4?token=${TOKEN}#frag`, ORIGIN)).toBe(true);
    expect(isSameOrigin(`${ORIGIN}/`, ORIGIN)).toBe(true);
  });

  test("rejects a different port, host, or scheme", () => {
    expect(isSameOrigin("https://192.168.12.33:3444/", ORIGIN)).toBe(false);
    expect(isSameOrigin("https://192.168.12.34:3443/", ORIGIN)).toBe(false);
    expect(isSameOrigin("http://192.168.12.33:3443/", ORIGIN)).toBe(false);
  });

  test("rejects look-alike hosts that merely contain the origin", () => {
    expect(isSameOrigin(`https://192.168.12.33:3443.evil.example/`, ORIGIN)).toBe(false);
    expect(isSameOrigin(`https://evil.example/?next=${ORIGIN}`, ORIGIN)).toBe(false);
    expect(isSameOrigin(`https://user@evil.example/${ORIGIN}`, ORIGIN)).toBe(false);
  });

  test("rejects non-web and unparsable pages (new tab, internal pages, garbage)", () => {
    for (const u of ["about:blank", "chrome://newtab/", "chrome-error://chromewebdata/", "data:text/html,hi", "", "not a url"]) {
      expect(isSameOrigin(u, ORIGIN)).toBe(false);
    }
    expect(isSameOrigin(undefined as unknown as string, ORIGIN)).toBe(false);
  });

  test("normalizeOrigin keeps only the origin and refuses non-http(s)", () => {
    expect(normalizeOrigin(`${ORIGIN}/count?x=1`)).toBe(ORIGIN);
    expect(normalizeOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(() => normalizeOrigin("192.168.12.33:3443")).toThrow();
    expect(() => normalizeOrigin("ftp://example.com")).toThrow(/http/);
    expect(() => normalizeOrigin("")).toThrow();
  });

  test("request scope: same-origin recorded, cross-origin only as a subresource of an on-origin page", () => {
    const f = `${ORIGIN}/count`;
    expect(classifyRequestScope({ requestUrl: `${ORIGIN}/api`, frameUrl: f, isNavigation: false }, ORIGIN)).toBe("same");
    expect(classifyRequestScope({ requestUrl: "https://cdn.example/x.js", frameUrl: f, isNavigation: false }, ORIGIN)).toBe("cross");
    // The tab leaving for another site is not logged.
    expect(classifyRequestScope({ requestUrl: "https://bank.example/login", frameUrl: f, isNavigation: true }, ORIGIN)).toBe("ignore");
    // A request from a frame that is not on the origin is not ours.
    expect(classifyRequestScope({ requestUrl: "https://tracker.example/p", frameUrl: "https://bank.example/", isNavigation: false }, ORIGIN)).toBe("ignore");
  });
});

describe("URL redaction", () => {
  test("keeps the path and reports that a query existed, never its contents", () => {
    const r: unknown = redactUrl(`${ORIGIN}/count/4?token=${TOKEN}&x=1`);
    expect(r).toEqual({ path: "/count/4", query: true, queryLen: `token=${TOKEN}&x=1`.length });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test("drops the fragment, which is where OAuth-style tokens live", () => {
    const r: unknown = redactUrl(`${ORIGIN}/cb#access_token=${TOKEN}`);
    expect(r).toEqual({ path: "/cb", hash: true });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test("a bare path and a root path have no query flag", () => {
    expect(redactUrl(`${ORIGIN}/`)).toEqual({ path: "/" });
    expect(redactUrl("/a/b")).toEqual({ path: "/a/b" });
  });

  test("free text: query strings inside console messages and stack frames are scrubbed", () => {
    const t = safeText(`Failed ${ORIGIN}/api/x?token=${TOKEN}&u=1 at /count?session=${TOKEN} #frag`);
    expect(t).not.toContain(TOKEN);
    expect(t).toContain("/api/x");
  });

  test("free text: a floating ?key=value or #key=value run is scrubbed, a plain ? or #1 is not", () => {
    const t = safeText(`unhandled rejection ?token=${TOKEN} then #access_token=${TOKEN} and &session=${TOKEN}; why? see #1`);
    expect(t).not.toContain(TOKEN);
    expect(t).toContain("why? see #1");
  });

  test("safeText truncates to the limit", () => {
    expect(safeText("x".repeat(900), 500).length).toBeLessThanOrEqual(500);
    expect(safeText("a \n\n  b\t c", 50)).toBe("a b c");
  });
});

describe("Next.js traffic classification", () => {
  test("next-action header -> server action, case-insensitively, and wins over rsc", () => {
    expect(classifyNextRequest({ "next-action": "abc" })).toEqual({ kind: "action" });
    expect(classifyNextRequest({ "Next-Action": "abc", RSC: "1" })).toEqual({ kind: "action" });
  });

  test("rsc header -> rsc navigation; prefetch headers -> rsc prefetch", () => {
    expect(classifyNextRequest({ rsc: "1" })).toEqual({ kind: "rsc", prefetch: false });
    expect(classifyNextRequest({ rsc: "1", "next-router-prefetch": "1" })).toEqual({ kind: "rsc", prefetch: true });
    expect(classifyNextRequest({ "next-router-segment-prefetch": "/_tree" })).toEqual({ kind: "rsc", prefetch: true });
  });

  test("ordinary traffic is not classified", () => {
    expect(classifyNextRequest({ accept: "text/html", "content-type": "application/json" })).toBeNull();
    expect(classifyNextRequest(undefined as unknown as Record<string, string>)).toBeNull();
  });

  test("action event: path, status and duration only", () => {
    const ev = buildRequestEvent({
      method: "POST",
      url: `${ORIGIN}/count/4?secret=${TOKEN}`,
      headers: { "next-action": "abc123", cookie: "session=COOKIEVALUE", authorization: "Bearer BEARERVALUE" },
      status: 500,
      responseHeaders: { "set-cookie": "s=SETCOOKIEVALUE" },
      durationMs: 1830,
    });
    expect(ev).toEqual({ kind: "action", method: "POST", path: "/count/4", status: 500, durationMs: 1830 });
    const blob = JSON.stringify(ev);
    for (const bad of [TOKEN, "COOKIEVALUE", "BEARERVALUE", "SETCOOKIEVALUE", "abc123"]) expect(blob).not.toContain(bad);
  });

  test("rsc event copies only the named cache headers", () => {
    const ev = buildRequestEvent({
      method: "GET",
      url: `${ORIGIN}/count?_rsc=1abc`,
      headers: { rsc: "1", "next-router-prefetch": "1" },
      status: 200,
      responseHeaders: {
        "Cache-Control": "s-maxage=31536000",
        "x-nextjs-cache": "HIT",
        age: "42",
        "set-cookie": "s=SETCOOKIEVALUE",
        "x-powered-by": "Next.js",
        vary: "rsc",
      },
      durationMs: 31,
    });
    expect(ev).toMatchObject({ kind: "rsc", path: "/count", prefetch: true, status: 200 });
    expect(Object.keys((ev as unknown as { cache: object }).cache).sort()).toEqual(["age", "cache-control", "x-nextjs-cache"]);
    expect(JSON.stringify(ev)).not.toContain("SETCOOKIEVALUE");
    expect(JSON.stringify(ev)).not.toContain("_rsc");
  });

  test("ordinary success is dropped; ordinary >=400 becomes an http-error", () => {
    const base = { method: "GET", url: `${ORIGIN}/a.png`, headers: {}, responseHeaders: {}, durationMs: 5 };
    expect(buildRequestEvent({ ...base, status: 200 })).toBeNull();
    expect(buildRequestEvent({ ...base, status: 304 })).toBeNull();
    expect(buildRequestEvent({ ...base, status: 404 })).toEqual({ kind: "http-error", method: "GET", path: "/a.png", status: 404, durationMs: 5 });
  });
});

describe("interaction privacy", () => {
  test("a password change carries no value and no length", () => {
    for (const field of [
      { tag: "input", type: "password", name: "pw", valueLength: SECRET.length, value: SECRET },
      { secret: true, valueLength: SECRET.length, value: SECRET },
      { tag: "input", type: "text", autocomplete: "current-password", valueLength: 9 },
      { tag: "input", type: "text", name: "user_password", valueLength: 9 },
      { tag: "input", type: "text", id: "otp-code", valueLength: 6 },
      { tag: "input", type: "text", autocomplete: "one-time-code", valueLength: 6 },
    ]) {
      const out = sanitizeInteraction({ type: "change", field, value: SECRET });
      expect(out).toEqual({ type: "change", field: { secret: true } });
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(JSON.stringify(out)).not.toContain("valueLength");
    }
  });

  test("a normal field change keeps tag/type/name and the value LENGTH, never the value", () => {
    const out = sanitizeInteraction({
      type: "change",
      field: { tag: "input", type: "text", name: "notes", id: "n1", ariaLabel: "Notes", valueLength: 11, value: "hello-world", innerText: "hello-world" },
      value: "hello-world",
    });
    expect(out).toEqual({
      type: "change",
      field: { tag: "input", inputType: "text", name: "notes", id: "n1", ariaLabel: "Notes", valueLength: 11 },
    });
    expect(JSON.stringify(out)).not.toContain("hello-world");
  });

  test("unlisted fields the page agent adds are dropped (whitelist, not blacklist)", () => {
    const out = sanitizeField({ tag: "input", type: "text", name: "q", valueLength: 3, value: "abc", placeholder: "abc", dataset: { v: "abc" } });
    expect(Object.keys(out as object).sort()).toEqual(["inputType", "name", "tag", "valueLength"]);
  });

  test("file inputs never report a length", () => {
    expect(sanitizeField({ tag: "input", type: "file", valueLength: 22 })).toEqual({ tag: "input", inputType: "file" });
  });

  test("clicking a secret field is described as {secret:true} only", () => {
    const out = sanitizeInteraction({ type: "click", target: { secret: true } });
    expect(out).toEqual({ type: "click", target: { secret: true } });
    const el = sanitizeElement({ tag: "input", type: "password", text: SECRET, id: "pw" });
    expect(el).toEqual({ secret: true });
  });

  test("a text-like field descriptor never contributes text", () => {
    const el = sanitizeElement({ tag: "input", type: "text", name: "notes", text: SECRET, value: SECRET });
    expect(el).toEqual({ tag: "input", inputType: "text", name: "notes" });
    const ce = sanitizeElement({ tag: "div", editable: true, text: SECRET });
    expect(JSON.stringify(ce)).not.toContain(SECRET);
  });

  test("click descriptor: tag, role, label, id, text <= 60, href path without query, disabled flags", () => {
    const out = sanitizeInteraction({
      type: "click",
      target: { tag: "span", text: "Save" },
      via: {
        tag: "button",
        role: "button",
        ariaLabel: "Save count",
        id: "save",
        text: `  Save   (10 ea)  ${"x".repeat(100)}`,
        href: `/count/4?token=${TOKEN}`,
        disabled: true,
        ariaDisabled: false,
        cookie: "nope",
      },
    }) as { target: object; via: Record<string, unknown> };
    expect(out.via.tag).toBe("button");
    expect((out.via.text as string).length).toBeLessThanOrEqual(60);
    expect(out.via.text).toMatch(/^Save \(10 ea\)/);
    expect(out.via.href).toBe("/count/4");
    expect(out.via.disabled).toBe(true);
    expect(out.via).not.toHaveProperty("ariaDisabled");
    expect(out.via).not.toHaveProperty("cookie");
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  test("a tap that never became a click is kept and flagged", () => {
    expect(sanitizeInteraction({ type: "touchend", noClick: true, target: { tag: "button", text: "Save", disabled: true } })).toEqual({
      type: "touchend",
      noClick: true,
      target: { tag: "button", text: "Save", disabled: true },
    });
  });

  test("submit records method and whether a password field exists, nothing else", () => {
    const out = sanitizeInteraction({ type: "submit", form: { method: "POST", hasPassword: true, id: "login", action: `/x?t=${TOKEN}`, data: SECRET } });
    expect(out).toEqual({ type: "submit", form: { method: "post", hasPassword: true, id: "login" } });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  test("a submit with no method (browser default GET) is flagged as a native GET", () => {
    expect(sanitizeInteraction({ type: "submit", form: { hasPassword: true } })).toEqual({
      type: "submit",
      form: { method: "get", hasPassword: true, nativeGet: true },
    });
  });

  test("visibility and connectivity are normalised; unknown types and junk are rejected", () => {
    expect(sanitizeInteraction({ type: "visibilitychange", state: "hidden" })).toEqual({ type: "visibilitychange", state: "hidden" });
    expect(sanitizeInteraction({ type: "visibilitychange", state: SECRET })).toEqual({ type: "visibilitychange", state: "visible" });
    expect(sanitizeInteraction({ type: "connectivity", online: false })).toEqual({ type: "connectivity", online: false });
    for (const junk of [null, undefined, "x", 3, {}, { type: "keydown", key: "a" }, { type: "input", value: SECRET }]) {
      expect(sanitizeInteraction(junk)).toBeNull();
    }
  });
});

describe("snapshot privacy", () => {
  test("body text is collapsed and capped at 1200 chars; unlisted keys are dropped", () => {
    const out = sanitizeSnapshot({
      bodyText: `Count   4\n\n${"word ".repeat(600)}`,
      activeElement: { tag: "input", type: "text", name: "qty", value: SECRET, text: SECRET },
      disabledButtons: 2,
      disabledLabels: ["Finish", "Close", "a", "b", "c", "d", "e"],
      cookies: "nope",
      inputValues: [SECRET],
    }) as Record<string, unknown>;
    expect((out.bodyText as string).length).toBeLessThanOrEqual(1200);
    expect(out.bodyText).toMatch(/^Count 4 word/);
    expect(out.activeElement).toEqual({ tag: "input", inputType: "text", name: "qty" });
    expect(out.disabledButtons).toBe(2);
    expect(out.disabledLabels).toHaveLength(5);
    expect(out).not.toHaveProperty("cookies");
    expect(out).not.toHaveProperty("inputValues");
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test("a focused password field is reported as secret", () => {
    const out = sanitizeSnapshot({ bodyText: "Sign in", activeElement: { tag: "input", type: "password" }, disabledButtons: 0 });
    expect((out as Record<string, unknown> | null)?.activeElement).toEqual({ secret: true });
  });

  test("junk in -> null out", () => {
    expect(sanitizeSnapshot(null)).toBeNull();
    expect(sanitizeSnapshot("x")).toBeNull();
  });
});

describe("adb discovery", () => {
  const LIST = [
    "List of devices attached",
    "R58M123ABC             device usb:1-1 product:a52 model:SM_A525F device:a52q transport_id:3",
    "",
  ].join("\n");

  test("parses devices -l including wireless serials and daemon noise", () => {
    const d = parseAdbDevices(
      [
        "* daemon not running; starting now at tcp:5037",
        "* daemon started successfully",
        "List of devices attached",
        "R58M123ABC device usb:1-1 product:a52 model:SM_A525F device:a52q transport_id:3",
        "192.168.12.40:41234 offline transport_id:5",
        "adb-XYZ._adb-tls-connect._tcp unauthorized transport_id:6",
      ].join("\n"),
    );
    expect(d.map((x) => [x.serial, x.state])).toEqual([
      ["R58M123ABC", "device"],
      ["192.168.12.40:41234", "offline"],
      ["adb-XYZ._adb-tls-connect._tcp", "unauthorized"],
    ]);
    expect((d[0] as { model?: string }).model).toBe("SM_A525F");
  });

  test("none, unauthorized, offline and multiple each give an actionable message", () => {
    expect((pickDevice([], undefined) as { error: string }).error).toMatch(/USB debugging/);
    expect((pickDevice(parseAdbDevices("X unauthorized"), undefined) as { error: string }).error).toMatch(/Allow USB debugging/);
    expect((pickDevice(parseAdbDevices("X offline"), undefined) as { error: string }).error).toMatch(/offline/);
    const two = parseAdbDevices("A device model:One\nB device model:Two");
    const err = (pickDevice(two, undefined) as { error: string }).error;
    expect(err).toMatch(/--serial/);
    expect(err).toContain("A");
    expect(err).toContain("B");
  });

  test("a single ready device, or the one named by --serial, is picked", () => {
    expect((pickDevice(parseAdbDevices(LIST), undefined) as { device: { serial: string } }).device.serial).toBe("R58M123ABC");
    const two = parseAdbDevices("A device\nB device");
    expect((pickDevice(two, "B") as { device: { serial: string } }).device.serial).toBe("B");
    expect((pickDevice(two, "C") as { error: string }).error).toMatch(/not attached/);
  });
});

describe("DevTools socket discovery", () => {
  const UNIX = [
    "Num       RefCount Protocol Flags    Type St Inode Path",
    "0000000000000000: 00000002 00000000 00010000 0001 01 12345 @chrome_devtools_remote",
    "0000000000000000: 00000002 00000000 00010000 0001 01 12346 @webview_devtools_remote_4321",
    "0000000000000000: 00000002 00000000 00010000 0001 01 12347 @chrome_devtools_remote",
    "0000000000000000: 00000002 00000000 00010000 0001 01 12348 /dev/socket/zygote",
  ].join("\n");

  test("finds devtools_remote abstract sockets, de-duplicated, ignoring path sockets", () => {
    expect(parseDevtoolsSockets(UNIX)).toEqual(["chrome_devtools_remote", "webview_devtools_remote_4321"]);
    expect(parseDevtoolsSockets("")).toEqual([]);
  });

  test("defaults to chrome_devtools_remote; --socket overrides; a lone non-WebView variant is accepted", () => {
    const s = parseDevtoolsSockets(UNIX);
    expect(pickSocket(s, undefined)).toMatchObject({ socket: "chrome_devtools_remote" });
    expect(pickSocket(s, "@webview_devtools_remote_4321")).toMatchObject({ socket: "webview_devtools_remote_4321" });
    expect(pickSocket(["brave_devtools_remote", "webview_devtools_remote_9"], undefined)).toMatchObject({ socket: "brave_devtools_remote" });
  });

  test("no sockets, an unknown --socket, and an ambiguous set are errors that say what to do", () => {
    expect((pickSocket([], undefined) as { error: string }).error).toMatch(/tab open/);
    expect((pickSocket(["chrome_devtools_remote"], "nope") as { error: string }).error).toMatch(/not found/);
    expect((pickSocket(["a_devtools_remote", "b_devtools_remote"], undefined) as { error: string }).error).toMatch(/--socket/);
  });
});

describe("summary and timeline", () => {
  const iso = (t: number) => new Date(Date.UTC(2026, 7, 14, 12, 0, 0) + t).toISOString();
  const ev = (t: number, e: Record<string, unknown>) => ({ t, iso: iso(t), ...e });

  const events = [
    ev(0, { kind: "session", phase: "start", origin: ORIGIN }),
    ev(100, { kind: "nav", path: "/count/4", query: true, queryLen: 11, navType: "navigate" }),
    ev(200, { kind: "interaction", type: "click", target: { tag: "span", text: "Save" }, via: { tag: "button", text: "Save (10 ea)" } }),
    ev(300, { kind: "action", method: "POST", path: "/count/4", status: 200, durationMs: 120 }),
    ev(400, { kind: "action", method: "POST", path: "/count/4", status: 500, durationMs: 2100 }),
    ev(450, { kind: "rsc", method: "GET", path: "/count", status: 200, durationMs: 20, prefetch: true }),
    ev(460, { kind: "rsc", method: "GET", path: "/count", status: 200, durationMs: 20, prefetch: false }),
    ev(500, { kind: "http-error", method: "GET", path: "/missing", status: 404, durationMs: 9 }),
    ev(550, { kind: "pageerror", message: "boom" }),
    ev(560, { kind: "console", level: "error", text: "oops" }),
    ev(570, { kind: "console", level: "log", text: "fine" }),
    ev(600, { kind: "requestfailed", method: "GET", path: "/x", errorText: "net::ERR_CONNECTION_RESET" }),
    ev(610, { kind: "requestfailed", method: "GET", path: "/y", errorText: "net::ERR_ABORTED", aborted: true }),
    ev(620, { kind: "requestfailed", method: "POST", path: "/count/4", errorText: "net::ERR_ABORTED", aborted: true, next: "action" }),
    ev(700, { kind: "snapshot", path: "/count/4", bodyText: "Count 4", disabledButtons: 1, shot: "shots/001-count-4.jpg", reason: "nav" }),
    ev(800, { kind: "snapshot", path: "/count/4", unchanged: true }),
  ];

  test("counts: failures, >=400s, actions (failed + slow), rsc prefetch vs navigation, aborted apart", () => {
    const c = computeCounts(events);
    expect(c.pageErrors).toBe(1);
    expect(c.consoleErrors).toBe(1);
    expect(c.requestsFailed).toBe(2); // connection reset + the aborted server action
    expect(c.requestsAborted).toBe(1); // the prefetch-style abort is churn
    expect(c.actions).toBe(3);
    expect(c.actionsFailed).toBe(2); // the 500 and the aborted one
    expect(c.actionsSlow).toBe(1);
    expect(c.rscPrefetch).toBe(1);
    expect(c.rscNavigation).toBe(1);
    expect(c.httpErrors).toBe(2); // 404 + the action 500
    expect(c.clicks).toBe(1);
    expect(c.shots).toBe(1);
  });

  test("live lines name the button the user meant, not the span inside it", () => {
    const click = events[2];
    expect(describeEvent(click)).toBe('click button "Save (10 ea)"');
    expect(isNotable(events[events.length - 1])).toBe(false); // unchanged snapshot
    expect(isNotable(events[5])).toBe(false); // prefetch
    expect(isNotable(events[12])).toBe(false); // aborted non-action
    expect(isNotable(events[13])).toBe(true); // aborted server action
  });

  test("summary has the header, counts, timeline and screenshot list, and no query contents", () => {
    const md = buildSummary(
      {
        origin: ORIGIN,
        mode: "adb",
        device: "samsung SM-A525F, Android 13",
        browser: "Chrome/126",
        socket: "@chrome_devtools_remote",
        startedAt: iso(0),
        endedAt: iso(61_000),
        endReason: "stopped (Ctrl+C)",
        otherTabsIgnored: 2,
        eventsFile: "events.jsonl",
      },
      events,
    );
    for (const want of [
      "# Phone session",
      "SM-A525F",
      "@chrome_devtools_remote",
      "1m 1s",
      "Other tabs ignored | 2",
      "## Counts",
      "## Timeline",
      "## Screenshots",
      "shots/001-count-4.jpg",
      "| /count/4 |",
    ]) {
      expect(md).toContain(want);
    }
    expect(md).toContain("server action");
    expect(md).toContain("(+query 11 chars)");
    expect(md).not.toContain(TOKEN);
  });

  test("headline counts mention errors, actions, rsc and screenshots", () => {
    const h = headlineCounts(events).join("\n");
    expect(h).toMatch(/errors: 1 page, 1 console/);
    expect(h).toMatch(/server actions: 3 \(2 failed, 1 slow/);
    expect(h).toMatch(/rsc: 1 navigation, 1 prefetch/);
    expect(h).toMatch(/screenshots: 1/);
  });

  test("the timeline is capped and keeps errors, failures, actions, navs and clicks over repetitive snapshots", () => {
    const many: ReturnType<typeof ev>[] = [];
    for (let i = 0; i < 400; i++) many.push(ev(i * 10, { kind: "snapshot", path: "/count", unchanged: true }));
    many.push(ev(1, { kind: "pageerror", message: "keep me" }));
    many.push(ev(2, { kind: "action", method: "POST", path: "/a", status: 500, durationMs: 9 }));
    many.push(ev(3, { kind: "nav", path: "/n" }));
    many.push(ev(4, { kind: "interaction", type: "click", target: { tag: "button", text: "Go" } }));
    const sorted = many.slice().sort((a, b) => a.t - b.t);
    const { rows: rawRows, omitted } = selectTimeline(sorted, 200);
    const rows = rawRows as Array<{ kind: string; t: number }>;
    expect(rows).toHaveLength(200);
    expect(omitted).toBe(204);
    const kinds = new Set(rows.map((r) => r.kind));
    for (const k of ["pageerror", "action", "nav", "interaction"]) expect(kinds.has(k)).toBe(true);
    // Chronological order is restored after ranking.
    expect(rows.map((r) => r.t)).toEqual(rows.map((r) => r.t).slice().sort((a, b) => a - b));
  });
});

describe("screenshot names", () => {
  test("zero-padded and slugged from the path only", () => {
    expect(shotName(1, "/count/4")).toBe("001-count-4.jpg");
    expect(shotName(42, "/")).toBe("042-home.jpg");
    expect(slugForPath("/a/b c/ü?x=1")).not.toMatch(/[^a-z0-9-]/);
    expect(slugForPath("/".padEnd(200, "a")).length).toBeLessThanOrEqual(40);
  });
});

describe("screenshots are raw pixels", () => {
  test("skipped while a password-like field has focus", () => {
    expect(screenshotSkipReason({ activeElement: { secret: true }, url: `${ORIGIN}/login` }, ORIGIN)).toBe("secret-field");
    // The sanitizer turns a focused password input into exactly {secret:true}, so the two compose.
    const snap = sanitizeSnapshot({ bodyText: "Sign in", activeElement: { tag: "input", type: "password" }, disabledButtons: 0 });
    expect(screenshotSkipReason({ activeElement: (snap as Record<string, unknown>).activeElement as { secret?: boolean }, url: `${ORIGIN}/login` }, ORIGIN)).toBe("secret-field");
  });

  test("taken for an ordinary field or no focus", () => {
    expect(screenshotSkipReason({ activeElement: { tag: "input", inputType: "text", name: "qty" }, url: `${ORIGIN}/count` }, ORIGIN)).toBeNull();
    expect(screenshotSkipReason({ activeElement: undefined, url: `${ORIGIN}/count?x=1#y` }, ORIGIN)).toBeNull();
  });

  test("skipped the moment the tab is no longer on exactly the observed origin", () => {
    for (const url of ["https://bank.example/", "https://192.168.12.33:3444/", "http://192.168.12.33:3443/", "about:blank", "", "chrome://newtab/"]) {
      expect(screenshotSkipReason({ activeElement: undefined, url }, ORIGIN)).toBe("origin-changed");
    }
    // origin-changed wins over secret-field: nothing about a foreign page is worth a second reason.
    expect(screenshotSkipReason({ activeElement: { secret: true }, url: "https://bank.example/" }, ORIGIN)).toBe("origin-changed");
  });

  test("a skip event is described without any value", () => {
    expect(describeEvent({ kind: "screenshot-skipped", reason: "secret-field", path: "/login" })).toBe("screenshot skipped (secret-field) /login");
    expect(isNotable({ kind: "screenshot-skipped", reason: "origin-changed" })).toBe(true);
  });

  test("summary footer says screenshots can show typed text and that the folder is gitignored", () => {
    const md = buildSummary({ origin: ORIGIN, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:05.000Z" }, []);
    expect(md).toContain("Screenshots are raw pixels");
    expect(md).toContain("CAN show on-screen typed text");
    expect(md).toContain("gitignored");
    // The old blanket claim must not come back: "typed values" is only promised for the LOG.
    expect(md).toContain("Never recorded in the log:");
    expect(md).not.toMatch(/Never recorded: /);
  });
});

describe("--out must not point inside the repo except under .phone-sessions", () => {
  const REPO = "/work/truestock";

  test("the default location and anything under it is allowed", () => {
    expect(checkOutDir(`${REPO}/.phone-sessions`, REPO)).toEqual({ ok: true });
    expect(checkOutDir(`${REPO}/.phone-sessions/run-2`, REPO)).toEqual({ ok: true });
  });

  test("any other path inside the repo is refused, with a message naming the fix", () => {
    for (const out of [REPO, `${REPO}/docs`, `${REPO}/tests/out`, `${REPO}/app`, `${REPO}/.phone-sessions-old`, `${REPO}/x/../docs`]) {
      const r = checkOutDir(out, REPO);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(".phone-sessions");
    }
  });

  test("a '..' escape from .phone-sessions back into the repo is refused", () => {
    expect(checkOutDir(`${REPO}/.phone-sessions/../src`, REPO).ok).toBe(false);
  });

  test("paths outside the repo remain allowed, including look-alike sibling names", () => {
    for (const out of ["/tmp/sessions", "/Users/moni/phone-logs", `${REPO}-sessions`, "/work", `${REPO}/../elsewhere`]) {
      expect(checkOutDir(out, REPO)).toEqual({ ok: true });
    }
  });
});
