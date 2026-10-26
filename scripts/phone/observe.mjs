#!/usr/bin/env node
/**
 * Read-only observer for a real-phone test session.
 *
 * The phone is attached to this Mac over adb (USB or Wireless debugging); this
 * script attaches to the phone browser over the Chrome DevTools protocol and,
 * while a human tests normally, writes a compact, privacy-safe session log and
 * a few screenshots to disk. An AI then reads text instead of a 100 MB video.
 *
 *   node scripts/phone/observe.mjs --origin https://192.168.12.33:3443
 *   node scripts/phone/observe.mjs --origin http://127.0.0.1:3000 --cdp http://127.0.0.1:9333
 *
 * Options:
 *   --origin URL      REQUIRED (or env PHONE_APP_ORIGIN). Only tabs on exactly this
 *                     origin are ever observed; every other tab is ignored.
 *   --out DIR         session root (default <repo>/.phone-sessions)
 *   --serial ID       adb device serial (or env ANDROID_SERIAL) when several are attached
 *   --socket NAME     DevTools socket to forward (default chrome_devtools_remote)
 *   --adb PATH        adb binary (default: `adb` on PATH, else the Android SDK copy)
 *   --cdp URL         skip adb; attach to an already-reachable DevTools endpoint
 *   --port N          local port for `adb forward` (default: a free one)
 *   --max-shots N     screenshot cap (default 150)
 *
 * STRICTLY READ-ONLY toward the browser: it never navigates, clicks, types,
 * reloads or emulates anything. It listens, evaluates tiny read-only snippets,
 * and takes screenshots. Never recorded: request/response bodies, cookies,
 * authorization or any header beyond a named few, typed values, password
 * fields, query strings, other tabs. The rules live in lib/observe-core.mjs and
 * are covered by tests/phone-observe-core.test.ts.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { chromium } from "playwright";
import * as core from "./lib/observe-core.mjs";
import { installAgent } from "./lib/page-agent.mjs";

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const USAGE = `Usage:
  node scripts/phone/observe.mjs --origin https://192.168.12.33:3443 [options]
  bun run phone:observe -- --origin https://192.168.12.33:3443

  --origin URL     the app's origin as the phone sees it (REQUIRED; or env PHONE_APP_ORIGIN)
  --out DIR        where sessions are written (default: ${path.join(REPO_ROOT, ".phone-sessions")})
  --serial ID      adb device serial, when more than one device is attached (or env ANDROID_SERIAL)
  --socket NAME    DevTools socket to use (default chrome_devtools_remote)
  --adb PATH       adb binary (default: adb on PATH, else ~/Library/Android/sdk/platform-tools/adb)
  --cdp URL        skip adb and attach to a DevTools endpoint, e.g. http://127.0.0.1:9333
  --port N         local port for adb forward (default: a free one)
  --max-shots N    screenshot cap (default 150)`;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Arguments

let args;
try {
  args = parseArgs({
    options: {
      origin: { type: "string" },
      out: { type: "string" },
      serial: { type: "string" },
      socket: { type: "string" },
      adb: { type: "string" },
      cdp: { type: "string" },
      port: { type: "string" },
      "max-shots": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  }).values;
} catch (e) {
  die(`${e.message}\n\n${USAGE}`, 2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const originInput = args.origin ?? process.env.PHONE_APP_ORIGIN;
if (!originInput) {
  die(`Missing --origin: say which site on the phone to observe.\n\n${USAGE}`, 2);
}
let ORIGIN;
try {
  ORIGIN = core.normalizeOrigin(originInput);
} catch (e) {
  die(`${e.message}\n\n${USAGE}`, 2);
}
const MAX_SHOTS = args["max-shots"] ? Number.parseInt(args["max-shots"], 10) : 150;
if (!Number.isFinite(MAX_SHOTS) || MAX_SHOTS < 0) die("--max-shots must be a non-negative integer", 2);
const OUT_ROOT = path.resolve(args.out ?? path.join(REPO_ROOT, ".phone-sessions"));

/**
 * realpath of the deepest existing ancestor plus the not-yet-created tail, so a
 * symlink cannot smuggle a path into (or out of) the repo past the check below.
 */
