'use client';

import { Radio as RadioPrimitive } from '@base-ui-components/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui-components/react/radio-group';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * RadioGroup + Radio — Base UI primitives wrapped with shadcn-style classes.
 * RadioGroup manages the selected value (`value` / `onValueChange`); each
 * Radio carries its option `value`.
 *
 * `orientation` defaults to `vertical` (radios stack with `space-y-1.5`
 * between them). Pass `orientation="horizontal"` for an inline row —
 * applies `flex gap-4` instead. The default vertical spacing came from
 * `space-y-1.5`, which uses sibling margin-top; in a flex-row layout
 * that margin extends the row's cross-axis size for every item except
 * the first, shifting the radios out of vertical alignment with each
 * other. The `horizontal` branch swaps to flex+gap so every item is
 * sized identically.
 */
type RadioGroupProps = React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive> & {
  orientation?: 'vertical' | 'horizontal';
};

export const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive>,
  RadioGroupProps
>(({ className, orientation = 'vertical', ...props }, ref) => (
  <RadioGroupPrimitive
    ref={ref}
    className={cn(
      orientation === 'horizontal' ? 'flex flex-wrap items-center gap-4' : 'space-y-1.5',
      className,
    )}
    {...props}
  />
));
RadioGroup.displayName = 'RadioGroup';

export const Radio = React.forwardRef<
  React.ElementRef<typeof RadioPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioPrimitive.Root
    ref={ref}
    className={cn(
      // Resting state matches the other field controls: `border-input` +
      // `bg-background`. Selecting flips the border to primary; the
      // indicator dot inside paints primary too. Disabled inherits
      // opacity-50 in both states.
      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-input bg-background',
      'ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[checked]:border-primary',
      className,
    )}
    {...props}
  >
    <RadioPrimitive.Indicator className="flex">
      <span className="h-2 w-2 rounded-full bg-primary" />
    </RadioPrimitive.Indicator>
  </RadioPrimitive.Root>
));
Radio.displayName = 'Radio';
