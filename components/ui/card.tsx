import { cn } from "@/lib/utils";

/**
 * Card surface — docs/design-system.md §5's elevation policy: hairline
 * borders carry every edge, and there is no `shadow-*` anywhere in this app.
 * Shadows read as smudges on a dim phone screen and do nothing the border
 * isn't already doing.
 */
export function Card({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-card p-card-pad", className)}
      {...props}
    >
      {children}
    </div>
  );
}

/** Cards stack with 12px between them — never a joined or divided list. */
export function CardStack({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("flex flex-col gap-card-gap", className)}>{children}</div>;
}

/**
 * The 64px glyph tile that stands in for product photography. The MVP has no
 * file storage and no photos at all (CLAUDE.md), so this is the permanent
 * treatment rather than a placeholder waiting on images.
 */
export function GlyphTile({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex size-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
        className,
      )}
      aria-hidden="true"
    >
      {children}
    </div>
  );
}

/** Two-letter monogram from a product name, for the glyph tile. */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
