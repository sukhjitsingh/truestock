"use client";

/**
 * The "this file is already uploaded" refusal panel, shared by the upload
 * screen and "Retry extraction" on the review screen so the two read the same.
 * The Open link renders only when the viewer may open the invoice.
 *
 * It scrolls itself into view when it appears: at phone width the bottom Retry
 * button sits at the fold, so the panel landed off screen and the press looked
 * like it did nothing.
 */
import { useEffect, useRef } from "react";

import type { RetryDuplicateView } from "@/lib/invoice-duplicate-view";

export function InvoiceDuplicateNotice({ view, note }: { view: RetryDuplicateView; note?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <div ref={panel} className="flex flex-col gap-3" role="alert">
      <div className="rounded-lg border border-negative bg-negative-bg p-4 text-foreground">
        <p className="text-body font-semibold">{view.heading}</p>
        <p className="mt-1 text-body break-words">{view.body}</p>
        {view.href && view.openLabel ? (
          <p className="mt-3">
            <a href={view.href} className="text-body text-accent font-semibold underline hover:text-accent/80">
              {view.openLabel}
            </a>
          </p>
        ) : null}
      </div>
      {note ? <p className="text-caption text-muted-foreground">{note}</p> : null}
    </div>
  );
}
