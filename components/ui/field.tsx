import * as React from "react";
import { cn } from "@/lib/utils";

/** Form field — docs/design-system.md §9. Label sits directly above the input. */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-label uppercase text-foreground">
        {label}
      </label>
      {children}
      {/* Errors take the negative status token, not --destructive: destructive
          means "this action destroys something", which a validation message
          is not (design-system.md §3). */}
      {error ? (
        <p className="text-caption text-negative" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-caption text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "min-h-tap-min rounded-md border border-input bg-card px-3 text-body text-foreground placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "min-h-tap-min rounded-md border border-input bg-card px-3 text-body text-foreground",
      className,
    )}
    {...props}
  />
));
Select.displayName = "Select";
