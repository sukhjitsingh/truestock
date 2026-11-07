import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/current-user";
import { Preflight } from "@/components/count/preflight";
import { PreflightOriginCheck } from "@/components/count/preflight-origin-check";

export const metadata = { title: "Preflight · Truestock" };

/**
 * Device preflight (`/count/preflight`, Target 9)
 *
 * Hardware & storage diagnostics to verify camera BarcodeDetector, WASM fallback,
 * IndexedDB storage quota, CSP nonce delivery, and secure context before counting.
 */
export default async function PreflightPage() {
  await requireUser();

  return (
    <div className="px-bar-pad pb-action-bar pt-4">
      {/* Top Header Bar */}
      <header className="flex items-center justify-between border-b border-border/60 pb-3.5">
        <Link
          href="/count"
          aria-label="Back to Floor Count Hub"
          className="flex size-11 items-center justify-center rounded-full border border-border/80 bg-card/85 text-foreground backdrop-blur-md shadow-xs transition-all hover:border-accent/40 active:scale-95"
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </Link>
        <span className="text-screen-title font-semibold uppercase tracking-wider text-foreground">
          Device Preflight
        </span>
        <div className="size-11" aria-hidden="true" />
      </header>

      {/* Screen Title & Subtitle */}
      <div className="pt-4">
        <h1 className="text-header-title text-foreground">Device Diagnostic</h1>
        <p className="mt-0.5 text-row-subtitle text-muted-foreground">
          What this phone can and cannot do before counting
        </p>
      </div>

      <div className="mt-4">
        <PreflightOriginCheck />
      </div>

      <Preflight />
    </div>
  );
}

