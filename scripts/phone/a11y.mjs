#!/usr/bin/env node
/**
 * Accessibility floor check against a REAL phone's Chrome, over CDP (open item #29).
 *
 *   adb forward tcp:9333 localabstract:chrome_devtools_remote
 *   node scripts/phone/a11y.mjs --origin http://localhost:3204
 *   node scripts/phone/a11y.mjs --origin http://localhost:3204 --path /count
 *
 * Non-navigating by default: it checks the screen the human currently has open,
 * so walk to each counting screen by hand and run it once per screen.
 *
 * Checks (same rules as scripts/verify-browser.mjs):
 *   1. every tab stop has a visible focus treatment (outline or ring, on the
 *      element or within two ancestors, that differs from the unfocused state)
 *   2. heading levels do not skip
 *   3. every icon-only button/link has an accessible name
 *   4. WARN: interactive elements under 44x44 CSS px
 *
 * Never types, never clicks. The tab walk uses Tab only, starts from the top of
 * the document, stops if a password field takes focus, and blurs at the end.
 * Exit code 1 on any FAIL.
 *
 * Env: PHONE_CDP (default http://127.0.0.1:9333).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE = `Usage: node scripts/phone/a11y.mjs --origin http://localhost:3204 [--path /count]
  --origin URL  the app origin as the phone sees it (REQUIRED)
  --path P      navigate to this same-origin path first (default: check the open screen)
  env PHONE_CDP CDP endpoint (default http://127.0.0.1:9333)`;

function die(msg) {
  console.error(msg);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    options: { origin: { type: "string" }, path: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: false,
  }).values;
} catch (e) {
  die(`${e.message}\n${USAGE}`);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!args.origin) die(`--origin is required.\n${USAGE}`);
let origin;
try {
  origin = new URL(args.origin).origin;
} catch {
  die(`--origin is not a URL: ${args.origin}`);
}
if (args.path !== undefined && !args.path.startsWith("/")) die("--path must start with / (same origin only).");

const CDP = process.env.PHONE_CDP ?? "http://127.0.0.1:9333";
let browser;
try {
  browser = await chromium.connectOverCDP(CDP);
} catch (e) {
  die(`Could not connect to ${CDP}: ${e.message}\nIs 'adb forward tcp:9333 localabstract:chrome_devtools_remote' running and Chrome open on the phone?`);
}

const pages = browser.contexts().flatMap((c) => c.pages());
const matches = pages.filter((p) => {
  try {
    return new URL(p.url()).origin === origin;
  } catch {
    return false;
  }
});
if (matches.length !== 1) {
  const open = pages.map((p) => new URL(p.url(), "http://x").origin + new URL(p.url(), "http://x").pathname);
  await browser.close().catch(() => {});
  die(
    matches.length === 0
      ? `No open tab on ${origin}. Tabs seen: ${open.join(", ") || "(none)"}`
      : `${matches.length} tabs are on ${origin}; close all but one. Tabs: ${open.join(", ")}`,
  );
}
const page = matches[0];

if (args.path !== undefined) {
  await page.goto(`${origin}${args.path}`, { waitUntil: "networkidle" });
}
const currentPath = new URL(page.url()).pathname;

const results = [];
function record(status, name, detail) {
  results.push({ status, name, detail });
  console.log(`${status} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- snapshot unfocused ring state, then start the walk from the top ----------
const INTERACTIVE =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';

await page.evaluate((sel) => {
  const sig = (n) => {
    const cs = getComputedStyle(n);
    return `${cs.outlineStyle}|${cs.outlineWidth}|${cs.outlineColor}|${cs.boxShadow}`;
  };
  // Blur FIRST, then snapshot. Whatever has focus when the run starts (an
  // autofocused or last-tapped field) would otherwise have its focused ring
  // recorded as its "unfocused" look, and then be reported bare because the
  // two are identical — a false FAIL, seen on the phone's /login 2026-11-10.
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const base = new WeakMap();
  const note = (n) => {
    if (!base.has(n)) base.set(n, sig(n));
  };
  for (const el of document.querySelectorAll(sel)) {
    note(el);
    let p = el.parentElement;
    for (let d = 0; d < 2 && p; d++, p = p.parentElement) note(p);
  }
  window.__a11yBase = base;
  window.__a11ySig = sig;
  // Start from the top: Tab resumes from the active element / selection.
  // Chrome remembers the last-focused element as the sequential-focus starting
  // point even after blur(); focusing <body> itself resets it to the top.
  const had = document.body.getAttribute("tabindex");
  document.body.setAttribute("tabindex", "-1");
  document.body.focus({ preventScroll: true });
  document.body.blur();
  if (had === null) document.body.removeAttribute("tabindex");
  else document.body.setAttribute("tabindex", had);
  getSelection()?.removeAllRanges();
  getSelection()?.collapse(document.body, 0);
  window.scrollTo(0, 0);
}, INTERACTIVE);

// ---- 1. focus visible on every tab stop ---------------------------------------
const MAX_STOPS = 120;
const visited = [];
const bare = [];
const seen = new Set();
let passwordAbort = false;
for (let i = 0; i < MAX_STOPS; i++) {
  await page.keyboard.press("Tab");
  const info = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const base = window.__a11yBase;
    const sig = window.__a11ySig;
    const hasRing = (n) => {
      const cs = getComputedStyle(n);
      const ring =
        (cs.outlineStyle !== "none" && cs.outlineWidth !== "0px") || (cs.boxShadow !== "none" && cs.boxShadow !== "");
      return ring && sig(n) !== (base.get(n) ?? "");
    };
    let visible = hasRing(el);
    let p = el.parentElement;
    for (let d = 0; !visible && d < 2 && p; d++, p = p.parentElement) visible = hasRing(p);
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    const label =
      el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el.textContent ?? "").trim().slice(0, 30) || "";
    return {
      key: `${el.tagName}${id}${cls}|${label}|${Math.round(el.getBoundingClientRect().top + scrollY)}`,
      selector: `${el.tagName.toLowerCase()}${id}${cls}`,
      label,
      password: el.tagName === "INPUT" && el.type === "password",
      visible,
    };
  });
  if (!info) {
    if (visited.length > 0) break; // focus left the document: the walk wrapped
    continue;
  }
  if (info.password) {
    passwordAbort = true;
    break;
  }
  if (seen.has(info.key)) break; // wrapped around
  seen.add(info.key);
  visited.push(info);
  if (!info.visible) bare.push(`${info.selector} "${info.label}"`);
}
await page.evaluate(() => {
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
});

if (passwordAbort) {
  record("WARN", "focus walk stopped", `a password field took focus after ${visited.length} stops; stopped without touching it, rest of the screen unchecked`);
}
if (visited.length === 0) {
  if (!passwordAbort) record("WARN", "focus visible", "no tab stops reached (is a hardware-keyboard Tab reaching this page?)");
} else if (bare.length > 0) {
  record("FAIL", "focus visible", `${bare.length}/${visited.length} tab stops bare: ${bare.join(" | ")}`);
} else {
  record("PASS", "focus visible", `checked ${visited.length} tab stops, none bare`);
}

// ---- 2/3/4: static DOM checks ---------------------------------------------------
const dom = await page.evaluate((sel) => {
  const levels = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => Number(h.tagName[1]));
  const unnamed = Array.from(document.querySelectorAll('button, a[href], [role="button"], [role="link"]'))
    .filter((el) => {
      const text = (el.textContent ?? "").trim();
      const hasIcon = el.querySelector("svg") !== null;
      const named =
        el.hasAttribute("aria-label") ||
        el.hasAttribute("aria-labelledby") ||
        el.hasAttribute("title") ||
        el.querySelector("img[alt]:not([alt=''])") !== null;
      return text === "" && hasIcon && !named;
    })
    .map((el) => el.outerHTML.slice(0, 140));
  const small = Array.from(document.querySelectorAll(sel))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || el.disabled) return false;
      if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio") && el.labels?.length) return false;
      return r.width < 44 || r.height < 44;
    })
    .map((el) => {
      const r = el.getBoundingClientRect();
      const label = el.getAttribute("aria-label") || (el.textContent ?? "").trim().slice(0, 24) || el.getAttribute("placeholder") || "";
      return `${el.tagName.toLowerCase()} "${label}" ${Math.round(r.width)}x${Math.round(r.height)}`;
    });
  return { levels, unnamed, small };
}, INTERACTIVE);

let skip = false;
for (let i = 1; i < dom.levels.length; i++) if (dom.levels[i] - dom.levels[i - 1] > 1) skip = true;
record(skip ? "FAIL" : "PASS", "no heading-level skips", `levels=[${dom.levels.join(",")}]`);
record(
  dom.unnamed.length === 0 ? "PASS" : "FAIL",
  "every icon-only control has an accessible name",
  dom.unnamed.join(" | ") || "none found",
);
record(
  dom.small.length === 0 ? "PASS" : "WARN",
  "tap targets at least 44x44 CSS px",
  dom.small.length === 0 ? "none under" : `${dom.small.length} under: ${dom.small.slice(0, 15).join(" | ")}`,
);

// ---- screenshot + summary -----------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const slug = currentPath.replace(/^\/|\/$/g, "").replace(/[^a-zA-Z0-9]+/g, "-") || "root";
const shotDir = path.join(REPO_ROOT, ".phone-sessions");
fs.mkdirSync(shotDir, { recursive: true });
const shot = path.join(shotDir, `a11y-${stamp}-${slug}.png`);
try {
  await page.screenshot({ path: shot });
} catch (e) {
  record("WARN", "screenshot", e.message.split("\n")[0]);
}

const failed = results.some((r) => r.status === "FAIL");
console.log(
  JSON.stringify({
    path: currentPath,
    origin,
    tabStops: visited.length,
    ok: !failed,
    screenshot: fs.existsSync(shot) ? shot : null,
    results,
  }),
);
await browser.close().catch(() => {}); // disconnects only; the phone's Chrome stays open
process.exit(failed ? 1 : 0);
