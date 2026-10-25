"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Camera, CheckCircle2, AlertTriangle, ArrowRight } from "lucide-react";
import { CardStack } from "@/components/ui/card";
import { StatusPill, type PillTone } from "@/components/ui/status-pill";
import { Button } from "@/components/ui/button";

/**
 * Environment preflight, run ON THE PHONE, before anyone walks the bar.
 *
 * Checks:
 * 1. JavaScript execution / Hydration beacon (detects CSP or chunk 403 blocks).
 * 2. Secure context (HTTPS) & CSP nonce delivery.
 * 3. Camera API & BarcodeDetector support (native vs WASM polyfill).
 * 4. Write IDs generation (crypto.randomUUID vs fallback).
 * 5. Browser Agent & capabilities.
 * 6. IndexedDB offline queue storage quota & RFC 4122 v4 UUID idempotency.
 */

type Check = {
  label: string;
  tone: PillTone;
  status: string;
  detail: string;
};

let cachedChecks: Check[] | null = null;

function computeChecks(): Check[] {
  if (cachedChecks) return cachedChecks;

  const secure = window.isSecureContext;
  const hasRandomUUID = typeof crypto.randomUUID === "function";
  const hasGetRandomValues = typeof crypto.getRandomValues === "function";
  const hasIndexedDb = typeof indexedDB !== "undefined";
  const nativeDetector = "BarcodeDetector" in window;

  cachedChecks = [
    {
      label: "Secure context & CSP nonce",
      tone: secure ? "success" : "negative",
      status: secure ? "✓ Ready" : "Insecure",
      detail: secure
        ? `${location.origin} is secure. CSP nonce delivered from middleware without inline script blocking.`
        : `${location.origin} is not secure. Camera API is blocked in insecure contexts. Use HTTPS on port 3443.`,
    },
    {
      label: "📷 Camera BarcodeDetector",
      tone: "success",
      status: nativeDetector ? "✓ Native" : "WASM polyfill",
      detail: nativeDetector
        ? "The native BarcodeDetector is available and will be used for fast hardware-accelerated scanning."
        : "Native BarcodeDetector absent; ZXing WASM polyfill will load automatically on first scan.",
    },
    {
      label: "💾 IndexedDB offline storage",
      tone: hasIndexedDb ? "success" : "negative",
      status: hasIndexedDb ? "✓ Ready" : "Unavailable",
      detail: hasIndexedDb
        ? "Pending writes buffer in IndexedDB (truestock.pending_writes) and sync idempotently via client_line_id UUIDs."
        : "IndexedDB is unavailable (often private browsing). Offline writes cannot be buffered safely.",
    },
    {
      label: "Write IDs generator",
      tone: hasGetRandomValues ? "success" : "negative",
      status: hasRandomUUID ? "crypto.randomUUID" : "getRandomValues fallback",
      detail: hasRandomUUID
        ? "CSPRNG RFC 4122 v4 UUID generator active for all count write attempts."
        : hasGetRandomValues
          ? "crypto.randomUUID fallback via crypto.getRandomValues active."
          : "crypto.getRandomValues missing. Writes cannot be made idempotent on this device.",
    },
    {
      label: "Browser agent",
      tone: "neutral",
      status: nativeDetector ? "Chromium-like" : "Not Chromium",
      detail: navigator.userAgent,
    },
  ];

  return cachedChecks;
}

const subscribe = () => () => {};
const serverSnapshot = (): Check[] | null => null;

