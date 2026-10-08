'use client';

/**
 * NumberStepper — the canonical bounded-number control.
 *
 * A number Input flanked by explicit minus / plus buttons OUTSIDE the
 * field. The native browser spinner is hidden (WebKit + Firefox), and
 * the prefix / suffix slots on the underlying Input are left untouched
 * so callers can still pass `prefix="$"` or `suffix="%"` without
 * fighting the stepper for space.
 *
 * Used directly for hand-built bounded-number fields and indirectly via
 * the RJSF UpDownWidget (`ui:widget: 'updown'`).
 */

import { useId } from 'react';
import { IconMinus, IconPlus } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Tooltip } from './Tooltip';

export interface NumberStepperProps {
  id?: string;
  value?: number | null;
  onValueChange?: (value: number | undefined) => void;
  min?: number;
  max?: number;
  /** Increment per step. Defaults to 1. */
  step?: number;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  /** Slot rendered inside the Input's left side (e.g. "$"). Unrelated
   *  to the stepper buttons, which live outside the field. */
  prefix?: React.ReactNode;
  /** Slot rendered inside the Input's right side (e.g. "%"). */
  suffix?: React.ReactNode;
  className?: string;
  'aria-label'?: string;
}

export function NumberStepper({
  id: providedId,
  value,
  onValueChange,
  min,
  max,
  step = 1,
  disabled,
  required,
  placeholder,
  prefix,
  suffix,
  className,
  'aria-label': ariaLabel,
}: NumberStepperProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const num = typeof value === 'number' ? value : undefined;
  // Baseline for the next step when the field is empty — the lower bound if there is one,
  // otherwise 0. So on an empty 1..5 field, "−" lands on 1 and "+" on 2; every value in
  // range stays reachable by clicking.
  const baseline = num ?? min ?? 0;
  const clamp = (n: number) =>
    Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n));
  /**
   * A bound is only "reached" once there is a VALUE sitting on it.
   *
   * These used to read `(num ?? min) <= min` and `(num ?? max) >= max`, which substituted
   * the bound itself when the field was empty — so an empty field counted as sitting on
   * BOTH bounds at once and disabled BOTH buttons. Any field with a min and a max and no
   * value yet was therefore un-steppable: a 1..5 rating or a 0..10 count opened dead, and
   * the only way to enter anything was to type it. Exactly the widgets this control exists
   * for.
   */
  const atMin = num != null && typeof min === 'number' && num <= min;
  const atMax = num != null && typeof max === 'number' && num >= max;

  // ± buttons match the Input border (neutral) rather than the primary
  // brand color — they're affordance scaffolding around the field, not
  // an action call-to-action.
  const stepperBtn = cn(
    'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md',
    'border border-input bg-background text-foreground',
    'hover:bg-muted',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background',
  );
  const decLabel = `Decrease by ${step}`;
  const incLabel = `Increase by ${step}`;
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      {/* `asChild` attaches the tooltip behavior to our <button> directly.
          Without it, the Tooltip would wrap the button in its own
          <button> trigger — yielding nested buttons (invalid HTML). */}
      <Tooltip content={decLabel} asChild>
        <button
          type="button"
          disabled={disabled || atMin}
          onClick={() => onValueChange?.(clamp(baseline - step))}
          aria-label={decLabel}
          className={stepperBtn}
        >
          <IconMinus size={16} />
        </button>
      </Tooltip>
      {/* VeloExpense kit: ExpenseOS's Input has `prefix` / `suffix` slots; the kit's puts them
          in InputGroup addons. Without either, it is the plain Input, as before. */}
      {prefix != null || suffix != null ? (
        <InputGroup className="flex-1">
          {prefix != null && (
            <InputGroupAddon>
              <InputGroupText>{prefix}</InputGroupText>
            </InputGroupAddon>
          )}
          <InputGroupInput
            id={id}
            type="number"
            value={value ?? ''}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            required={required}
            placeholder={placeholder}
            aria-label={ariaLabel}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') return onValueChange?.(undefined);
              const n = Number(raw);
              onValueChange?.(Number.isNaN(n) ? undefined : n);
            }}
            // Hide the browser's native spinner — our explicit −/+ buttons
            // replace it. Pattern works across WebKit (Chrome/Safari) and
            // Firefox (where number inputs default to type=textfield via
            // -moz-appearance).
            className="text-center [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          {suffix != null && (
            <InputGroupAddon align="inline-end">
              <InputGroupText>{suffix}</InputGroupText>
            </InputGroupAddon>
          )}
        </InputGroup>
      ) : (
        <Input
          id={id}
          type="number"
          value={value ?? ''}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          required={required}
          placeholder={placeholder}
          aria-label={ariaLabel}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onValueChange?.(undefined);
            const n = Number(raw);
            onValueChange?.(Number.isNaN(n) ? undefined : n);
          }}
          // Hide the browser's native spinner — our explicit −/+ buttons
          // replace it. Pattern works across WebKit (Chrome/Safari) and
          // Firefox (where number inputs default to type=textfield via
          // -moz-appearance).
          className="text-center [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      )}
      <Tooltip content={incLabel} asChild>
        <button
          type="button"
          disabled={disabled || atMax}
          onClick={() => onValueChange?.(clamp(baseline + step))}
          aria-label={incLabel}
          className={stepperBtn}
        >
          <IconPlus size={16} />
        </button>
      </Tooltip>
    </div>
  );
}
