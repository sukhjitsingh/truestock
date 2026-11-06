"use client";

import { useEffect, useRef, useState } from "react";
import { X, Zap, ZapOff } from "lucide-react";
import { createRescanGuard, offerFrame } from "@/lib/rescan-guard";
import { chooseBarcodeReader, ZXING_WASM_PATH } from "@/lib/barcode-reader";

/**
 * Live barcode scanning with the phone's built-in `BarcodeDetector` when it can
 * read retail barcodes, otherwise the app-provided reader — the
 * `barcode-detector` ZXing polyfill, with its engine served from this app's
 * own origin (spec §11; rule in lib/barcode-reader.ts).
 *
 * The polyfill is imported dynamically and only when the native API is
 * missing — it is a ZXing-C++ WASM bundle, and pulling it into the main chunk
 * would tax the one screen whose load time matters most on a phone that is
 * already on bar WiFi.
 *
 * Torch: spec §11 calls this "the cheapest accuracy win available". A bar is
 * dim and bottle labels are glossy. It is offered whenever the track reports
 * support, and left off by default — a bartender pointing a torch at a guest
 * is worse than a slow scan.
 */
/**
 * The re-scan guard lives in `lib/rescan-guard.ts` so the rule that decides
 * whether a frame counts can be tested without a camera. See that file for
 * why continuity, not barcode value, is what the guard keys on.
 */

