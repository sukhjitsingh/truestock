"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import type { LocationSummary } from "@/lib/domain/catalog";
import { StatusPill } from "@/components/ui/status-pill";

export interface LocationPickerProps {
  countId: number;
  locations: LocationSummary[];
  counted: Map<string, { locationId: number }>;
  onPick: (locationId: number) => void;
}

/**
 * Locked Location Leg Selector (`LocationPicker`, Target 11)
 *
 * Full-screen station picker presented at the start of each counting leg.
 */
export function LocationPicker({
  countId,
  locations,
  counted,
  onPick,
}: LocationPickerProps) {
  return (
    <div className="px-bar-pad pb-8 pt-4">
      <Link
        href={`/count/${countId}`}
        // The hub shows this count's totals. A prefetch taken now, while the
        // picker is up, would be a picture of the count before the leg's writes.
        prefetch={false}
        className="mb-2 inline-flex min-h-tap-min items-center gap-1 text-caption text-muted-foreground transition-colors hover:text-foreground active:scale-95"
      >
        <ChevronLeft className="size-4" aria-hidden="true" /> Back to Count #{countId}
      </Link>

      <h1 className="text-header-title text-foreground">Which section?</h1>
      <p className="mt-1 text-row-subtitle text-muted-foreground">
        Pick a station to count. Your active location stays locked until you tap{" "}
        <strong className="font-semibold text-foreground">Finish section</strong>.
      </p>

      <div className="mt-section-gap flex flex-col gap-card-gap">
        {locations.map((location) => {
          const n = [...counted.values()].filter((l) => l.locationId === location.id).length;
          return (
            <button
              key={location.id}
              type="button"
              onClick={() => onPick(location.id)}
              className="glass-card flex min-h-tap-primary flex-row items-center justify-between gap-3 p-card-pad text-left transition-all hover:border-accent/40 hover:bg-muted/50 active:scale-[0.985] focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted text-accent font-bold">
                  <MapPin className="size-6" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <span className="block truncate text-row-title font-bold text-card-foreground">
                    {location.name}
                  </span>
                  <span className="block truncate text-caption text-muted-foreground">
                    {location.countMode === "tenths" ? "Fill levels (tenths)" : "Quantities only"}
                  </span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {n > 0 ? (
                  <StatusPill tone="success">{n} counted</StatusPill>
                ) : (
                  <StatusPill tone="neutral">Pending</StatusPill>
                )}
                <ChevronRight className="size-5 text-muted-foreground" aria-hidden="true" />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