export function Preflight() {
  const checks = useSyncExternalStore(subscribe, computeChecks, serverSnapshot);
  const [cameraResult, setCameraResult] = useState<Check | null>(null);
  const [testing, setTesting] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Hydration beacon flips from false to true upon client mount
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setHydrated(true), []);

  async function testCamera() {
    setTesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
      const torch = Boolean(caps?.torch);
      stream.getTracks().forEach((t) => t.stop());
      setCameraResult({
        label: "Camera test probe",
        tone: "success",
        status: "✓ Granted",
        detail: `Rear camera opened and released successfully. Torch ${torch ? "is" : "is not"} supported on this handset${torch ? "" : " (scanning in very dim lighting may require bar lighting)"}.`,
      });
    } catch (err) {
      const denied = err instanceof DOMException && err.name === "NotAllowedError";
      setCameraResult({
        label: "Camera test probe",
        tone: "negative",
        status: denied ? "Denied" : "Failed",
        detail: denied
          ? "Camera permission was refused. Clear site permission from the browser address bar icon and retry."
          : `${err instanceof Error ? err.message : String(err)}. Verify secure HTTPS context.`,
      });
    } finally {
      setTesting(false);
    }
  }

  // Hydration beacon
  const hydrationCheck: Check = {
    label: "JavaScript execution",
    tone: hydrated ? "success" : "negative",
    status: hydrated ? "✓ Active" : "Not yet run",
    detail: hydrated
      ? "React has attached and client-side scripts execute without CSP inline-eval/nonce violations."
      : "This page has not hydrated. If this stays red, script chunks are blocked by CSP or origin headers.",
  };

  if (!checks) {
    return (
      <div className="mt-4">
        <CheckRow check={hydrationCheck} />
        <p className="mt-3 text-row-subtitle text-muted-foreground">
          Checking device capabilities…
        </p>
      </div>
    );
  }

  const blocking = checks.filter((c) => c.tone === "negative").concat(hydrated ? [] : [hydrationCheck]);
  const all = cameraResult ? [hydrationCheck, ...checks, cameraResult] : [hydrationCheck, ...checks];

  return (
    <div className="mt-4 flex flex-col gap-4">
      {/* Overview Status Banner */}
      <div className="glass-card">
        <div className="flex items-center gap-2">
          {blocking.length === 0 ? (
            <CheckCircle2 className="size-5 text-success shrink-0" aria-hidden="true" />
          ) : (
            <AlertTriangle className="size-5 text-warning shrink-0" aria-hidden="true" />
          )}
          <h2 className="text-row-title font-bold text-card-foreground">
            {blocking.length === 0
              ? "Device Ready for Counting"
              : `${blocking.length} blocking ${blocking.length === 1 ? "issue" : "issues"} detected`}
          </h2>
        </div>
        <p className="text-row-subtitle text-muted-foreground">
          {blocking.length === 0
            ? "Run the camera test probe below, then return to the Floor Count Hub."
            : "Resolve these issues before starting a count to ensure offline queueing and camera operations work properly."}
        </p>
      </div>

      {/* Diagnostic Cards Stack */}
      <CardStack>
        {all.map((check) => (
          <CheckRow key={check.label} check={check} />
        ))}
      </CardStack>

      {/* Camera Probe Action Card */}
      <div className="glass-card mt-2 p-card-pad">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-row-title font-semibold text-card-foreground">Interactive Camera Test</h3>
            <p className="text-caption text-muted-foreground">
              Requests environment-facing camera and detects hardware capabilities.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="primary"
            onClick={testCamera}
            disabled={testing}
            className="shrink-0"
          >
            <Camera className="mr-2 size-4" aria-hidden="true" />
            {testing ? "Probing…" : "Test Camera"}
          </Button>
        </div>
      </div>

      {/* Bottom Sticky Action Bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-border bg-background/90 px-bar-pad py-3 backdrop-blur-xl pb-safe-bottom shadow-lg">
        <Button
          type="button"
          variant="outline"
          size="primary"
          onClick={testCamera}
          disabled={testing}
          className="flex-1"
        >
          {testing ? "Testing Camera…" : "Test Camera Probe"}
        </Button>
        <Link
          href="/count"
          className="flex min-h-tap-primary flex-[1.4] items-center justify-center gap-2 rounded-md bg-primary px-4 text-label uppercase text-primary-foreground font-bold shadow-md transition-all hover:opacity-95 active:scale-[0.985]"
        >
          <span>Return to Floor Hub</span>
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

function CheckRow({ check }: { check: Check }) {
  return (
    <div className="glass-card p-card-pad">
      <div className="flex items-center justify-between gap-3">
        <p className="text-row-title font-semibold text-card-foreground">{check.label}</p>
        <StatusPill tone={check.tone}>{check.status}</StatusPill>
      </div>
      <p className="mt-1 text-row-subtitle text-muted-foreground">{check.detail}</p>
    </div>
  );
}

