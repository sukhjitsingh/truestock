import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Class strings come from docs/design-system.md §9 verbatim. That document is
 * literal spec, not a suggestion — extend it rather than adding a variant
 * inline here.
 *
 * Two size floors, both from §6: `tap` (44px) is the absolute minimum for
 * anything tappable anywhere in the app; `primary` (56px) is the floor for
 * controls on the count loop, which are used ~150 times per count by someone
 * holding a bottle in their other hand.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-label uppercase transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground",
        outline: "border border-input bg-transparent text-foreground",
        accent: "bg-accent text-accent-foreground",
        destructive: "bg-destructive text-destructive-foreground",
        ghost: "bg-transparent text-foreground",
      },
      size: {
        tap: "min-h-tap-min px-4",
        primary: "min-h-tap-primary px-4",
        icon: "size-11 shrink-0 rounded-full px-0",
      },
      full: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "primary", size: "tap", full: false },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, full, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, full }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { buttonVariants };
