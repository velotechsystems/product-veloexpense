'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Label — plain `<label>` styled to match shadcn's typography.
 *
 * Radix's `@radix-ui/react-label` only adds one behavior: clicking the
 * label focuses the associated control via the `for`/`htmlFor` attribute,
 * which is what a native `<label>` already does. We drop the dep and use
 * the platform element directly.
 */
export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  // biome-ignore lint/a11y/noLabelWithoutControl: generic wrapper — callers pass htmlFor or nest the control.
  <label
    ref={ref}
    className={cn(
      'font-medium text-sm leading-none',
      'peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className,
    )}
    {...props}
  />
));
Label.displayName = 'Label';
