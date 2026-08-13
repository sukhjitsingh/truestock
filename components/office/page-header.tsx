import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The Part B page header — docs/plans/phase-2-ui-redesign/ui-spec-web.md §2.
 *
 * One shared component instead of five independent copies (the mechanism
 * that prevented `--header` drifting present-in-2-of-5, per `ui-audit.md`
 * P2.8). Applied to the five screens §2 names: catalog, counts list, count
 * summary, reorder, product edit.
 *
 * `breadcrumb` is a plain, non-button `<Link>` — it navigates, it never
 * edits, so it does not need button semantics (contrast the row-level Edit
 * control, which does). `action` is the primary action, right-aligned,
 * caller-supplied so this component stays agnostic to whether it's a
 * `<button>` or a `<Link>` styled as one.
 */
export function PageHeader({
  title,
  breadcrumb,
  pills,
  subtitle,
  action,
  className,
}: {
  title: string;
  breadcrumb?: { label: string; href: string };
  pills?: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {breadcrumb ? (
        <Link href={breadcrumb.href} className="w-fit text-caption text-muted-foreground underline">
          {breadcrumb.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-header-title">{title}</h1>
          {pills}
        </div>
        {action}
      </div>
      {subtitle}
    </div>
  );
}
