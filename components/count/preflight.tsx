"use client";

import { useState, useSyncExternalStore } from "react";
import { Card, CardStack } from "@/components/ui/card";
import { StatusPill, type PillTone } from "@/components/ui/status-pill";
import { Button } from "@/components/ui/button";

/**
 * Environment preflight, run ON THE PHONE, before anyone walks the bar.
 *
 * This screen exists because of a specific and repeated failure: every
 * client-side break this project has shipped was invisible to the server and
 * obvious on the first real page load. The static CSP left the entire app
 * inert while `curl`, `next build` and CI all passed. `crypto.randomUUID` —
 * secure-context only — made every count save throw on the first LAN test,
 * after the setup had been declared ready.
 *
 * The common shape: the phone's environment differs from this machine's in
 * ways nothing server-side can see. So the answer is not more server checks,
 * it is five seconds of checking on the device that will actually be used,
 * and the point of putting it behind one URL is that it costs nothing to
 * repeat on a new handset, a new browser, or after a new IP lease.
 *
 * Everything here is a capability probe. It reads no data and writes none, so
 * it discloses nothing beyond what any script on the page could already
 * determine about its own browser.
 */

type Check = {
  label: string;
  tone: PillTone;
  status: string;
  detail: string;
};

/**
 * Read once and cached for the life of the tab. Every value here is an
 * immutable fact about the browser, so re-probing on each render would be
 * waste — and `useSyncExternalStore` REQUIRES a stable reference: returning a
 * fresh array from the snapshot each call is an infinite render loop.
 */
let cachedChecks: Check[] | null = null;

function computeChecks(): Check[] {
  if (cachedChecks) return cachedChecks;

  const secure = window.isSecureContext;
  const hasCamera = Boolean(navigator.mediaDevices?.getUserMedia);
  const hasRandomUUID = typeof crypto.randomUUID === "function";
  const hasGetRandomValues = typeof crypto.getRandomValues === "function";
  const hasIndexedDb = typeof indexedDB !== "undefined";
  const nativeDetector = "BarcodeDetector" in window;

  cachedChecks = [
      {
        label: "Secure context",
        tone: secure ? "success" : "negative",
        status: secure ? "Yes" : "No",
        detail: secure
          ? `${location.origin} is treated as secure. The camera is available.`
          : `${location.origin} is not, so the camera cannot be opened at all. Reload this page on the https address instead — the same host on port 3443. Accept the certificate warning once (it is self-signed and names this machine's IP; the warning is about identity, not encryption). Counting by quantity and search works fine here without it.`,
      },
      {
        label: "Camera API",
        tone: hasCamera ? "success" : "negative",
        status: hasCamera ? "Present" : "Missing",
        detail: hasCamera
          ? "navigator.mediaDevices.getUserMedia exists. Permission is still asked separately — use the button below."
          : "navigator.mediaDevices is undefined. This is caused by the insecure context above, not by the camera. Scanning will be unavailable; search still works.",
      },
      {
        label: "Barcode decoder",
        tone: "success",
        status: nativeDetector ? "Native" : "WASM polyfill",
        detail: nativeDetector
          ? "The native BarcodeDetector is available and will be used."
          : "No native BarcodeDetector, so the ZXing WASM polyfill loads on first scan. It works, but the first scan is slower — expect that and do not read it as a stall.",
      },
      {
        label: "Write ids",
        tone: hasGetRandomValues ? "success" : "negative",
        status: hasRandomUUID ? "crypto.randomUUID" : "getRandomValues fallback",
        detail: hasRandomUUID
          ? "The native UUID generator is available."
          : hasGetRandomValues
            ? "crypto.randomUUID is secure-context only and absent here, so the RFC 4122 v4 fallback in lib/count-queue.ts is generating write ids. This is expected on a plain-http LAN origin and is not a problem — saves work normally."
            : "crypto.getRandomValues is missing too. Writes cannot be made idempotent and counting must not proceed on this device.",
      },
      {
        // Recorded rather than judged. docs/phone-count-test.md asks for the
        // phone and browser on every run, and "which browser was that?" turned
        // out to be the load-bearing question the first time the camera would
        // not start — a missing native BarcodeDetector is the tell that this
        // is not stock Chrome, and Chromium-only advice does not apply.
        label: "Browser",
        tone: "neutral",
        status: nativeDetector ? "Chromium-like" : "Not Chromium",
        detail: navigator.userAgent,
      },
      {
        label: "Offline queue",
        tone: hasIndexedDb ? "success" : "negative",
        status: hasIndexedDb ? "IndexedDB ready" : "Unavailable",
        detail: hasIndexedDb
          ? "Pending writes can be buffered when the network drops."
          : "IndexedDB is unavailable — often private browsing. A dropped connection would lose counted lines.",
      },
  ];

  return cachedChecks;
}