export function BarcodeScanner({
  onDetected,
  onClose,
  overlay,
  footer,
  continuous = false,
}: {
  /**
   * `format` is the symbology the detector reports (`upc_a`, `ean_13`, `upc_e`,
   * ...), or null if it gave none. It travels with the barcode to the server,
   * which needs it to tell an 8-digit UPC-E from an 8-digit EAN-8 — the digits
   * alone cannot (docs/plans/barcode-integrity).
   */
  onDetected: (barcode: string, format: string | null) => void;
  onClose: () => void;
  /**
   * Rendered over the camera, above the aiming frame. Rapid mode uses it to
   * confirm each scan without closing the scanner — in that mode this is the
   * only place a result, or a refusal, can be seen at all.
   */
  overlay?: React.ReactNode;
  /** Replaces the default hint line. Rapid mode puts its toggle here. */
  footer?: React.ReactNode;
  /**
   * Keep detecting after a hit instead of firing once and stopping.
   *
   * The one-shot default is not laziness: it relies on the parent closing the
   * scanner, which is exactly what rapid mode does not do. Left at `false`
   * with the scanner held open, the loop returns after the first barcode and
   * the camera sits there live and inert.
   */
  continuous?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);

  // Read inside the detection loop, which is started once and must not be torn
  // down when the mode is toggled — restarting it would drop the camera and
  // re-prompt for permission mid-count.
  const continuousRef = useRef(continuous);
  useEffect(() => {
    continuousRef.current = continuous;
  }, [continuous]);

  // Latest-callback ref so the detection loop never restarts (and never tears
  // down the camera) just because the parent re-rendered with a new closure.
  // Written in an effect rather than during render — a ref mutation during
  // render is not safe under concurrent rendering.
  const onDetectedRef = useRef(onDetected);
  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    const guard = createRescanGuard();

    async function start() {
      try {
        // Checked before anything else because the failure is otherwise
        // mislabelled. Browsers only expose navigator.mediaDevices in a
        // secure context (https, or localhost) — on a plain-http origin it is
        // undefined, so the getUserMedia call below throws a TypeError, lands
        // in the catch, and reports a camera problem. The camera is fine; the
        // URL is the problem. This is the normal state of affairs when
        // testing on a phone over the LAN (scripts/dev-lan.sh), which is the
        // only way the counting screens can be exercised at all.
        if (!window.isSecureContext || !navigator.mediaDevices) {
          // Name the URL that actually works. This message used to send people
          // to chrome://flags#unsafely-treat-insecure-origin-as-secure, which
          // silently did nothing twice (STATE.md, 2026-07-29) — the handset's
          // preflight showed no native BarcodeDetector, meaning the browser
          // was not Chromium and the flag did not exist to be set. The answer
          // is the nginx TLS proxy on :3443 (docker-compose profile `tls`,
          // scripts/dev-lan.sh), which works on any browser.
          setError(
            `The camera needs a secure origin, and ${window.location.origin} is not one. ` +
              `Reload on https://${window.location.hostname}:3443${window.location.pathname} ` +
              "and accept the certificate warning once — it is self-signed, so the warning " +
              "is about identity, not encryption. Open /count/preflight there to confirm " +
              "the handset before counting. Search-only counting works fine here without it.",
          );
          return;
        }

        type DetectorLike = {
          detect(source: CanvasImageSource): Promise<{ rawValue: string; format?: string }[]>;
        };
        type BuiltInDetector = {
          new (o: { formats: string[] }): DetectorLike;
          getSupportedFormats?: () => Promise<string[]>;
        };

        // Built-in reader first, but only if it can read retail barcodes —
        // the rule lives in lib/barcode-reader.ts. Asking what it supports is
        // what tells a usable built-in reader from one that would open the
        // camera and never recognise a bottle.
        const builtIn = (window as unknown as { BarcodeDetector?: BuiltInDetector }).BarcodeDetector;
        let supportedFormats: string[] | null = null;
        if (builtIn?.getSupportedFormats) {
          try {
            supportedFormats = await builtIn.getSupportedFormats();
          } catch {
            supportedFormats = null; // can't ask → treat as unusable
          }
        }
        const reader = chooseBarcodeReader({ available: Boolean(builtIn), supportedFormats });

        let detector: DetectorLike;
        if (reader.kind === "built-in" && builtIn) {
          detector = new builtIn({ formats: reader.formats });
        } else {
          const mod = await import("barcode-detector/pure");
          try {
            // Load the engine from THIS app's origin, and wait for it, so a
            // failure surfaces here rather than as a camera that silently never
            // reads anything. See ZXING_WASM_PATH for why it must be same-origin.
            await mod.prepareZXingModule({
              overrides: {
                locateFile: (path: string, prefix: string) =>
                  path.endsWith(".wasm") ? ZXING_WASM_PATH : prefix + path,
              },
              fireImmediately: true,
            });
          } catch {
            if (!cancelled) {
              setError(
                "This phone has no built-in barcode reader, and the app's own reader " +
                  "could not load. Use search instead, and report this.",
              );
            }
            return;
          }
          detector = new mod.BarcodeDetector({
            formats: reader.formats as ("upc_a" | "upc_e" | "ean_13" | "ean_8" | "code_128" | "code_39")[],
          }) as DetectorLike;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;

        const track = stream.getVideoTracks()[0];
        const caps = track.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean };
        setTorchSupported(Boolean(caps?.torch));

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const results = await detector.detect(videoRef.current);
            const hit = results.find((r) => r.rawValue);

            if (hit && !cancelled && !continuousRef.current) {
              onDetectedRef.current(hit.rawValue, hit.format ?? null);
              return; // one-shot: the parent closes us, stop scanning now
            }

            // Continuous (rapid) mode: every frame is offered to the guard,
            // including the empty ones — a frame with no barcode is what
            // re-arms it, so it carries as much information as a hit.
            if (!cancelled && offerFrame(guard, hit?.rawValue ?? null, Date.now())) {
              onDetectedRef.current(hit!.rawValue, hit!.format ?? null);
            }
          } catch {
            // A single failed frame is not an error worth surfacing — the
            // detector throws on frames that aren't ready yet.
          }
          raf = requestAnimationFrame(() => void tick());
        };
        void tick();
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Camera access was blocked. Allow it in the browser, or use search instead."
            : "Couldn't start the camera. Use search instead.",
        );
      }
    }

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div
        // `--spacing-safe-top` (globals.css) is `max(0px, env(safe-area-inset-top))`
        // with no bar-pad floor — unlike `--spacing-safe-bottom`, which has one.
        // On devices reporting a zero top inset (most Android phones), the bare
        // token would collapse this header's padding to 0px. Composing both
        // tokens here preserves the guaranteed bar-pad floor while still
        // resolving the real inset when present, instead of hand-duplicating
        // `env()` in an inline style.
        className="flex items-center justify-between p-bar-pad pt-[max(var(--spacing-bar-pad),var(--spacing-safe-top))]"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close scanner"
          className="flex size-tap-primary items-center justify-center rounded-full border border-white/25 text-white active:bg-white/10"
        >
          <X className="size-6" aria-hidden="true" />
        </button>
        {torchSupported ? (
          <button
            type="button"
            onClick={toggleTorch}
            aria-label={torchOn ? "Turn torch off" : "Turn torch on"}
            aria-pressed={torchOn}
            className="flex size-tap-primary items-center justify-center rounded-full border border-white/25 text-white active:bg-white/10"
          >
            {torchOn ? (
              <Zap className="size-5" aria-hidden="true" />
            ) : (
              <ZapOff className="size-5" aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>

      <div className="relative flex-1">
        <video
          ref={videoRef}
          playsInline
          muted
          className="size-full object-cover"
          aria-label="Barcode camera preview"
        />
        {/* Aiming frame. Purely visual — detection runs on the whole frame. */}
        <div className="pointer-events-none absolute inset-x-8 top-1/2 h-40 -translate-y-1/2 rounded-lg border-2 border-white/70" />
        {overlay ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 p-bar-pad">{overlay}</div>
        ) : null}
      </div>

      <div className="p-bar-pad pb-safe-bottom">
        {error ? (
          <p className="rounded-md bg-negative-bg px-3 py-2 text-caption text-negative" role="alert">
            {error}
          </p>
        ) : (
          (footer ?? (
            <p className="text-center text-caption text-white/70">
              Point at the barcode. Damaged label? Close this and search instead.
            </p>
          ))
        )}
      </div>
    </div>
  );
}
