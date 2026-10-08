'use client';

/**
 * HexInput — a text Input restricted to hexadecimal color codes.
 *
 * Accepts `#RGB`, `#RGBA`, `#RRGGBB`, and `#RRGGBBAA`. Strips non-hex
 * characters as the user types and force-prefixes `#`, so the value
 * is always either empty or a syntactically valid hex string. Pair it
 * with whatever validation message the caller wants on the surrounding
 * Field.
 *
 * Used internally by ColorInput when its current format is `hex`, and
 * available standalone for callers that only want a hex code (e.g. a
 * theme builder restricted to brand-hex inputs).
 */

import type * as React from 'react';
import { useId } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

/** VeloExpense kit: the kit's Input takes the plain `<input>` props; ExpenseOS's `InputProps`
 *  added `prefix` / `suffix` slots, which this component already left out. */
type InputProps = React.ComponentProps<typeof Input>;

export interface HexInputProps
  extends Omit<InputProps, 'value' | 'onChange' | 'type' | 'prefix'> {
  /** Hex value, including the leading `#`. Empty string is allowed. */
  value?: string | null;
  onValueChange?: (value: string) => void;
}

// Strict hex check: `#` + 3, 4, 6, or 8 hex digits. Lengths 3/6 are
// RGB; 4/8 carry alpha in the last component.
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Returns true if `value` is a fully-typed valid hex color.
 * Intentionally exported so callers (ColorInput) can decide when the
 * value is safe to forward to other color machinery.
 */
export function isValidHex(value: string | null | undefined): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/** Coerce arbitrary text input toward a valid hex string. */
function sanitizeHexInput(raw: string): string {
  // Strip everything that isn't a hex digit, then re-prefix the `#`.
  // Cap at 8 digits so we never grow past `#RRGGBBAA`.
  const digits = raw.replace(/[^0-9a-fA-F]/g, '').slice(0, 8);
  return digits.length === 0 ? '' : `#${digits}`;
}

export function HexInput({
  id: providedId,
  value,
  onValueChange,
  className,
  ...props
}: HexInputProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  return (
    <Input
      id={id}
      type="text"
      inputMode="text"
      autoComplete="off"
      spellCheck={false}
      value={value ?? ''}
      placeholder="#000000"
      onChange={(e) => onValueChange?.(sanitizeHexInput(e.target.value))}
      className={cn('font-mono uppercase', className)}
      {...props}
    />
  );
}
