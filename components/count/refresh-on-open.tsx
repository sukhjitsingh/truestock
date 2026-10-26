"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-fetches the page it sits on each time it is opened or returned to.
 *
 * The count hub and the count home are server-rendered snapshots of an open
 * count. Next's client router keeps the snapshot of every page you have been on
 * and, on history navigation — the Android Back button, a browser back swipe —
 * puts it back WITHOUT asking the server again. Visit the hub while the count
 * is empty, go count two bottles, press Back, and the hub reads
 * "0 Lines counted / $0.00 / Nothing counted yet" — a restored picture of the
 * count as it was, with the Submit button beside it. Nothing on screen says the
 * numbers are old, and only `router.refresh()` corrected it (found on the phone
 * test of 2026-10-25, reproduced in a real browser on 2026-10-26).
 *
 * A wrong-but-plausible total is the failure this app is built to avoid, so
 * an open count's pages ask for the truth every time they appear: on mount (a
 * restored page remounts), when the browser restores the page from its own
 * back/forward cache, when the tab comes back to the foreground after the
 * phone slept, and when the network returns.
 *
 * Mount it only on pages whose count can still change. A closed count is
 * immutable (invariant 1); there is nothing to refresh.
 *
 * It never refreshes blind. In Next 16 a refresh whose fetch fails is not
 * retried — the router turns it into a hard navigation, and the counter lands
 * on the browser's offline error page in the middle of a count (the walk-in
 * has no signal). Restoring the cached snapshot with no network was the
 * better behaviour, so a cheap same-origin request first proves the server is
 * reachable. `navigator.onLine` alone is not enough: wifi that is up with no
 * route to the server still reports online.
 */
export function RefreshOnOpen() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let probing = false;

    const refreshIfReachable = async () => {
      if (probing || !navigator.onLine) return;
      probing = true;
      try {
        // favicon.ico is static and outside the middleware matcher, so this
        // costs no render. Any HTTP answer means the server is there.
        await fetch("/favicon.ico", {
          method: "HEAD",
          cache: "no-store",
          signal: AbortSignal.timeout(4000),
        });
      } catch {
        return;
      } finally {
        probing = false;
      }
      if (!cancelled) router.refresh();
    };

    void refreshIfReachable();

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void refreshIfReachable();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshIfReachable();
    };
    const onOnline = () => void refreshIfReachable();

    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  return null;
}
