/**
 * The page-side half of the observer. `installAgent` is serialised by
 * Playwright (`fn.toString()`) and run inside the page, so it must be fully
 * self-contained: no imports, no closures over module scope.
 *
 * It is READ-ONLY. It adds passive capture-phase listeners and a hidden
 * accessor object; it never calls preventDefault/stopPropagation, never clicks,
 * focuses, scrolls or writes to the DOM.
 *
 * Privacy is enforced twice: here (a secret field is described as
 * `{ secret: true }` and a field value is never read except for its LENGTH)
 * and again in Node by `sanitizeInteraction` / `sanitizeSnapshot` in
 * observe-core.mjs, which whitelists fields. Neither side trusts the other.
 *
 * @param {{ binding: string, global: string, origin: string }} cfg
 */
export function installAgent(cfg) {
  if (window.top !== window) return; // top frame only — never an embedded iframe
  if (cfg.origin && location.origin !== cfg.origin) return; // foreign origin: install nothing
  if (Object.prototype.hasOwnProperty.call(window, cfg.global)) return; // already installed

  const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

  const send = (payload) => {
    try {
      const fn = window[cfg.binding];
      if (typeof fn === "function") {
        const r = fn(payload);
        if (r && typeof r.catch === "function") r.catch(() => {});
      }
    } catch {
      /* the observer must never break the page */
    }
  };

  const SECRET_AC = /(password|one-time-code|cc-(number|csc|exp|name))/i;
  const SECRET_NAME = /(pass(word|wd|code)?|pwd|secret|token|otp|cvv|cvc|card.?num)/i;

  const isSecret = (el) => {
    try {
      const type = String(el.type || el.getAttribute("type") || "").toLowerCase();
      if (type === "password") return true;
      if (SECRET_AC.test(el.getAttribute("autocomplete") || "")) return true;
      if (SECRET_NAME.test(el.getAttribute("name") || "") || SECRET_NAME.test(el.id || "")) return true;
    } catch {
      /* fall through */
    }
    return false;
  };

  const pathOfHref = (href) => {
    try {
      return new URL(href, location.href).pathname;
    } catch {
      return "";
    }
  };

  const BUTTONISH = new Set(["button", "submit", "reset"]);

  /** Compact element descriptor. Never includes a form field's value. */
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return undefined;
    const tag = el.tagName.toLowerCase();
    const isField = tag === "input" || tag === "textarea" || tag === "select";
    const editable = !!el.isContentEditable;
    if ((isField || editable) && isSecret(el)) return { secret: true };
    const d = {
      tag,
      role: el.getAttribute("role") || undefined,
      ariaLabel: el.getAttribute("aria-label") || undefined,
      id: el.id || undefined,
      disabled: el.disabled === true || undefined,
      ariaDisabled: el.getAttribute("aria-disabled") === "true" || undefined,
      editable: editable || undefined,
    };
    if (isField) {
      d.type = tag === "input" ? String(el.type || "text") : undefined;
      d.name = el.getAttribute("name") || undefined;
    }
    const href = el.tagName === "A" ? el.getAttribute("href") : null;
    if (href) d.href = pathOfHref(href);
    if (!isField && !editable) {
      d.text = clip(el.innerText || el.textContent, 60);
    } else if (tag === "input" && BUTTONISH.has(String(el.type).toLowerCase())) {
      d.text = clip(el.value, 60); // a button's label, not user input
    }
    return d;
  };

  const ACTIONABLE =
    "button,a[href],[role=button],[role=link],[role=tab],[role=menuitem],[role=switch],[role=checkbox],input[type=button],input[type=submit],summary,label";

  const describePair = (target) => {
    const via = target && target.closest ? target.closest(ACTIONABLE) : null;
    return { target: describe(target), via: via && via !== target ? describe(via) : undefined };
  };

  // --- clicks, and taps that never became a click ---------------------------
  let lastClickAt = -1;
  let touchStart = null;

  document.addEventListener(
    "click",
    (e) => {
      lastClickAt = performance.now();
      send({ type: "click", ...describePair(e.target) });
    },
    true,
  );

  document.addEventListener(
    "touchstart",
    (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      touchStart = t ? { x: t.clientX, y: t.clientY } : null;
    },
    { capture: true, passive: true },
  );

  // A tap normally ends in a click, so the click is the record. A tap that does
  // NOT produce one within 450 ms (a disabled button, a dead zone, a handler that
  // swallowed it) is the signature worth keeping. Swipes/scrolls are ignored.
  document.addEventListener(
    "touchend",
    (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      if (!t || !touchStart) return;
      const moved = Math.hypot(t.clientX - touchStart.x, t.clientY - touchStart.y);
      touchStart = null;
      if (moved > 10) return;
      const at = performance.now();
      const pair = describePair(e.target);
      setTimeout(() => {
        if (lastClickAt < at) send({ type: "touchend", noClick: true, ...pair });
      }, 450);
    },
    { capture: true, passive: true },
  );

  // --- field changes: tag/type/name + LENGTH only ---------------------------
  document.addEventListener(
    "change",
    (e) => {
      const el = e.target;
      if (!el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea" && tag !== "select") return;
      if (isSecret(el)) {
        send({ type: "change", field: { secret: true } });
        return;
      }
      send({
        type: "change",
        field: {
          tag,
          type: tag === "input" ? String(el.type || "text") : undefined,
          name: el.getAttribute("name") || undefined,
          id: el.id || undefined,
          ariaLabel: el.getAttribute("aria-label") || undefined,
          valueLength: typeof el.value === "string" ? el.value.length : undefined,
        },
      });
    },
    true,
  );

  document.addEventListener(
    "submit",
    (e) => {
      const form = e.target;
      if (!form || form.tagName !== "FORM") return;
      send({
        type: "submit",
        form: {
          method: String(form.method || "get"),
          hasPassword: !!form.querySelector("input[type=password]"),
          id: form.id || undefined,
        },
      });
    },
    true,
  );

  // Every navigation also fires visibilitychange -> hidden as the old document
  // unloads. That is not the user leaving the browser, so skip it: pagehide runs
  // first on an unload (and pageshow clears the flag if bfcache restores us).
  let leaving = false;
  window.addEventListener("pagehide", () => (leaving = true), true);
  window.addEventListener("pageshow", () => (leaving = false), true);
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden" && leaving) return;
      send({ type: "visibilitychange", state: document.visibilityState });
    },
    true,
  );
  window.addEventListener("online", () => send({ type: "connectivity", online: true }), true);
  window.addEventListener("offline", () => send({ type: "connectivity", online: false }), true);

  // --- on-demand reads (called by page.evaluate) ----------------------------
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT", "INPUT", "OPTION"]);

  /**
   * Visible text, walked node by node rather than `body.innerText`, because
   * innerText includes the typed content of contenteditable elements. Form
   * controls, hidden subtrees and contenteditable hosts are skipped entirely.
   */
  const visibleText = (limit) => {
    if (!document.body) return "";
    const parts = [];
    let len = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (SKIP.has(n.tagName) || n.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (typeof n.checkVisibility === "function" && !n.checkVisibility({ checkVisibilityCSS: true })) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = walker.nextNode()) && len < limit * 2) {
      const s = n.nodeValue;
      if (!s || !s.trim()) continue;
      parts.push(s);
      len += s.length;
    }
    return clip(parts.join(" "), limit);
  };

  const snapshot = () => {
    const buttons = Array.prototype.slice.call(
      document.querySelectorAll("button,[role=button],input[type=button],input[type=submit]"),
    );
    const disabled = buttons.filter(
      (b) =>
        (b.disabled === true || b.getAttribute("aria-disabled") === "true") &&
        (typeof b.checkVisibility !== "function" || b.checkVisibility({ checkVisibilityCSS: true })),
    );
    return {
      bodyText: visibleText(1200),
      activeElement: describe(document.activeElement),
      disabledButtons: disabled.length,
      disabledLabels: disabled.slice(0, 5).map((b) => clip(b.innerText || b.value || b.getAttribute("aria-label"), 40)),
    };
  };

  const info = () => ({
    title: clip(document.title, 120),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    dpr: window.devicePixelRatio,
    online: navigator.onLine,
    visible: document.visibilityState,
  });

  // Non-enumerable, non-writable, random name: invisible to Object.keys(window)
  // and not something app code stumbles over.
  Object.defineProperty(window, cfg.global, { value: { snapshot, info }, enumerable: false });
}
