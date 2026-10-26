/**
 * Pure logic for scripts/phone/observe.mjs — no browser, no adb, no filesystem.
 *
 * Everything that decides what may be RECORDED lives here so it can be unit
 * tested (tests/phone-observe-core.test.ts) without a phone. The observer is a
 * privacy tool first: the phone browser has other tabs (email, banking), and the
 * app has password fields and URLs that can carry tokens. So the rules are
 * enforced here as WHITELISTS — a field is dropped unless this file names it —
 * and again in the page-side agent. A bug in the page agent must not be able to
 * leak a value, because nothing it sends is copied through unfiltered.
 */
import nodePath from "node:path"; // string maths only — this module touches no files

// ---------------------------------------------------------------------------
// Small text helpers

/** Collapse all whitespace runs to a single space and trim. */
export function collapse(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** Collapse whitespace, then cut to `max` chars (adds an ellipsis when cut). */
export function trimText(s, max) {
  const c = collapse(s);
  if (c.length <= max) return c;
  return c.slice(0, Math.max(0, max - 1)) + "…";
}

// ---------------------------------------------------------------------------
// Origins and URLs

/**
 * Normalise a user-supplied --origin. Throws a readable Error when it is not an
 * http(s) origin. A trailing path/query is ignored — only `URL.origin` is kept —
 * so `https://192.168.12.33:3443/count?x=1` and `https://192.168.12.33:3443`
 * mean the same thing.
 */
export function normalizeOrigin(input) {
  let u;
  try {
    u = new URL(String(input ?? "").trim());
  } catch {
    throw new Error(`--origin must be a full URL like https://192.168.12.33:3443 (got "${input}")`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`--origin must be http or https (got "${u.protocol}")`);
  }
  return u.origin;
}

/**
 * True only when `url` parses and its origin EXACTLY equals `origin`.
 * `about:blank`, `chrome://…`, `data:` and anything unparsable have an opaque or
 * different origin and are rejected. Same host on a different port is a
 * different origin. This is the single gate every page/request passes.
 */
export function isSameOrigin(url, origin) {
  if (typeof url !== "string" || typeof origin !== "string") return false;
  let a;
  let b;
  try {
    a = new URL(url);
    b = new URL(origin);
  } catch {
    return false;
  }
  if (a.protocol !== "http:" && a.protocol !== "https:") return false;
  return a.origin === b.origin;
}

/**
 * Reduce a URL to what may be logged: path only. A query string is NEVER kept —
 * only that one existed and how long it was. The fragment is dropped too
 * (OAuth-style tokens live there). Relative/garbage input yields a best-effort
 * path with the same stripping.
 */
export function redactUrl(url, { maxPath = 200 } = {}) {
  const raw = String(url ?? "");
  let path;
  let hasQuery = false;
  let queryLen = 0;
  let hasHash = false;
  try {
    const u = new URL(raw, "http://placeholder.invalid");
    path = u.pathname;
    hasQuery = u.search.length > 1;
    queryLen = hasQuery ? u.search.length - 1 : 0;
    hasHash = u.hash.length > 1;
  } catch {
    const noHash = raw.split("#")[0];
    const [p, q = ""] = noHash.split("?");
    path = p;
    hasQuery = q.length > 0;
    queryLen = q.length;
    hasHash = raw.includes("#");
  }
  const out = { path: path.length > maxPath ? path.slice(0, maxPath) + "…" : path };
  if (hasQuery) {
    out.query = true;
    out.queryLen = queryLen;
  }
  if (hasHash) out.hash = true;
  return out;
}

/** Just the path of a URL (no query, no hash). */
export function pathOf(url) {
  return redactUrl(url).path;
}

/** Hostname of a URL, or null. Used for cross-origin requests (host only). */
export function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return null;
  }
}

/**
 * Strip query strings and fragments out of free text (console messages, stack
 * frames). Any `http(s)://…?query` or `…#frag` keeps its path but loses what
 * follows. Also scrubs bare `?key=value` runs, glued to a path or floating.
 */
