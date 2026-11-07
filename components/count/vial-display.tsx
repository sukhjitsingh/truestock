"use client";

import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

export interface VialDisplayProps {
  /** Fill level from 0.0 to 1.0 */
  value: number;
  /** Invoked when value changes via drag, click, or keyboard */
  onChange: (val: number) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Liquid Bottle Vial Simulation Visualizer (`VialDisplay`, Target 11)
 *
 * Implements an interactive fluid bottle simulation with bottle neck,
 * curved meniscus surface rendering, continuous pointer drag mechanics,
 * 10-grid tick marks, smooth gradient height transitions, and accessible slider semantics.
 */
export function VialDisplay({
  value,
  onChange,
  disabled = false,
  className,
}: VialDisplayProps) {
  const gaugeRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  const calculateValueFromPointer = useCallback(
    (clientY: number) => {
      if (!gaugeRef.current) return;
      const rect = gaugeRef.current.getBoundingClientRect();
      if (rect.height <= 0) return;
      const rel = 1 - (clientY - rect.top) / rect.height;
      const clamped = Math.max(0, Math.min(1, Math.round(rel * 10) / 10));
      onChange(clamped);
    },
    [onChange],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    isDraggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    calculateValueFromPointer(e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || disabled) return;
    calculateValueFromPointer(e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      try {
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      } catch {
        // Pointer capture may have already been released
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = Math.min(1, Math.round((value + 0.1) * 10) / 10);
      onChange(next);
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = Math.max(0, Math.round((value - 0.1) * 10) / 10);
      onChange(next);
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(0);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(1);
    }
  };

  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);

  return (
    <div className={cn("flex flex-col items-center", className)}>
      {/* Bottle Neck Simulation */}
      <div
        className="size-4 h-3.5 w-6 rounded-t-sm border-2 border-b-0 border-border bg-muted/80"
        aria-hidden="true"
      />

      {/* Main Bottle Body & Slider */}
      <div className="flex w-full items-stretch gap-3">
        <div
          ref={gaugeRef}
          role="slider"
          aria-label="Fill level in tenths"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent}% full`}
          tabIndex={disabled ? -1 : 0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
          className={cn(
            "relative h-[200px] flex-1 overflow-hidden rounded-b-xl rounded-t-md border-2 border-border bg-muted/60 touch-none cursor-pointer shadow-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {/* 10-Grid background division lines */}
          <div className="pointer-events-none absolute inset-0 flex flex-col">
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  "flex-1",
                  i > 0 && "border-t border-foreground/10",
                )}
              />
            ))}
          </div>

          {/* Dynamic Fluid Column with Meniscus Rendering */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-blue-600 to-accent transition-[height] duration-200 ease-out"
            style={{ height: `${percent}%` }}
          >
            {/* Meniscus Curve Top Highlight */}
            {percent > 0 ? (
              <div className="absolute inset-x-0 top-0 h-1.5 bg-white/40 shadow-xs backdrop-blur-xs" />
            ) : null}
          </div>
        </div>

        {/* 10-Grid Percentage Ticks */}
        <div
          className="flex w-10 flex-col justify-between py-1 text-right text-caption font-semibold tabular-nums text-muted-foreground select-none"
          aria-hidden="true"
        >
          <span>100%</span>
          <span>80%</span>
          <span>60%</span>
          <span>40%</span>
          <span>20%</span>
          <span>0%</span>
        </div>
      </div>
    </div>
  );
}

