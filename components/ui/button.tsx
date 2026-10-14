import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // 2026 brand: soft-strong primary — stop 200 fill + stop 800 ink (6.6-6.9:1),
        // hover stop 300; dark = stop 400 + dark ink. Never white on a light fill.
        //
        // KITBTN-1: on a light card the soft fill at the base `disabled:opacity-50`
        // read the same as the enabled button (VeloPulse UI review, 2026-10-13:
        // Create cycle, Start, Compute, Approve). So, for this variant only:
        //   - enabled gets a stop-300 edge, so it holds its shape on white;
        //   - disabled drops the brand: a neutral muted fill and ink, still at the
        //     base 50% opacity. A faint grey button vs. a tinted one, rather than
        //     a faint tint vs. a tint. (Full-opacity grey was tried and read as an
        //     enabled secondary button.)
        default:
          "border-brand-300 bg-brand-button text-brand-on-button font-semibold hover:bg-brand-button-hover disabled:border-transparent disabled:bg-muted disabled:text-muted-foreground",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        // Ported from ExpenseOS (VeloExpense Wave 2): the outline siblings of `destructive` and
        // of a positive action. Red (or green) border and ink on a transparent fill, hover to a
        // faint tint of the same tone. For a destructive or affirmative action that should not
        // dominate the row — Reject and Approve on the expense-report workbench. Same ink as
        // `destructive` above and as the Badge's success tone (KITAA-1 tuned).
        "destructive-outline":
          "border-destructive bg-transparent text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/20",
        "success-outline":
          "border-success bg-transparent text-success hover:bg-success/10 dark:hover:bg-success/20",
        // text-brand-link, not text-primary: VeloJobs' primary is an amber fill too
        // light for text on white (2026 guidelines); every other product's link = primary.
        link: "text-brand-link underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
