import { cn } from "@/lib/utils";

/**
 * Filter pill — docs/design-system.md §9,
 * docs/plans/phase-2-ui-redesign/ui-spec-web.md §1 "Filters".
 *
 * Applied = filled solid (`bg-primary`); unapplied = outline
 * (`border-input`, no fill). `aria-pressed` carries the real state — this is
 * a toggle, not a link.
 *
 * **Facet-named, not value-named — the one binding copy convention across
 * every filterable screen.** `children` must read "Category: Spirits" or
 * "Status: Active", never a bare value like "Full counts". The audit found
 * both conventions in different prototypes (P2.11); facet-naming wins
 * because it scales to filters this phase doesn't enumerate without
 * inventing a new copy pattern per screen. This component does not enforce
 * the string shape (it can't), only the visual contract — the convention is
 * on the caller.
 */
export function FilterPill({
  applied,
  children,
  className,
  ...props
}: {
  applied: boolean;
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      type="button"
      aria-pressed={applied}
      className={cn(
        "inline-flex h-9 items-center rounded-full px-3 text-label uppercase",
        applied ? "bg-primary text-primary-foreground" : "border border-input text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