function realpathLoose(p) {
  const tail = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

{
  // Inside the repo, sessions may only go under .phone-sessions/ (gitignored).
  const outCheck = core.checkOutDir(realpathLoose(OUT_ROOT), realpathLoose(REPO_ROOT));
  if (!outCheck.ok) die(outCheck.error, 2);
}

// ---------------------------------------------------------------------------
// adb

async function findAdb() {
  if (args.adb) {
    if (!fs.existsSync(args.adb)) die(`--adb ${args.adb} does not exist.`);
    return args.adb;
  }
  try {
    await execFileP("adb", ["version"], { timeout: 8000 });
    return "adb";
  } catch {
    /* not on PATH */
  }
  const sdk = path.join(os.homedir(), "Library", "Android", "sdk", "platform-tools", "adb");
  if (fs.existsSync(sdk)) return sdk;
  die(
    "adb not found. Install it (brew install --cask android-platform-tools), put it on PATH,\n" +
      "or pass --adb /path/to/adb. Or use --cdp URL to skip adb.",
  );
}

let ADB = null;
let SERIAL = null;
let forwardedPort = null;

async function adb(adbArgs, opts = {}) {
  const full = SERIAL ? ["-s", SERIAL, ...adbArgs] : adbArgs;
  const { stdout } = await execFileP(ADB, full, { timeout: opts.timeout ?? 15000, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

function removeForwardSync() {
  if (forwardedPort === null) return;
  try {
    const full = SERIAL ? ["-s", SERIAL, "forward", "--remove", `tcp:${forwardedPort}`] : ["forward", "--remove", `tcp:${forwardedPort}`];
    execFileSync(ADB, full, { timeout: 5000, stdio: "ignore" });
  } catch {
    /* already gone */
  }
  forwardedPort = null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Resolve device, socket and the forwarded local DevTools endpoint. */
async function setupAdb() {
  ADB = await findAdb();
  let listing;
  try {
    listing = (await execFileP(ADB, ["devices", "-l"], { timeout: 20000 })).stdout;
  } catch (e) {
    die(`\`adb devices -l\` failed: ${e.message}`);
  }
  const devices = core.parseAdbDevices(listing);
  const picked = core.pickDevice(devices, args.serial ?? process.env.ANDROID_SERIAL);
  if (picked.error) die(picked.error);
  SERIAL = picked.device.serial;

  let model = picked.device.model ?? "";
  try {
    const m = (await adb(["shell", "getprop", "ro.product.model"])).trim();
    const mf = (await adb(["shell", "getprop", "ro.product.manufacturer"])).trim();
    const rel = (await adb(["shell", "getprop", "ro.build.version.release"])).trim();
    model = `${[mf, m].filter(Boolean).join(" ")}${rel ? `, Android ${rel}` : ""}` || model;
  } catch {
    /* model is cosmetic */
  }

  let unixText;
  try {
    unixText = await adb(["shell", "cat", "/proc/net/unix"]);
  } catch (e) {
    die(`Could not read /proc/net/unix on the phone: ${e.message}`);
  }
  const sockets = core.parseDevtoolsSockets(unixText);
  console.log(`DevTools sockets on the phone: ${sockets.length ? sockets.map((s) => `@${s}`).join(", ") : "(none)"}`);
  const sock = core.pickSocket(sockets, args.socket);
  if (sock.error) die(sock.error);
  if (sock.others.length) {
    console.log(`Using @${sock.socket}. Other sockets: ${sock.others.map((s) => `@${s}`).join(", ")} — choose with --socket NAME.`);
  }

  const port = args.port ? Number.parseInt(args.port, 10) : await freePort();
  try {
    // --no-rebind: never replace a forward somebody else made on this port (our
    // exit cleanup would then remove THEIR forward). forwardedPort is only set
    // once this call succeeds, so cleanup only ever removes what this run made.
    await adb(["forward", "--no-rebind", `tcp:${port}`, `localabstract:${sock.socket}`]);
  } catch (e) {
    const detail = `${e.stderr ?? ""}${e.message}`;
    if (/already in use|cannot (re)?bind|address.*in use/i.test(detail)) {
      die(`Local port ${port} is already forwarded or in use (${detail.trim().split("\n")[0].replace(/^adb:\s*/i, "adb said: ")}).\nPick another --port, or omit --port to use a free one.`, 2);
    }
    die(`adb forward failed: ${detail.trim()}`);
  }
  forwardedPort = port;
  return { endpoint: `http://127.0.0.1:${port}`, device: `${model} (${SERIAL})`, socket: `@${sock.socket}` };
}

// ---------------------------------------------------------------------------
// Session state

const startedAt = new Date();
const sessionDir = path.join(OUT_ROOT, `session-${core.sessionStamp(startedAt)}`);
const shotsDir = path.join(sessionDir, "shots");
const eventsPath = path.join(sessionDir, "events.jsonl");
const events = [];
let shotCount = 0;
let finishing = false;
let browser = null;
let heartbeat = null;
const meta = {
  origin: ORIGIN,
  mode: args.cdp ? `cdp (${args.cdp})` : "adb",
  device: undefined,
  browser: undefined,
  socket: undefined,
  startedAt: startedAt.toISOString(),
  endedAt: undefined,
  endReason: undefined,
  otherTabsIgnored: 0,
  eventsFile: "events.jsonl",
};

const now = () => Date.now() - startedAt.getTime();

function emit(ev, atMs) {
  const t = atMs ?? now();
  const full = { t, iso: new Date(startedAt.getTime() + t).toISOString(), ...ev };
  events.push(full);
  try {
    fs.appendFileSync(eventsPath, JSON.stringify(full) + "\n");
  } catch {
    /* disk problems must not take down the observer */
  }
  if (core.isNotable(full)) console.log(`${core.clock(full.iso)} ${core.describeEvent(full)}`);
  return full;
}

// ---------------------------------------------------------------------------
// Per-page observation

const AGENT_GLOBAL = `__ts_${Math.random().toString(36).slice(2, 10)}`;
const AGENT_BINDING = `__tsb_${Math.random().toString(36).slice(2, 10)}`;
const AGENT_CFG = { binding: AGENT_BINDING, global: AGENT_GLOBAL, origin: ORIGIN };

/** Every page the browser has shown us -> its state. */
const pages = new Map();
let nextPageId = 0;
let maxOtherTabs = 0;

function recountOthers() {
  let other = 0;
  for (const st of pages.values()) if (!st.active && !st.closed) other++;
  maxOtherTabs = Math.max(maxOtherTabs, other);
  meta.otherTabsIgnored = maxOtherTabs;
}

function track(page) {
  if (pages.has(page)) return;
  const st = { page, id: -1, active: false, attachedOnce: false, closed: false, snapTimer: null, lastHash: null, snapBusy: false, reqs: new WeakMap() };
  pages.set(page, st);
  // The only thing registered on a tab we have not (yet) decided to observe:
  // a main-frame navigation watcher that compares its origin. Nothing is read,
  // logged or evaluated until the origin matches exactly.
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) reevaluate(st);
  });
  page.on("close", () => {
    const wasActive = st.active;
    st.active = false;
    st.closed = true;
    clearTimeout(st.snapTimer);
    if (wasActive) emit({ kind: "tab", action: "closed", pageId: st.id });
    recountOthers();
  });
  reevaluate(st, true);
}

function reevaluate(st, initial = false) {
  let url = "";
  try {
    url = st.page.url();
  } catch {
    return;
  }
  const on = core.isSameOrigin(url, ORIGIN);
  if (on && !st.active) activate(st, initial);
  else if (!on && st.active) {
    st.active = false;
    clearTimeout(st.snapTimer);
    // No URL, no title: just the fact that the tab left the observed origin.
    emit({ kind: "tab", action: "left-origin", pageId: st.id });
  }
  recountOthers();
}

function activate(st, initial) {
  const { page } = st;
  const firstTime = !st.attachedOnce;
  st.active = true;
  if (firstTime) {
    st.attachedOnce = true;
    st.id = nextPageId++;
    wirePage(st);
  }
  emit({ kind: "tab", action: firstTime ? (initial ? "attached" : "opened") : "returned", pageId: st.id });
  // Install in the current document too (addInitScript only covers FUTURE ones).
  page.evaluate(installAgent, AGENT_CFG).catch(() => {});
  recordNav(st, "attach");
}

function wirePage(st) {
  const { page } = st;
  const ev = (e, atMs) => emit({ pageId: st.id, ...e }, atMs);

  // Interactions come back through a binding. Anything not from the top frame
  // of an on-origin tab is dropped, then the payload is whitelisted in core.
  page
    .exposeBinding(AGENT_BINDING, (source, payload) => {
      if (!st.active || source.page !== page || source.frame !== page.mainFrame()) return;
      if (!core.isSameOrigin(source.frame.url(), ORIGIN)) return;
      const fields = core.sanitizeInteraction(payload);
      if (!fields) return;
      ev({ kind: "interaction", ...fields });
      if (fields.type === "visibilitychange" && fields.state === "hidden") return;
      if (fields.type === "connectivity" || fields.type === "visibilitychange") return scheduleSnapshot(st, fields.type, 700);
      scheduleSnapshot(st, "interaction", 500);
    })
    .catch(() => {});
  page.addInitScript(installAgent, AGENT_CFG).catch(() => {});

  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame() || !st.active) return;
    recordNav(st, "navigate");
  });

  page.on("console", (msg) => {
    if (!st.active) return;
    const type = msg.type();
    if (["clear", "startGroup", "startGroupCollapsed", "endGroup", "profile", "profileEnd"].includes(type)) return;
    let src;
    try {
      const loc = msg.location();
      if (loc?.url) {
        const host = core.isSameOrigin(loc.url, ORIGIN) ? "" : (core.hostOf(loc.url) ?? "");
        src = `${host}${core.pathOf(loc.url)}:${loc.lineNumber ?? 0}`;
      }
    } catch {
      /* no location */
    }
    ev({ kind: "console", level: type === "warning" ? "warning" : type, text: core.safeText(msg.text(), 500), src });
  });

  page.on("pageerror", (err) => {
    if (!st.active) return;
    const stack = String(err?.stack ?? "").split("\n").map((l) => l.trim());
    const frame = stack.find((l) => l.startsWith("at "));
    ev({
      kind: "pageerror",
      name: err?.name,
      message: core.safeText(err?.message ?? String(err), 500),
      frame: frame ? core.safeText(frame, 200) : undefined,
    });
  });

  page.on("request", (req) => {
    if (!st.active) return;
    let frameUrl = "";
    try {
      frameUrl = req.frame().url();
    } catch {
      /* detached frame */
    }
    const scope = core.classifyRequestScope({ requestUrl: req.url(), frameUrl, isNavigation: req.isNavigationRequest() }, ORIGIN);
    if (scope === "ignore") return;
    st.reqs.set(req, { t0: Date.now(), scope });
  });

  page.on("requestfinished", async (req) => {
    const m = st.reqs.get(req);
    if (!m || !st.active) return;
    const atMs = now();
    let res;
    try {
      res = await req.response();
    } catch {
      return;
    }
    if (!res) return;
    const durationMs = Date.now() - m.t0;
    const status = res.status();
    if (m.scope === "same") {
      const body = core.buildRequestEvent({
        method: req.method(),
        url: req.url(),
        headers: req.headers(),
        status,
        responseHeaders: res.headers(),
        durationMs,
      });
      if (body) ev(body, atMs);
    } else if (status >= 400) {
      ev({ kind: "http-error", method: req.method(), path: core.pathOf(req.url()), xorigin: core.hostOf(req.url()), status, durationMs }, atMs);
    }
  });

  page.on("requestfailed", (req) => {
    const m = st.reqs.get(req);
    if (!m || !st.active) return;
    const errorText = req.failure()?.errorText ?? "failed";
    const cls = m.scope === "same" ? core.classifyNextRequest(req.headers()) : null;
    ev({
      kind: "requestfailed",
      method: req.method(),
      path: core.pathOf(req.url()),
      xorigin: m.scope === "cross" ? core.hostOf(req.url()) : undefined,
      errorText,
      aborted: /ERR_ABORTED/i.test(errorText) ? true : undefined,
      next: cls?.kind,
      prefetch: cls?.kind === "rsc" ? cls.prefetch : undefined,
      durationMs: Date.now() - m.t0,
    });
  });
}

