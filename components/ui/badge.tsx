import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap transition-colors [&_svg]:mr-1 [&_svg]:size-3 [&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        // KITAA-1: brand-700 ink, not primary. Primary on its own 10% tint is
        // 4.65:1 on white but 4.27:1 on the page background and 4.15:1 on
        // --muted (table headers) — under AA. brand-700 is 5.56:1 or better. Dark
        // keeps primary (stop 400), which is light enough on dark surfaces.
        default: "bg-primary/10 text-brand-700 dark:text-primary",
        secondary: "bg-secondary text-secondary-foreground",
        success: "bg-success/10 text-success",
        warning: "bg-warning/10 text-warning",
        destructive: "bg-destructive/10 text-destructive",
        muted: "bg-muted text-muted-foreground",
        outline: "border border-input text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
