import { cn } from "@/lib/utils";

/**
 * The inverted header block — docs/design-system.md §9.
 *
 * Note the dark theme does NOT flip this to white. A full-brightness block at
 * the top of a phone in a dim bar is the "flashbulb in the face" failure
 * CLAUDE.md warns about, so `--header` stays a deep surface in dark and
 * identity comes from a thin accent rule rather than raw brightness. That is
 * handled entirely by the token — this component is theme-agnostic.
 */
export function DetailHeader({
  title,
  leading,
  trailing,
  pills,
  meta,
  className,
}: {
  title: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  pills?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "rounded-b-xl bg-header px-bar-pad pb-8 pt-6 text-header-foreground",
        className,
      )}
    >
      {leading || trailing ? (
        <div className="flex items-center justify-between">
          <div>{leading}</div>
          <div>{trailing}</div>
        </div>
      ) : null}
      <h1 className="mt-4 text-header-title">{title}</h1>
      {pills ? <div className="mt-3 flex flex-wrap items-center gap-2">{pills}</div> : null}
      {meta ? (
        <div className="mt-4 flex items-center gap-2 text-caption text-header-foreground/70">
          {meta}
        </div>
      ) : null}
    </header>
  );
}

/** Circular icon button sized for the header block's 44px hit area. */
export function HeaderIconButton({
  label,
  children,
  ...props
}: { label: string; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      className="flex size-11 items-center justify-center rounded-full border border-header-foreground/20"
      {...props}
    >
      {children}
    </button>
  );
}

/** A pill on the header block — outlined, inheriting the header foreground. */
export function HeaderPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-header-foreground/25 px-3 py-1 text-label uppercase">
      {children}
    </span>
  );
}
