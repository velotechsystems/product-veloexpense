'use client';

/**
 * Slider — Base UI Slider wrapped with shadcn-style classes.
 *
 * Accepts a single numeric value OR an array of numeric values:
 *   - Single value  → one thumb (e.g. brightness, volume).
 *   - Array value   → one thumb per entry (e.g. `[lo, hi]` price range).
 *
 * Shape mirrors the rest of our form primitives: pass `value` (raw
 * number or array), `onValueChange` (same shape), and the usual
 * `min` / `max` / `step` / `disabled`.
 */

import { Slider as SliderPrimitive } from '@base-ui-components/react/slider';
import { cn } from '@/lib/utils';

export interface SliderProps<TValue extends number | number[]> {
  value: TValue;
  defaultValue?: TValue;
  onValueChange?: (value: TValue) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  /** Accessible name for the slider (or label list for multi-thumb). */
  'aria-label'?: string | string[];
}

export function Slider<TValue extends number | number[]>({
  value,
  defaultValue,
  onValueChange,
  min,
  max,
  step,
  disabled,
  className,
  'aria-label': ariaLabel,
}: SliderProps<TValue>) {
  const thumbs = Array.isArray(value) ? value : [value];
  return (
    <SliderPrimitive.Root
      // Base UI types `value` loosely as number | number[] | readonly number[];
      // our generic narrows it to the caller's exact shape.
      value={value as unknown as number | number[]}
      defaultValue={defaultValue as unknown as number | number[] | undefined}
      onValueChange={(v) => onValueChange?.(v as TValue)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn('relative flex w-full touch-none select-none items-center', className)}
    >
      <SliderPrimitive.Control className="relative flex h-5 w-full items-center">
        <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-full bg-muted">
          <SliderPrimitive.Indicator className="absolute h-full bg-primary" />
        </SliderPrimitive.Track>
        {thumbs.map((_, i) => (
          <SliderPrimitive.Thumb
            // biome-ignore lint/suspicious/noArrayIndexKey: thumbs are positional
            key={i}
            index={i}
            aria-label={
              Array.isArray(ariaLabel)
                ? ariaLabel[i]
                : (ariaLabel ?? (thumbs.length > 1 ? `Value ${i + 1}` : 'Value'))
            }
            // `h-4 w-4` (16px) — small enough that the thumb at the
            // minimum position doesn't visually shift the slider start
            // away from the surrounding field's left edge (the 20px
            // thumb made the track appear inset).
            className="block h-4 w-4 rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
