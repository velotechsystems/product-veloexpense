import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Field — a composition layer for form rows, modelled on shadcn/ui's standalone
 * Field family (NOT the react-hook-form `Form` wrapper). Hook-free, so it renders
 * inside async Server Components and plain server-action `<form action={…}>`
 * forms, which is how VeloLedger and VeloExpense build forms.
 *
 * Same API as VeloLedger's `components/ui/field.tsx`, where it was proven. That
 * version wraps VeloLedger's legacy `vl-field` / `vl-label` CSS classes, which
 * no other app has; this one expresses the same layout with Tailwind utilities
 * on the shared tokens, so it works in any app that imports the token layer.
 *
 * Labels associate with controls via explicit `htmlFor` / `id`. `FieldError`
 * renders nothing when it has no children, so it can sit in the markup ahead of
 * any per-field validation state.
 */

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-group" className={cn("grid gap-4", className)} {...props} />;
}

function Field({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<"div"> & { orientation?: "vertical" | "horizontal" }) {
  return (
    <div
      data-slot="field"
      data-orientation={orientation}
      className={cn(
        "flex gap-1.5",
        orientation === "horizontal" ? "flex-row items-center gap-3" : "flex-col",
        className,
      )}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="field-label"
      className={cn("text-sm font-medium text-foreground", className)}
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: React.ComponentProps<"small">) {
  return (
    <small
      data-slot="field-description"
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function FieldError({ className, children, ...props }: React.ComponentProps<"small">) {
  if (children === null || children === undefined || children === false || children === "") return null;
  return (
    <small
      data-slot="field-error"
      role="alert"
      className={cn("block text-xs text-destructive", className)}
      {...props}
    >
      {children}
    </small>
  );
}

function FieldSeparator({ className, ...props }: React.ComponentProps<"hr">) {
  return <hr data-slot="field-separator" className={cn("my-2 border-border", className)} {...props} />;
}

export { Field, FieldGroup, FieldLabel, FieldDescription, FieldError, FieldSeparator };