export function scrubUrls(text) {
  return String(text ?? "")
    .replace(/(https?:\/\/[^\s"'<>?#)\]]*)[?#][^\s"'<>)\]]*/gi, "$1?[redacted]")
    .replace(/(\/[\w.\-~%/]+)\?[^\s"'<>)\]]+/g, "$1?[redacted]")
    // A query/fragment run floating in prose ("rejected ?token=abc", "#access_token=abc"),
    // which no URL pattern above anchors to. Only key=value runs, so a plain
    // question mark or a #1 is left alone.
    .replace(/[?#&][\w\-.%[\]]+=[^\s"'<>)\]]*/g, "?[redacted]");
}

/** scrubUrls + collapse + truncate. */
export function safeText(text, max = 500) {
  return trimText(scrubUrls(text), max);
}

/**
 * Where a network request sits relative to the observed origin.
 *   'same'   — the request URL is on the origin: record in full (path only).
 *   'cross'  — a subresource the app's own page asked for on another origin
 *              (CDN, analytics): record failures with host + path.
 *   'ignore' — anything else, notably a NAVIGATION to another origin and any
 *              request made by a frame that is not on the origin. This is what
 *              keeps a tab that leaves for another site from being logged.
 */
export function classifyRequestScope({ requestUrl, frameUrl, isNavigation }, origin) {
  if (isSameOrigin(requestUrl, origin)) return "same";
  if (isNavigation) return "ignore";
  if (isSameOrigin(frameUrl, origin)) return "cross";
  return "ignore";
}

// ---------------------------------------------------------------------------
// adb parsing

/**
 * Parse `adb devices -l`. Returns [{ serial, state, model, product, device,
 * transportId, usb }]. State is the raw word: device | unauthorized | offline |
 * no permissions | … Handles wireless serials (`192.168.1.9:41234`,
 * `adb-XXXX._adb-tls-connect._tcp`) and the "* daemon started" noise.
 */
export function parseAdbDevices(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("*") || /^List of devices/i.test(t)) continue;
    // serial <ws> state [<ws> key:value ...]   (state may be "no permissions (...)")
    const m = t.match(/^(\S+)\s+(device|unauthorized|offline|recovery|sideload|bootloader|authorizing|connecting|no permissions)\b(.*)$/i);
    if (!m) continue;
    const dev = { serial: m[1], state: m[2].toLowerCase() };
    for (const kv of m[3].matchAll(/(\w+):(\S+)/g)) {
      const k = kv[1];
      if (k === "model") dev.model = kv[2];
      else if (k === "product") dev.product = kv[2];
      else if (k === "device") dev.device = kv[2];
      else if (k === "transport_id") dev.transportId = kv[2];
      else if (k === "usb") dev.usb = kv[2];
    }
    out.push(dev);
  }
  return out;
}

/**
 * Decide which attached device to use. Returns { device } or { error } where
 * error is an actionable multi-line message. `wanted` is --serial /
 * ANDROID_SERIAL.
 */
export function pickDevice(devices, wanted) {
  if (wanted) {
    const d = devices.find((x) => x.serial === wanted);
    if (!d) {
      return {
        error:
          `Device "${wanted}" is not attached.` +
          (devices.length ? `\nAttached: ${devices.map(describeDevice).join(", ")}` : "\nNo devices are attached.") +
          `\n${CONNECT_HELP}`,
      };
    }
    return checkDeviceState(d);
  }
  if (devices.length === 0) return { error: `No Android device found by adb.\n${CONNECT_HELP}` };
  if (devices.length > 1) {
    return {
      error:
        `More than one device is attached — say which one:\n` +
        devices.map((d) => `  ${describeDevice(d)}`).join("\n") +
        `\nRe-run with --serial <serial> (or set ANDROID_SERIAL).`,
    };
  }
  return checkDeviceState(devices[0]);
}

export const CONNECT_HELP =
  "Connect the phone with a USB cable (Developer options -> USB debugging on) and accept\n" +
  "the 'Allow USB debugging' prompt, or use Wireless debugging:\n" +
  "  adb pair <ip:pairing-port>   # enter the 6-digit code shown on the phone\n" +
  "  adb connect <ip:port>        # the port on the main Wireless debugging screen\n" +
  "Then check `adb devices -l` shows the phone as `device`.";

export function describeDevice(d) {
  return `${d.serial} (${d.state}${d.model ? `, ${d.model}` : ""})`;
}

function checkDeviceState(d) {
  switch (d.state) {
    case "device":
      return { device: d };
    case "unauthorized":
      return {
        error:
          `Device ${d.serial} is "unauthorized". Unlock the phone and accept the\n` +
          `'Allow USB debugging?' RSA prompt (tick "Always allow from this computer"), then re-run.\n` +
          `If no prompt appears: unplug/replug, or Developer options -> Revoke USB debugging authorizations.`,
      };
    case "offline":
      return {
        error:
          `Device ${d.serial} is "offline". Unplug and replug the cable (or toggle USB debugging),\n` +
          `then try \`adb kill-server && adb devices -l\`. For wireless debugging, run \`adb connect\` again.`,
      };
    default:
      return { error: `Device ${d.serial} is in state "${d.state}" — it must be "device" to be observed.` };
  }
}

/**
 * Extract DevTools abstract-socket names from the text of /proc/net/unix.
 * Lines end with the socket path; abstract sockets start with '@'.
 * Matches `chrome_devtools_remote`, `<anything>_devtools_remote`, and pid
 * suffixed variants (`webview_devtools_remote_1234`). Returns unique names with
 * the leading '@' removed, in file order.
 */
export function parseDevtoolsSockets(procNetUnix) {
  const seen = new Set();
  const out = [];
  for (const line of String(procNetUnix ?? "").split(/\r?\n/)) {
    const m = line.trim().match(/@([\w.\-]*devtools_remote[\w.\-]*)$/);
    if (!m) continue;
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

export function isWebviewSocket(name) {
  return /^webview_devtools_remote/.test(name);
}

/**
 * Choose which browser socket to forward. `wanted` is --socket (with or without
 * the '@'). Returns { socket, others } or { error }.
 *   - default: chrome_devtools_remote if present;
 *   - otherwise the single non-WebView socket (e.g. a Brave/Edge variant);
 *   - otherwise an error listing the choices.
 */
export function pickSocket(sockets, wanted) {
  if (sockets.length === 0) {
    return {
      error:
        "No DevTools sockets found on the phone. The browser must be running with a tab open\n" +
        "(open the site in Chrome/Brave first). Chrome only exposes the socket while it is running;\n" +
        "a browser that was swiped away or killed has none.",
    };
  }
  if (wanted) {
    const w = String(wanted).replace(/^@/, "");
    if (!sockets.includes(w)) {
      return { error: `Socket "${w}" not found. Sockets present: ${sockets.join(", ")}` };
    }
    return { socket: w, others: sockets.filter((s) => s !== w) };
  }
  if (sockets.includes("chrome_devtools_remote")) {
    return { socket: "chrome_devtools_remote", others: sockets.filter((s) => s !== "chrome_devtools_remote") };
  }
  const browsers = sockets.filter((s) => !isWebviewSocket(s));
  if (browsers.length === 1) {
    return { socket: browsers[0], others: sockets.filter((s) => s !== browsers[0]) };
  }
  return {
    error:
      `Several DevTools sockets and none is chrome_devtools_remote — choose one with --socket NAME:\n` +
      sockets.map((s) => `  ${s}${isWebviewSocket(s) ? "   (a WebView inside some app)" : ""}`).join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Next.js traffic classification

const CACHE_RESPONSE_HEADERS = [
  "cache-control",
  "x-nextjs-cache",
  "x-nextjs-prerender",
  "x-nextjs-stale-time",
  "age",
];

/**
 * Classify a request by its (lowercase) headers.
 *   next-action present              -> { kind: 'action' }
 *   rsc header or a prefetch header  -> { kind: 'rsc', prefetch }
 *   otherwise                        -> null (ordinary traffic)
 * Server actions win over RSC: an action POST can carry both.
 */
export function classifyNextRequest(headers) {
  const h = lowerKeys(headers);
  if (h["next-action"] !== undefined) return { kind: "action" };
  const prefetch = !!(h["next-router-prefetch"] || h["next-router-segment-prefetch"]);
  if (h["rsc"] !== undefined || prefetch) return { kind: "rsc", prefetch };
  return null;
}

/** Only the named cache headers, values as-is. Nothing else is ever copied. */
export function pickCacheHeaders(responseHeaders) {
  const h = lowerKeys(responseHeaders);
  const out = {};
  for (const name of CACHE_RESPONSE_HEADERS) {
    if (h[name] !== undefined) out[name] = trimText(h[name], 120);
  }
  return out;
}

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[String(k).toLowerCase()] = v;
  return out;
}

/**
 * Build the event body for a finished request, or null when it is ordinary
 * traffic that returned < 400 (not worth a line). Never reads bodies/cookies.
 */
export function buildRequestEvent({ method, url, headers, status, responseHeaders, durationMs }) {
  const cls = classifyNextRequest(headers);
  const { path } = redactUrl(url);
  if (cls?.kind === "action") {
    return { kind: "action", method, path, status, durationMs };
  }
  if (cls?.kind === "rsc") {
    const ev = { kind: "rsc", method, path, status, durationMs, prefetch: cls.prefetch };
    const cache = pickCacheHeaders(responseHeaders);
    if (Object.keys(cache).length) ev.cache = cache;
    return ev;
  }
  if (status >= 400) return { kind: "http-error", method, path, status, durationMs };
  return null;
}

// ---------------------------------------------------------------------------
// Interaction sanitising (the privacy whitelist)

const MAX_LABEL = 60;
const FORM_FIELD_TAGS = new Set(["input", "textarea", "select"]);
const SECRET_AUTOCOMPLETE = /(password|one-time-code|cc-(number|csc|exp|name))/i;
const SECRET_NAME = /(pass(word|wd|code)?|pwd|secret|token|otp|cvv|cvc|card.?num)/i;

/**
 * Is this field secret? type=password, autocomplete containing "password" (or
 * one-time-code / card fields), or a name/id that says so. Deliberately
 * over-eager: redacting an innocent field costs nothing, leaking one costs a lot.
 */
export function isSecretField(f) {
  if (!f || typeof f !== "object") return false;
  if (f.secret === true) return true;
  if (String(f.type ?? "").toLowerCase() === "password") return true;
  if (SECRET_AUTOCOMPLETE.test(String(f.autocomplete ?? ""))) return true;
  if (SECRET_NAME.test(String(f.name ?? "")) || SECRET_NAME.test(String(f.id ?? ""))) return true;
  return false;
}

function bool(v) {
  return v === true ? true : undefined;
}

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Trim a page-supplied element descriptor to the whitelist: tag, role,
 * aria-label, id, visible text (<=60), href path (no query), disabled flags.
 * Form fields and contenteditable never contribute text. A secret field becomes
 * exactly `{ secret: true }`.
 */
export function sanitizeElement(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  if (isSecretField(raw)) return { secret: true };
  const tag = trimText(raw.tag, 20).toLowerCase();
  const isField = FORM_FIELD_TAGS.has(tag) || raw.editable === true;
  const el = {
    tag: tag || undefined,
    inputType: isField && tag === "input" ? trimText(raw.type, 20).toLowerCase() || undefined : undefined,
    role: trimText(raw.role, 30) || undefined,
    ariaLabel: trimText(raw.ariaLabel, MAX_LABEL) || undefined,
    id: trimText(raw.id, MAX_LABEL) || undefined,
    name: isField ? trimText(raw.name, MAX_LABEL) || undefined : undefined,
    text: isField ? undefined : trimText(raw.text, MAX_LABEL) || undefined,
    href: raw.href ? pathOf(raw.href) : undefined,
    disabled: bool(raw.disabled),
    ariaDisabled: bool(raw.ariaDisabled),
  };
  return compact(el);
}

/**
 * A changed form control: tag, type, name/id/aria-label and the value LENGTH.
 * Never the value. A secret control yields `{ secret: true }` and nothing else —
 * not even a length, which would leak the password's size.
 */
export function sanitizeField(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  if (isSecretField(raw)) return { secret: true };
  const type = trimText(raw.type, 20).toLowerCase();
  const len = Number.isFinite(raw.valueLength) ? Math.max(0, Math.min(1_000_000, Math.trunc(raw.valueLength))) : undefined;
  return compact({
    tag: trimText(raw.tag, 20).toLowerCase() || undefined,
    inputType: type || undefined,
    name: trimText(raw.name, MAX_LABEL) || undefined,
    id: trimText(raw.id, MAX_LABEL) || undefined,
    ariaLabel: trimText(raw.ariaLabel, MAX_LABEL) || undefined,
    // type=file reports a fake path; its length means nothing.
    valueLength: type === "file" ? undefined : len,
  });
}

/**
 * Turn a payload from the page agent into the interaction fields of an event,
 * or null when it is not a recognised, allowed shape. This is the only path by
 * which anything the page says reaches events.jsonl.
 */
export function sanitizeInteraction(raw) {
  if (!raw || typeof raw !== "object") return null;
  switch (raw.type) {
    case "click":
    case "touchend": {
      const target = sanitizeElement(raw.target);
      if (!target) return null;
      const via = raw.via ? sanitizeElement(raw.via) : undefined;
      return compact({
        type: raw.type,
        target,
        via: via && !target.secret ? via : undefined,
        noClick: bool(raw.noClick),
      });
    }
    case "change": {
      const field = sanitizeField(raw.field);
      return field ? { type: "change", field } : null;
    }
    case "submit": {
      const f = raw.form && typeof raw.form === "object" ? raw.form : {};
      const method = trimText(f.method, 10).toLowerCase() || "get";
      return {
        type: "submit",
        form: compact({
          method,
          hasPassword: f.hasPassword === true,
          id: trimText(f.id, MAX_LABEL) || undefined,
          // An in-JS form handler still posts natively if hydration failed;
          // a form that submits as GET is exactly the bug class worth flagging.
          nativeGet: method === "get" ? true : undefined,
        }),
      };
    }
    case "visibilitychange":
      return { type: "visibilitychange", state: raw.state === "hidden" ? "hidden" : "visible" };
    case "connectivity":
      return { type: "connectivity", online: raw.online === true };
    default:
      return null;
  }
}

/** Trim a snapshot payload from the page to the whitelist. */
export function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const labels = Array.isArray(raw.disabledLabels) ? raw.disabledLabels.slice(0, 5).map((s) => trimText(s, 40)) : [];
  return compact({
    bodyText: trimText(raw.bodyText, 1200),
    activeElement: sanitizeElement(raw.activeElement),
    disabledButtons: Number.isFinite(raw.disabledButtons) ? Math.trunc(raw.disabledButtons) : 0,
    disabledLabels: labels.length ? labels : undefined,
  });
}

/** Short stable hash of a string (FNV-1a) — used to skip identical snapshots. */
export function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** `/count/4?x=1` -> `count-4`. File-name safe, bounded. */
export function slugForPath(path) {
  const s = String(path ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "home";
}

/**
 * Should this screenshot be skipped? A screenshot is raw pixels, so the log's
 * whitelists cannot protect it; the only defence is not taking it. Returns
 * null (take it), "origin-changed" (the page is no longer on the observed
 * origin) or "secret-field" (a password-like field has focus, so its contents
 * or bullets may be on screen). `activeElement` is a SANITIZED descriptor.
 */
export function screenshotSkipReason({ activeElement, url }, origin) {
  if (!isSameOrigin(url, origin)) return "origin-changed";
  if (activeElement && activeElement.secret === true) return "secret-field";
  return null;
}

/**
 * May sessions be written to `outRoot`? Anything inside the repo checkout must
 * sit under `<repo>/.phone-sessions` (the one gitignored place), otherwise a
 * session, screenshots included, could land next to tracked source and be
 * committed by a stray `git add -A`. Paths outside the repo are the user's
 * business. Both arguments should be absolute (ideally realpath'd).
 * Returns { ok: true } or { ok: false, error }.
 */
export function checkOutDir(outRoot, repoRoot) {
  const out = nodePath.resolve(outRoot);
  const repo = nodePath.resolve(repoRoot);
  const within = (base, target) => {
    const rel = nodePath.relative(base, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(rel));
  };
  if (!within(repo, out)) return { ok: true };
  const allowed = nodePath.join(repo, ".phone-sessions");
  if (within(allowed, out)) return { ok: true };
  return {
    ok: false,
    error:
      `--out ${out} is inside the repository but not under .phone-sessions/ (the only gitignored place for sessions).\n` +
      "Session logs and screenshots must not land next to tracked files. Use a path under\n" +
      `${allowed}, a directory outside the repository, or omit --out.`,
  };
}

/** Zero-padded screenshot file name, e.g. `shots/001-count-4.jpg`. */
export function shotName(n, path) {
  return `${String(n).padStart(3, "0")}-${slugForPath(path)}.jpg`;
}

// ---------------------------------------------------------------------------
// Event description (live line + timeline row)

/** HH:MM:SS (local) from an ISO string. */
export function clock(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function isDisabledEl(el) {
  return !!(el && (el.disabled || el.ariaDisabled));
}

function elLabel(el) {
  if (!el) return "";
  if (el.secret) return "[secret field]";
  const name = el.text || el.ariaLabel || el.id || el.name || el.href || "";
  const tag = el.tag || "element";
  return name ? `${tag} "${name}"` : tag;
}

/** One-line human description of any event. */
export function describeEvent(ev) {
  switch (ev.kind) {
    case "session":
      return ev.phase === "start" ? `session start (${ev.origin})` : `session end (${ev.reason ?? "done"})`;
    case "tab":
      return `tab ${ev.action}${ev.pageId !== undefined ? ` #${ev.pageId}` : ""}`;
    case "nav": {
      const q = ev.query ? ` (+query ${ev.queryLen} chars)` : "";
      const vp = ev.viewport ? ` ${ev.viewport.w}x${ev.viewport.h}@${ev.dpr}` : "";
      const net = ev.online === false ? " OFFLINE" : "";
      return `${ev.navType ?? "nav"} ${ev.path}${q}${ev.title ? ` — ${trimText(ev.title, 50)}` : ""}${vp}${net}`;
    }
    case "console":
      return `console.${ev.level} ${trimText(ev.text, 120)}${ev.src ? `  [${ev.src}]` : ""}`;
    case "pageerror":
      return `PAGE ERROR ${trimText(ev.message, 120)}${ev.frame ? `  [${trimText(ev.frame, 80)}]` : ""}`;
    case "requestfailed":
      return `${ev.aborted ? "request aborted" : "REQUEST FAILED"} ${ev.method} ${ev.xorigin ? ev.xorigin : ""}${ev.path} — ${ev.errorText}${
        ev.next ? ` (${ev.next}${ev.prefetch ? " prefetch" : ""})` : ""
      }`;
    case "http-error":
      return `HTTP ${ev.status} ${ev.method} ${ev.xorigin ? ev.xorigin : ""}${ev.path} (${ev.durationMs}ms)`;
    case "action":
      return `server action ${ev.status} ${ev.durationMs}ms ${ev.path}`;
    case "rsc":
      return `rsc ${ev.prefetch ? "prefetch" : "navigation"} ${ev.status} ${ev.durationMs}ms ${ev.path}${
        ev.cache?.["x-nextjs-cache"] ? ` cache=${ev.cache["x-nextjs-cache"]}` : ""
      }${ev.cache?.age ? ` age=${ev.cache.age}` : ""}`;
    case "interaction":
      switch (ev.type) {
        case "click": {
          // The button/link the user meant beats the <span> inside it that took the click.
          const el = ev.via ?? ev.target;
          return `click ${elLabel(el)}${isDisabledEl(ev.target) || isDisabledEl(ev.via) ? " (DISABLED)" : ""}`;
        }
        case "touchend": {
          const el = ev.via ?? ev.target;
          return `tap, no click ${elLabel(el)}${isDisabledEl(ev.target) || isDisabledEl(ev.via) ? " (DISABLED)" : ""}`;
        }
        case "change":
          return ev.field?.secret
            ? "change [secret field]"
            : `change ${ev.field?.tag ?? "field"} ${ev.field?.name || ev.field?.id || ev.field?.ariaLabel || ""} (len ${ev.field?.valueLength ?? "?"})`;
        case "submit":
          return `submit form method=${ev.form?.method}${ev.form?.hasPassword ? " (has password)" : ""}${
            ev.form?.nativeGet ? " NATIVE GET?" : ""
          }`;
        case "visibilitychange":
          return `page ${ev.state}`;
        case "connectivity":
          return ev.online ? "network online" : "network OFFLINE";
        default:
          return `interaction ${ev.type}`;
      }
    case "snapshot":
      return ev.unchanged
        ? `snapshot (unchanged) ${ev.path}`
        : `snapshot ${ev.path} — ${trimText(ev.bodyText, 80)}${ev.disabledButtons ? ` [${ev.disabledButtons} disabled btn]` : ""}${
            ev.shot ? `  ${ev.shot}` : ""
          }`;
    case "screenshot-skipped":
      return `screenshot skipped (${ev.reason})${ev.path ? ` ${ev.path}` : ""}`;
    case "disconnected":
      return `DISCONNECTED ${ev.reason ?? ""}`.trim();
    case "note":
      return ev.text;
    default:
      return ev.kind;
  }
}

/** Worth printing live / ranking high in the timeline? */
export function isNotable(ev) {
  switch (ev.kind) {
    case "snapshot":
      return !ev.unchanged;
    case "rsc":
      return !ev.prefetch;
    case "console":
      return ev.level === "error" || ev.level === "warning" || ev.level === "warn";
    case "requestfailed":
      // ERR_ABORTED is the browser cancelling its own request (a navigation
      // superseding a prefetch). Kept in the log, not worth a live line.
      return !ev.aborted || ev.next === "action";
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Summary

function isFailedAction(ev) {
  return ev.kind === "action" && (ev.status >= 400 || ev.status === 0);
}

/** Counts the summary headlines (and the terminal) report. */
export function computeCounts(events) {
  const c = {
    pageErrors: 0,
    consoleErrors: 0,
    consoleWarnings: 0,
    requestsFailed: 0,
    requestsAborted: 0,
    httpErrors: 0,
    actions: 0,
    actionsFailed: 0,
    actionsSlow: 0,
    rscNavigation: 0,
    rscPrefetch: 0,
    rscErrors: 0,
    navs: 0,
    clicks: 0,
    tapsNoClick: 0,
    submits: 0,
    snapshots: 0,
    shots: 0,
  };
  for (const ev of events) {
    switch (ev.kind) {
      case "pageerror":
        c.pageErrors++;
        break;
      case "console":
        if (ev.level === "error") c.consoleErrors++;
        else if (ev.level === "warning" || ev.level === "warn") c.consoleWarnings++;
        break;
      case "requestfailed":
        // A request the browser cancelled itself is counted apart: it is normal
        // churn, and burying real failures under it would make the headline useless.
        // An aborted server action is the exception — the user's save never landed.
        if (ev.next === "action") {
          c.actions++;
          c.actionsFailed++;
          c.requestsFailed++;
        } else if (ev.aborted) {
          c.requestsAborted++;
        } else {
          c.requestsFailed++;
        }
        break;
      case "http-error":
        c.httpErrors++;
        break;
      case "action":
        c.actions++;
        if (isFailedAction(ev)) {
          c.actionsFailed++;
          c.httpErrors++;
        }
        if (ev.durationMs > 1500) c.actionsSlow++;
        break;
      case "rsc":
        if (ev.prefetch) c.rscPrefetch++;
        else c.rscNavigation++;
        if (ev.status >= 400) {
          c.rscErrors++;
          c.httpErrors++;
        }
        break;
      case "nav":
        c.navs++;
        break;
      case "interaction":
        if (ev.type === "click") c.clicks++;
        else if (ev.type === "touchend") c.tapsNoClick++;
        else if (ev.type === "submit") c.submits++;
        break;
      case "snapshot":
        c.snapshots++;
        if (ev.shot) c.shots++;
        break;
      default:
        break;
    }
  }
  return c;
}

/** Lower rank = more interesting = kept first when the timeline is capped. */
export function eventRank(ev) {
  switch (ev.kind) {
    case "requestfailed":
      return ev.aborted && ev.next !== "action" ? 4 : 0;
    case "pageerror":
    case "http-error":
    case "disconnected":
      return 0;
    case "action":
      return isFailedAction(ev) || ev.durationMs > 1500 ? 0 : 1;
    case "rsc":
      if (ev.status >= 400) return 0;
      return ev.prefetch ? 4 : 2;
    case "console":
      return ev.level === "error" ? 0 : ev.level === "warning" || ev.level === "warn" ? 1 : 4;
    case "nav":
    case "tab":
    case "session":
    case "screenshot-skipped":
      return 1;
    case "interaction":
      if (ev.type === "click" || ev.type === "submit" || ev.type === "touchend") return 1;
      if (ev.type === "change") return 2;
      return 3;
    case "snapshot":
      return ev.unchanged ? 5 : 3;
    default:
      return 3;
  }
}

/**
 * Pick at most `limit` events for the timeline: best rank first (ties broken by
 * time), then restored to chronological order. Returns { rows, omitted }.
 */
export function selectTimeline(events, limit = 200) {
  const indexed = events.map((ev, i) => ({ ev, i, rank: eventRank(ev) }));
  if (indexed.length <= limit) return { rows: events.slice(), omitted: 0 };
  const chosen = indexed.slice().sort((a, b) => a.rank - b.rank || a.i - b.i).slice(0, limit);
  chosen.sort((a, b) => a.i - b.i);
  return { rows: chosen.map((x) => x.ev), omitted: events.length - limit };
}

function mdCell(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

/**
 * Build summary.md. `meta` = { origin, device, browser, socket, mode,
 * startedAt, endedAt, endReason, otherTabsIgnored, eventsFile }.
 * `events` is the full in-memory event list.
 */
export function buildSummary(meta, events, { timelineLimit = 200 } = {}) {
  const counts = computeCounts(events);
  const durMs = new Date(meta.endedAt).getTime() - new Date(meta.startedAt).getTime();
  const L = [];
  L.push(`# Phone session — ${meta.origin}`, "");
  L.push("| | |", "|---|---|");
  L.push(`| Origin | ${mdCell(meta.origin)} |`);
  L.push(`| Mode | ${mdCell(meta.mode)} |`);
  if (meta.device) L.push(`| Device | ${mdCell(meta.device)} |`);
  if (meta.browser) L.push(`| Browser | ${mdCell(meta.browser)} |`);
  if (meta.socket) L.push(`| DevTools socket | ${mdCell(meta.socket)} |`);
  L.push(`| Started | ${meta.startedAt} |`);
  L.push(`| Ended | ${meta.endedAt} (${meta.endReason ?? "done"}) |`);
  L.push(`| Duration | ${fmtDuration(durMs)} |`);
  L.push(`| Other tabs ignored | ${meta.otherTabsIgnored ?? 0} (not read, not logged) |`);
  L.push("");

  L.push("## Counts", "");
  L.push(`- Page errors (uncaught / unhandled rejection): **${counts.pageErrors}**`);
  L.push(`- console.error: **${counts.consoleErrors}**, console.warn: ${counts.consoleWarnings}`);
  L.push(
    `- Failed requests (network level): **${counts.requestsFailed}**` +
      (counts.requestsAborted ? ` (plus ${counts.requestsAborted} aborted by the browser — normal churn, in events.jsonl)` : ""),
  );
  L.push(`- Responses >= 400: **${counts.httpErrors}**`);
  L.push(
    `- Server actions: **${counts.actions}** — ${counts.actionsFailed} failed, ${counts.actionsSlow} slower than 1500 ms`,
  );
  L.push(
    `- RSC fetches: **${counts.rscNavigation}** navigation, ${counts.rscPrefetch} prefetch` +
      (counts.rscErrors ? `, ${counts.rscErrors} with status >= 400` : ""),
  );
  L.push(
    `- Navigations: ${counts.navs} · clicks: ${counts.clicks} · taps with no click: ${counts.tapsNoClick} · form submits: ${counts.submits}`,
  );
  L.push(`- Snapshots: ${counts.snapshots} (${counts.shots} screenshots)`);
  L.push("");

  const { rows, omitted } = selectTimeline(events, timelineLimit);
  L.push("## Timeline", "");
  L.push("| t | time | kind | what |", "|---:|---|---|---|");
  for (const ev of rows) {
    L.push(
      `| ${(ev.t / 1000).toFixed(1)}s | ${clock(ev.iso)} | ${mdCell(ev.kind === "interaction" ? ev.type : ev.kind)}${
        ev.pageId !== undefined && ev.pageId > 0 ? ` (tab ${ev.pageId})` : ""
      } | ${mdCell(describeEvent(ev))} |`,
    );
  }
  if (omitted > 0) {
    L.push("", `_${omitted} lower-priority events omitted from this table (repetitive snapshots, prefetches, console.log). All are in ${meta.eventsFile ?? "events.jsonl"}._`);
  }
  L.push("");

  const shots = events.filter((e) => e.kind === "snapshot" && e.shot);
  L.push("## Screenshots", "");
  if (shots.length === 0) {
    L.push("_none_");
  } else {
    L.push("| file | page | at |", "|---|---|---|");
    for (const s of shots) {
      L.push(`| ${mdCell(s.shot)} | ${mdCell(s.path)} | ${(s.t / 1000).toFixed(1)}s (${mdCell(s.reason ?? "")}) |`);
    }
  }
  L.push("");
  L.push(
    "---",
    "Recorded: paths (never query strings), console text, errors, request status/timing, Next.js action/RSC classification, element descriptors, field *lengths*, page text snapshots, screenshots.",
    "Never recorded in the log: request/response bodies, cookies, authorization, typed values, password fields, query strings, other tabs.",
    "Screenshots are raw pixels, so they CAN show on-screen typed text in ordinary fields (none is taken while a password field is focused). The session folder is gitignored; look through shots/ before sharing it.",
    "",
  );
  return L.join("\n");
}

/** Headline lines for the terminal after the summary is written. */
export function headlineCounts(events) {
  const c = computeCounts(events);
  return [
    `errors: ${c.pageErrors} page, ${c.consoleErrors} console.error`,
    `failed requests: ${c.requestsFailed} · responses >=400: ${c.httpErrors}`,
    `server actions: ${c.actions} (${c.actionsFailed} failed, ${c.actionsSlow} slow >1500ms)`,
    `rsc: ${c.rscNavigation} navigation, ${c.rscPrefetch} prefetch`,
    `screenshots: ${c.shots}`,
  ];
}

/** `20260725-141530` from a Date, local time. */
export function sessionStamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
