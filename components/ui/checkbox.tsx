'use client';

import { Checkbox as CheckboxPrimitive } from '@base-ui-components/react/checkbox';
import { IconCheck } from '@tabler/icons-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Checkbox — Base UI primitive wrapped with shadcn-style classes.
 *
 * Base UI surface (vs Radix):
 *   - Root + Indicator map 1:1
 *   - State attributes: `data-checked` / `data-unchecked` (Radix used
 *     `data-[state=checked]` / `data-[state=unchecked]`).
 */
// Wrapper-side prop overrides:
//   - `checked` accepts `boolean | 'indeterminate'` for ergonomic
//     tri-state usage. Base UI's underlying primitive uses a separate
//     `indeterminate` boolean prop; we translate at the boundary so
//     consumers can write `checked={isAll ? true : isSome ? 'indeterminate' : false}`.
type CheckboxOwnProps = Omit<
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
  'checked'
> & {
  checked?: boolean | 'indeterminate';
};

export const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  CheckboxOwnProps
>(({ className, checked, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    checked={checked === 'indeterminate' ? false : checked}
    indeterminate={checked === 'indeterminate'}
    className={cn(
      // Base UI renders the Root as a <span> defaulting to `display: inline`;
      // force `inline-flex` so the sizing utilities apply and the box
      // centers its indicator children.
      //
      // Resting state matches the other field controls (Input/Textarea/Select):
      // `border-input` + `bg-background`. The brand color is reserved for
      // the *selected* state — checked flips border + fill to primary so the
      // affordance reads as "active." Disabled inherits opacity-50 in both
      // checked and unchecked states.
      // `cursor-pointer` here rather than inherited from an ancestor, and this one IS a
      // repair. Base UI renders the Root as a `<span>`, which — unlike `<button>` and
      // `<input>`, both of which the UA stylesheet pins to `cursor: default` — inherits.
      // Every selection tick inside a DataTable was taking its pointer from the row's
      // `cursor-pointer`, so gating that on `onRowClick` would have left the checkboxes on
      // the selectable-but-not-clickable tables with an arrow. `disabled:cursor-not-allowed`
      // below still wins: `:disabled` is the more specific selector.
      'peer inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-input bg-background',
      'ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <IconCheck className="h-4 w-4" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = 'Checkbox';
