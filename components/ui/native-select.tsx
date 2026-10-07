import * as React from "react";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A styled native <select> — the server-safe dropdown.
 *
 * Use it where the form must work with no client JavaScript: a GET filter form,
 * a server-action form in a server component. It posts its own value like any
 * <select>, keeps the platform's keyboard and screen-reader behaviour, and on a
 * phone opens the OS picker. Reach for the Radix `select` only where a custom
 * popup is the point and the component is already a client one.
 *
 * Styled to sit beside `input`: same height, border, radius, focus ring and
 * invalid state, with a chevron in place of the platform arrow. It fills its
 * column (`w-full`). In a dense table row give it a minimum (`className=
 * "min-w-36"`): a form control with a percentage width adds almost nothing to
 * its cell's minimum, so the table squeezes "Must be fixed" to "Must be f".
 */
function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <div
      data-slot="native-select-wrapper"
      className="group/native-select relative w-full has-[select:disabled]:opacity-50"
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          "h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent py-1 pr-8 pl-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=sm]:h-7 data-[size=sm]:text-xs md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&>option]:bg-popover [&>option]:text-popover-foreground",
          className,
        )}
        {...props}
      />
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground select-none"
      />
    </div>
  );
}

function NativeSelectOption(props: React.ComponentProps<"option">) {
  return <option data-slot="native-select-option" {...props} />;
}

function NativeSelectOptGroup(props: React.ComponentProps<"optgroup">) {
  return <optgroup data-slot="native-select-optgroup" {...props} />;
}

export { NativeSelect, NativeSelectOption, NativeSelectOptGroup };