/**
 * Never re-subscribes: these facts cannot change without a reload. The server
 * snapshot is `null`, which is what renders the "Checking this device…" line
 * during SSR and is replaced on hydration — the supported way to hold a
 * client-only value without an effect and without a hydration mismatch.
 */
const subscribe = () => () => {};
const serverSnapshot = (): Check[] | null => null;

export function Preflight() {
  const checks = useSyncExternalStore(subscribe, computeChecks, serverSnapshot);
  const [cameraResult, setCameraResult] = useState<Check | null>(null);
  const [testing, setTesting] = useState(false);

  // Permission is deliberately behind a tap rather than run on mount: a
  // permission prompt that appears before the user has asked for anything is
  // the one most likely to be dismissed reflexively, and a denied camera is
  // sticky per-origin.
  async function testCamera() {
    setTesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
      const torch = Boolean(caps?.torch);
      // Released immediately — this is a probe, not a preview, and a camera
      // left running behind a background tab is a battery and privacy cost.
      stream.getTracks().forEach((t) => t.stop());
      setCameraResult({
        label: "Camera permission",
        tone: "success",
        status: "Granted",
        detail: `Rear camera opened and released. Torch ${torch ? "is" : "is not"} supported on this handset${torch ? "" : " — expect scanning to be harder in a dim bar"}.`,
      });
    } catch (err) {
      const denied = err instanceof DOMException && err.name === "NotAllowedError";
      setCameraResult({
        label: "Camera permission",
        tone: "negative",
        status: denied ? "Denied" : "Failed",
        detail: denied
          ? "Permission was refused. Chrome remembers this per origin — clear it from the padlock/⚠ icon in the address bar, then retry."
          : `${err instanceof Error ? err.message : String(err)}. If the secure-context check above failed, fix that first; this is downstream of it.`,
      });
    } finally {
      setTesting(false);
    }
  }

  if (!checks) {
    return <p className="text-row-subtitle text-muted-foreground">Checking this device…</p>;
  }

  const blocking = checks.filter((c) => c.tone === "negative");
  const all = cameraResult ? [...checks, cameraResult] : checks;

  return (
    <div className="mt-section-gap">
      <Card>
        <p className="text-row-title text-card-foreground">
          {blocking.length === 0
            ? "This device can run a count."
            : `${blocking.length} blocking ${blocking.length === 1 ? "problem" : "problems"}.`}
        </p>
        <p className="mt-1 text-row-subtitle text-muted-foreground">
          {blocking.length === 0
            ? "Run the camera test below, then start the count."
            : "Fix these before walking the bar — each one fails silently or misleadingly once counting has started."}
        </p>
      </Card>

      <CardStack>
        {all.map((check) => (
          <Card key={check.label}>
            <div className="flex items-center justify-between gap-3">
              <p className="text-row-title text-card-foreground">{check.label}</p>
              <StatusPill tone={check.tone}>{check.status}</StatusPill>
            </div>
            <p className="mt-1 text-row-subtitle text-muted-foreground">{check.detail}</p>
          </Card>
        ))}
      </CardStack>

      <div className="mt-section-gap">
        <Button onClick={testCamera} disabled={testing} full>
          {testing ? "Opening camera…" : "Test camera"}
        </Button>
      </div>
    </div>
  );
}