/** Read-only evaluate that survives a navigation tearing the context down. */
async function safeEval(page, fn, arg) {
  for (let i = 0; i < 2; i++) {
    try {
      return await page.evaluate(fn, arg);
    } catch (e) {
      if (i === 1 || !/context|navigat|detached/i.test(String(e.message))) return undefined;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return undefined;
}

async function recordNav(st, navType) {
  const { page } = st;
  const at = now();
  let url = "";
  try {
    url = page.url();
  } catch {
    return;
  }
  const red = core.redactUrl(url);
  await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
  if (!st.active) return;
  await safeEval(page, installAgent, AGENT_CFG);
  const info = await safeEval(page, (g) => window[g]?.info?.(), AGENT_GLOBAL);
  emit(
    {
      kind: "nav",
      pageId: st.id,
      navType,
      path: red.path,
      ...(red.query ? { query: true, queryLen: red.queryLen } : {}),
      title: info?.title ? core.safeText(info.title, 120) : undefined,
      viewport: info?.viewport,
      dpr: info?.dpr,
      online: info?.online,
    },
    at,
  );
  scheduleSnapshot(st, "nav", 700, true);
}

function scheduleSnapshot(st, reason, delay, force = false) {
  if (!st.active) return;
  clearTimeout(st.snapTimer);
  st.snapTimer = setTimeout(() => takeSnapshot(st, reason, force).catch(() => {}), delay);
}

async function takeSnapshot(st, reason, force = false) {
  const { page } = st;
  if (!st.active || st.snapBusy || finishing && reason !== "final") return;
  st.snapBusy = true;
  try {
    const url = page.url();
    if (!core.isSameOrigin(url, ORIGIN)) return; // re-checked at the moment of reading
    const raw = await safeEval(page, (g) => window[g]?.snapshot?.(), AGENT_GLOBAL);
    const snap = core.sanitizeSnapshot(raw);
    if (!snap) return;
    const p = core.pathOf(url);
    const hash = core.hashString(`${p}|${snap.bodyText}|${JSON.stringify(snap.activeElement ?? null)}|${snap.disabledButtons}`);
    if (!force && hash === st.lastHash) {
      emit({ kind: "snapshot", pageId: st.id, reason, path: p, unchanged: true });
      return;
    }
    st.lastHash = hash;
    let shot;
    let shotError;
    if (shotCount < MAX_SHOTS) {
      // A screenshot is raw pixels, so it is the one capture the log whitelists
      // cannot protect: refuse it while a password field has focus, and refuse
      // it unless the tab is STILL on the exact origin at the moment of capture
      // (the check above ran before safeEval and its retry delay).
      const skipNow = () => core.screenshotSkipReason({ activeElement: snap.activeElement, url: page.url() }, ORIGIN);
      let skip = skipNow();
      if (!skip) {
        try {
          // No scrolling, no focus change, no caret/animation tweaks: a plain capture.
          const buf = await page.screenshot({ type: "jpeg", quality: 55, scale: "css", caret: "initial", animations: "allow", timeout: 6000 });
          // The page may have navigated while the capture ran: keep nothing from another origin.
          skip = skipNow();
          if (!skip) {
            shotCount++;
            const name = core.shotName(shotCount, p);
            fs.mkdirSync(shotsDir, { recursive: true });
            fs.writeFileSync(path.join(shotsDir, name), buf);
            shot = `shots/${name}`;
          }
        } catch (e) {
          shotError = /timeout/i.test(String(e.message)) ? "timeout" : "failed";
        }
      }
      if (skip) emit({ kind: "screenshot-skipped", pageId: st.id, reason: skip, path: p });
    }
    emit({ kind: "snapshot", pageId: st.id, reason, path: p, ...snap, shot, shotError });
  } finally {
    st.snapBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Finish

async function finish(reason) {
  if (finishing) return;
  finishing = true;
  clearInterval(heartbeat);
  const connected = browser?.isConnected?.() ?? false;
  if (connected) {
    // One last look at every page still on the origin.
    await Promise.race([
      Promise.all([...pages.values()].filter((s) => s.active).map((s) => takeSnapshot(s, "final", true).catch(() => {}))),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  }
  for (const st of pages.values()) clearTimeout(st.snapTimer);
  meta.endedAt = new Date().toISOString();
  meta.endReason = reason;
  emit({ kind: "session", phase: "end", reason });
  const ordered = events.slice().sort((a, b) => a.t - b.t);
  try {
    fs.writeFileSync(path.join(sessionDir, "summary.md"), core.buildSummary(meta, ordered));
  } catch (e) {
    console.error(`Could not write summary.md: ${e.message}`);
  }
  if (connected) {
    // For a CDP-connected browser close() only drops our connection; it does not close the phone's browser.
    await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
  }
  removeForwardSync();
  console.log(`\nSession: ${sessionDir}`);
  console.log(`  ${path.join(sessionDir, "summary.md")}`);
  for (const line of core.headlineCounts(ordered)) console.log(`  ${line}`);
  process.exit(0);
}

process.on("SIGINT", () => {
  if (finishing) process.exit(130);
  console.log("\nStopping — flushing the session…");
  finish("stopped (Ctrl+C)");
});
process.on("SIGTERM", () => finish("terminated"));
process.on("SIGHUP", () => finish("terminal closed"));
process.on("exit", removeForwardSync);
process.on("uncaughtException", (e) => {
  console.error(`observer error: ${e?.stack ?? e}`);
  finish("observer error");
});
process.on("unhandledRejection", (e) => {
  console.error(`observer error: ${e?.stack ?? e}`);
});

// ---------------------------------------------------------------------------
// Main

async function main() {
  let endpoint;
  if (args.cdp) {
    endpoint = args.cdp;
  } else {
    const a = await setupAdb();
    endpoint = a.endpoint;
    meta.device = a.device;
    meta.socket = a.socket;
  }

  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  } catch (e) {
    removeForwardSync();
    die(
      `Could not attach to the browser at ${endpoint}: ${String(e.message).split("\n")[0]}\n` +
        (args.cdp
          ? "Is something listening there? (desktop Chrome: --remote-debugging-port=9333)"
          : "The DevTools socket exists but did not answer. Open the browser on the phone, unlock the screen,\n" +
            "open the site in a tab, and re-run. If you use several browsers, pick one with --socket NAME."),
    );
  }
  meta.browser = browser.version();

  fs.mkdirSync(shotsDir, { recursive: true });
  console.log(`Truestock phone observer`);
  console.log(`  origin   ${ORIGIN}`);
  if (meta.device) console.log(`  device   ${meta.device}`);
  console.log(`  browser  ${meta.browser}${meta.socket ? `  ${meta.socket}` : ""}`);
  console.log(`  session  ${sessionDir}`);
  emit({ kind: "session", phase: "start", origin: ORIGIN, mode: meta.mode, browser: meta.browser, device: meta.device, socket: meta.socket });

  browser.on("disconnected", () => {
    if (finishing) return;
    emit({ kind: "disconnected", reason: "browser connection closed (phone unplugged, browser closed, or adb dropped)" });
    finish("disconnected");
  });

  const watch = (ctx) => {
    for (const p of ctx.pages()) track(p);
    ctx.on("page", (p) => track(p));
  };
  for (const ctx of browser.contexts()) watch(ctx);

  const observed = [...pages.values()].filter((s) => s.active).length;
  const others = pages.size - observed;
  if (observed > 0) {
    console.log(`Observing ${observed} page(s) on ${ORIGIN} — test as normal, Ctrl+C when finished.`);
  } else {
    console.log(`No tab is on ${ORIGIN} yet — open the site in the phone browser; it will be picked up automatically.`);
    console.log(`Observing 0 page(s) on ${ORIGIN} — test as normal, Ctrl+C when finished.`);
  }
  if (others > 0) console.log(`${others} other tab${others === 1 ? "" : "s"} ignored.`);

  if (ADB) {
    heartbeat = setInterval(async () => {
      try {
        const s = (await adb(["get-state"], { timeout: 6000 })).trim();
        if (s !== "device") throw new Error(s);
      } catch {
        if (!finishing) {
          emit({ kind: "disconnected", reason: "adb lost the device" });
          finish("device disconnected");
        }
      }
    }, 10000);
  }
}

main().catch((e) => {
  console.error(`observer failed: ${e?.stack ?? e}`);
  finish("observer error");
});
