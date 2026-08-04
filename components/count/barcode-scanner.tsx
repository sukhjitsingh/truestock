"use client";

import { useEffect, useRef, useState } from "react";
import { X, Zap, ZapOff } from "lucide-react";

/**
 * Live barcode scanning via the native `BarcodeDetector`, falling back to the
 * `barcode-detector` WASM polyfill (spec §11).
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
 * Minimum gap between two accepted hits in continuous mode.
 *
 * 900ms is above the time it takes to move one bottle out of frame and the
 * next one in, and well above the frame-drop gaps that would otherwise let a
 * stationary bottle re-arm. It is a backstop to the `armed` flag, not the
 * primary guard.
 */
const RESCAN_COOLDOWN_MS = 900;

export function BarcodeScanner({
  onDetected,
  onClose,
  overlay,
  footer,
  continuous = false,
}: {
  onDetected: (barcode: string) => void;
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
    /** False while a barcode is still in frame from the last accepted hit. */
    let armed = true;
    let lastHitAt = 0;

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

        type DetectorLike = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };
        // Every symbology a liquor bottle or case carton actually carries.
        // Deliberately narrow: each extra format costs detection time on every
        // frame, and this runs in a requestAnimationFrame loop on a phone.
        const formats = [...(["upc_a", "upc_e", "ean_13", "ean_8", "code_128", "code_39"] as const)];

        let detector: DetectorLike;
        const native = (window as unknown as { BarcodeDetector?: new (o: unknown) => DetectorLike })
          .BarcodeDetector;
        if (native) {
          detector = new native({ formats });
        } else {
          const mod = await import("barcode-detector/pure");
          detector = new mod.BarcodeDetector({ formats }) as DetectorLike;
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

            if (!hit) {
              // A clear frame is what re-arms continuous mode: the bottle has
              // left the view, so the next detection is a new bottle rather
              // than the same one still sitting in front of the lens.
              armed = true;
            } else if (!cancelled) {
              if (!continuousRef.current) {
                onDetectedRef.current(hit.rawValue);
                return; // one-shot: the parent closes us, stop scanning now
              }
              // Continuous (rapid) mode. Two conditions must BOTH hold before
              // a frame counts, and each catches a different double-count:
              //
              //   `armed`  — the barcode left the frame since the last hit.
              //              Without it a bottle held still is re-detected
              //              every frame, so one bottle becomes twenty.
              //   cooldown — a floor on the gap between hits, for when the
              //              detector drops a frame mid-bottle and briefly
              //              reports nothing while the bottle has not moved.
              //
              // Erring toward missing a scan is deliberate: a missed scan is
              // visible (the counter sees no confirmation and scans again),
              // whereas a phantom one is silent and inflates the count.
              const now = Date.now();
              if (armed && now - lastHitAt > RESCAN_COOLDOWN_MS) {
                armed = false;
                lastHitAt = now;
                onDetectedRef.current(hit.rawValue);
              }
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
        className="flex items-center justify-between p-bar-pad"
        style={{ paddingTop: "max(var(--spacing-bar-pad), env(safe-area-inset-top))" }}
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

      <div
        className="p-bar-pad"
        style={{ paddingBottom: "max(var(--spacing-bar-pad), env(safe-area-inset-bottom))" }}
      >
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
