'use client';

/**
 * ColorInput — the canonical color picker control across forms.
 *
 * Anatomy: [swatch] [format-toggle] [text input] [alpha %] where:
 *   - swatch: native `<input type="color">` (6-digit hex; alpha preserved
 *     externally and reapplied after the native picker round-trip).
 *   - format-toggle: cycles HEX → RGB → HSL; the text input reformats
 *     the current color into the chosen syntax.
 *   - text input: editable CSS color string in the current format.
 *     Hex format uses the dedicated `<HexInput>` (strict digit
 *     sanitization); rgb/hsl use a plain text Input.
 *   - alpha %: optional number input (0–100). Hidden unless `showAlpha`
 *     is true; when present, alpha is encoded into the emitted value
 *     (e.g. `#RRGGBBAA` for hex, `rgba(…)` / `hsla(…)` for the others).
 *
 * Accepts and emits whatever format the user is currently editing — the
 * value is a CSS color string, so consumers don't have to know the
 * format ahead of time.
 */

import { useId, useState } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  type ColorFormat,
  detectFormat,
  formatColor,
  parseColor,
  toSwatchHex,
} from './color-utils';
import { HexInput, isValidHex } from './HexInput';

export interface ColorInputProps {
  id?: string;
  /** Any CSS color string: hex / rgb(a) / hsl(a). Empty/null is allowed. */
  value?: string | null;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  /** Show the alpha (opacity) input. Off by default. */
  showAlpha?: boolean;
  /** Show the HEX / RGB / HSL format toggle. On by default — set to
   *  `false` to lock the input to a single format. */
  showFormatToggle?: boolean;
  className?: string;
  'aria-label'?: string;
}

const FORMATS: ColorFormat[] = ['hex', 'rgb', 'hsl'];
const FORMAT_LABEL: Record<ColorFormat, string> = { hex: 'HEX', rgb: 'RGB', hsl: 'HSL' };

export function ColorInput({
  id: providedId,
  value,
  onValueChange,
  disabled,
  showAlpha,
  showFormatToggle = true,
  className,
  'aria-label': ariaLabel,
}: ColorInputProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const detected = detectFormat(value);
  // The active edit format is sticky once the user picks one — so
  // switching to RGB doesn't snap back to HEX every time the value
  // updates externally. Initial format follows the incoming value.
  const [format, setFormat] = useState<ColorFormat>(detected);
  /**
   * What the user has typed but not yet finished typing. `null` means "not editing", and
   * the field then shows the canonical rendering of `value`.
   *
   * This has to exist because a colour string is only forwardable once it is COMPLETE, and
   * a controlled input whose value comes from the rejected upstream state cannot be typed
   * into at all. Without a draft, typing `ff0000` went: `#f` (invalid, not emitted) → React
   * re-renders from the unchanged parent value → the `f` disappears. Every keystroke was
   * discarded independently, so the text field could not be used to enter a colour by hand
   * — in any format. Only the native swatch worked, which is presumably why it went
   * unnoticed.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const parsed = value ? parseColor(value) : null;
  const swatchValue = toSwatchHex(value);

  function emit(next: { r?: number; g?: number; b?: number; a?: number }, fmt: ColorFormat) {
    const base = parsed ?? { r: 0, g: 0, b: 0, a: 1 };
    const merged = { ...base, ...next };
    onValueChange?.(formatColor(merged, fmt));
  }

  function handleSwatchChange(hex: string) {
    const rgba = parseColor(hex);
    if (!rgba) return;
    emit({ r: rgba.r, g: rgba.g, b: rgba.b }, format);
  }

  function handleTextChange(raw: string) {
    // Keep what was typed on screen regardless — the field belongs to the user while they
    // are in it. Only a COMPLETE colour goes upstream, so a partial value never clobbers
    // the caller's state mid-edit.
    setDraft(raw);
    if (format === 'hex') {
      if (raw === '' || isValidHex(raw)) onValueChange?.(raw);
      return;
    }
    const rgba = parseColor(raw);
    if (!rgba) return;
    onValueChange?.(raw);
  }

  /** Hand the field back: drop the draft so the canonical rendering takes over. */
  function handleTextBlur() {
    setDraft(null);
  }

  function handleAlphaChange(percent: number) {
    const a = Math.min(100, Math.max(0, percent)) / 100;
    emit({ a }, format);
  }

  function changeFormat(next: ColorFormat) {
    setFormat(next);
    // No `setDraft(null)` here. A draft written in the old syntax must not survive into the
    // new one, but reaching this toggle requires clicking it, which blurs the text field
    // and clears the draft on the way. An explicit reset here is unreachable — mutation
    // testing confirms removing it changes nothing — and would read as the thing
    // responsible for a behaviour it does not cause.
    // Re-emit the current color in the new format so the value the
    // caller sees matches what the input shows.
    if (parsed) onValueChange?.(formatColor(parsed, next));
  }

  // Displayed text mirrors the current format. We render whatever the
  // parsed value is in that format — empty when input is unparseable.
  // A live draft wins: while the user is typing, the field shows what they typed rather
  // than a canonicalised version of the last value that happened to parse.
  const canonicalText = parsed ? formatColor(parsed, format) : (value ?? '');
  const displayedText = draft ?? canonicalText;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <input
        type="color"
        id={id}
        value={swatchValue}
        disabled={disabled}
        onChange={(e) => handleSwatchChange(e.target.value)}
        className="h-9 w-12 cursor-pointer rounded-md border border-input bg-background p-1 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={ariaLabel ?? 'Color swatch'}
      />
      {showFormatToggle && (
        <Select
          value={format}
          onValueChange={(v: string) => v && changeFormat(v as ColorFormat)}
          disabled={disabled}
        >
          {/* Fixed width so the row layout doesn't twitch when toggling
              between three-letter labels. `h-10` matches the swatch and
              text input next to it. */}
          <SelectTrigger className="h-10 w-[5.5rem]" aria-label="Color format">
            {/* VeloExpense kit: Radix's <SelectValue> renders the chosen item's own
                label ("HEX"/"RGB"/"HSL"), so ExpenseOS's render-fn mapping for Base UI
                (which shows the raw value) is not needed. */}
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FORMATS.map((f) => (
              <SelectItem key={f} value={f}>
                {FORMAT_LABEL[f]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {format === 'hex' ? (
        <HexInput
          value={displayedText}
          disabled={disabled}
          onValueChange={handleTextChange}
          onBlur={handleTextBlur}
          className="flex-1"
          aria-label={ariaLabel ?? 'Color value'}
        />
      ) : (
        <Input
          type="text"
          value={displayedText}
          disabled={disabled}
          onChange={(e) => handleTextChange(e.target.value)}
          onBlur={handleTextBlur}
          placeholder={format === 'rgb' ? 'rgb(0, 0, 0)' : 'hsl(0, 0%, 0%)'}
          className="flex-1 font-mono"
          aria-label={ariaLabel ?? 'Color value'}
        />
      )}
      {showAlpha && (
        // VeloExpense kit: ExpenseOS's Input has a `suffix` slot; the kit's puts the "%" in an
        // InputGroup addon instead. Same field, same label, same rendered suffix.
        <InputGroup className="w-20">
          <InputGroupInput
            type="number"
            min={0}
            max={100}
            step={1}
            value={parsed ? Math.round(parsed.a * 100) : 100}
            disabled={disabled}
            onChange={(e) => handleAlphaChange(Number(e.target.value))}
            className="text-center [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            aria-label="Opacity"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText>%</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
      )}
    </div>
  );
}
