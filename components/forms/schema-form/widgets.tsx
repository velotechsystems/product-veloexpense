'use client';

/**
 * RJSF widgets backed by design-system primitives. Text-family inputs
 * (text/email/url/tel/number/password) are NOT here — they route through
 * BaseInputTemplate (see templates.tsx), so theming the template once covers
 * every text widget. These widgets cover the controls that need bespoke
 * rendering: select, boolean checkbox, textarea, radio group, multi-checkbox,
 * and color.
 */

import type { WidgetProps } from '@rjsf/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { DescriptionText } from '@/components/ui/description-text';
import { Radio, RadioGroup } from '@/components/ui/radio';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { ColorInput } from '../ColorInput';
import {
  type ExternalIdEntry,
  type ExternalIdSourceOption,
  ExternalIdsEditor,
  entriesFromMap,
  mapFromEntries,
} from '../ExternalIdsEditor';
import { MultiSelectDropdown } from '../MultiSelectDropdown';
import { NumberStepper } from '../NumberStepper';

type EnumOption = { value: string; label: string };

export function SelectWidget(props: WidgetProps) {
  const { id, value, disabled, readonly, onChange, options, placeholder } = props;
  const enumOptions = (options?.enumOptions ?? []) as EnumOption[];
  // Combobox is string-keyed; coerce enum values to strings for it and map
  // back to the original (possibly non-string) enum value on change.
  const items = enumOptions.map((o) => ({ value: String(o.value), label: o.label }));
  return (
    <Combobox
      id={id}
      items={items}
      value={value == null ? null : String(value)}
      onValueChange={(v) => {
        if (v == null) return onChange(undefined);
        const match = enumOptions.find((o) => String(o.value) === v);
        onChange(match ? match.value : v);
      }}
      placeholder={placeholder || 'Select…'}
      disabled={disabled || readonly}
    />
  );
}

/**
 * Boolean checkbox — just the box. FieldTemplate wraps this with the
 * canonical Field anatomy (label / required / description / tooltip /
 * errors) using `controlPosition='inline-leading'` so the checkbox
 * renders BEFORE the label text on a single row. All boolean-specific
 * chrome that used to live here moved to Field.
 */
export function CheckboxWidget(props: WidgetProps) {
  const { id, value, disabled, readonly, onChange, label } = props;
  return (
    <Checkbox
      id={id}
      // VeloExpense kit: Base UI's checkbox is a <span role="checkbox"> with an id of its
      // own, so the Field's <label for={id}> names nothing and the box was announced with
      // no name ("Active", "Reclaims ITCs" were silent to a screen reader). The schema
      // title names it directly. Found by VeloExpense's legal-entities e2e.
      aria-label={label || undefined}
      checked={value === true}
      disabled={disabled || readonly}
      onCheckedChange={(checked) => onChange(checked === true)}
    />
  );
}

export function TextareaWidget(props: WidgetProps) {
  const {
    id,
    value,
    required,
    disabled,
    readonly,
    onChange,
    onBlur,
    onFocus,
    placeholder,
    options,
  } = props;
  const rows = typeof options?.rows === 'number' ? options.rows : undefined;
  return (
    <Textarea
      id={id}
      value={value ?? ''}
      required={required}
      disabled={disabled || readonly}
      placeholder={placeholder}
      rows={rows}
      onChange={(e) => onChange(e.target.value === '' ? options.emptyValue : e.target.value)}
      onBlur={(e) => onBlur(id, e.target.value)}
      onFocus={(e) => onFocus(id, e.target.value)}
    />
  );
}

/**
 * Radio group. The group label / description / tooltip are surfaced by
 * FieldTemplate (above the group); per-option descriptions render under
 * each radio when the schema uses `oneOf` with `description` on each
 * branch (RJSF mirrors that onto `enumOptions[i].schema.description`).
 */
export function RadioWidget(props: WidgetProps) {
  const { id, value, disabled, readonly, onChange, options } = props;
  // `EnumOption` is the basic {value,label} shape; RJSF also attaches the
  // source schema for each option, which we read to surface per-option
  // descriptions.
  const enumOptions = (options?.enumOptions ?? []) as Array<
    EnumOption & { schema?: { description?: string } }
  >;
  const inline = options?.inline === true;
  const anyDescription = enumOptions.some((o) => o.schema?.description);
  return (
    <RadioGroup
      value={value ?? null}
      onValueChange={(v) => onChange(v ?? undefined)}
      disabled={disabled || readonly}
      orientation={inline ? 'horizontal' : 'vertical'}
      // Vertical groups get tighter spacing by default; widen when any
      // option has its own description so the two-line rows breathe.
      className={!inline && anyDescription ? 'space-y-2' : undefined}
    >
      {enumOptions.map((o) => {
        const optId = `${id}-${o.value}`;
        const desc = o.schema?.description;
        return (
          <label
            key={o.value}
            htmlFor={optId}
            className={`flex cursor-pointer gap-2 text-sm ${desc ? 'items-start' : 'items-center'}`}
          >
            <Radio id={optId} value={o.value} className={desc ? 'mt-0.5' : undefined} />
            <span className="flex flex-col">
              <span>{o.label}</span>
              {desc ? <DescriptionText>{desc}</DescriptionText> : null}
            </span>
          </label>
        );
      })}
    </RadioGroup>
  );
}

/**
 * Multi-select widget for enum arrays (`array + items.enum + uniqueItems`).
 * Thin RJSF adapter over the canonical <MultiSelectDropdown> — closed state
 * shows selected values as badge tags inside a field-styled trigger; open
 * state shows a searchable checkbox list with Select-all / Clear / Done.
 *
 * Exposed under two names in the widget registry:
 *   - `MultiSelectWidget`: the canonical, descriptive name.
 *   - `CheckboxesWidget`: RJSF's built-in slot name (kept so existing
 *     `'ui:widget': 'checkboxes'` directives keep working unchanged).
 */
export function MultiSelectWidget(props: WidgetProps) {
  const { id, value, disabled, readonly, onChange, options, placeholder } = props;
  const enumOptions = (options?.enumOptions ?? []) as EnumOption[];
  const items = enumOptions.map((o) => ({ value: String(o.value), label: o.label }));
  const selected: string[] = Array.isArray(value) ? value.map(String) : [];
  return (
    <MultiSelectDropdown
      id={id}
      items={items}
      value={selected}
      onValueChange={onChange}
      placeholder={placeholder ?? 'Select…'}
      disabled={Boolean(disabled || readonly)}
    />
  );
}
/** Backward-compatible alias under RJSF's legacy widget name. */
export const CheckboxesWidget = MultiSelectWidget;

/**
 * External-IDs map editor — thin RJSF adapter over the canonical
 * <ExternalIdsEditor>. Opt in by giving the schema property the
 * shape `{ type: 'object', additionalProperties: { type: 'string' } }`
 * and `'ui:widget': 'externalIds'`.
 *
 * The internal editor uses a row-list representation
 * (`ExternalIdEntry[]`) to preserve ordering + per-row id while the
 * user edits; this widget converts to/from the JSON-schema map shape
 * at the boundary so consumers get the canonical
 * `Record<string, string>` value.
 *
 * The systems offered in the row picker come through `'ui:options'.sources` — the
 * tenant's own `ExternalIdSource` rows, not a hardcoded list:
 *
 *   {
 *     externalIds: {
 *       'ui:widget': 'externalIds',
 *       'ui:options': { sources: [{ code: 'netsuite', label: 'NetSuite' }] },
 *     },
 *   }
 *
 * Localized labels (key/value placeholders, add/remove button text)
 * come from `'ui:options'.labels`, mirroring the editor's prop shape
 * so the host app can pipe i18n strings in directly.
 */
export function ExternalIdsWidget(props: WidgetProps) {
  const { value, disabled, readonly, onChange, options } = props;
  const sources = (options?.sources ?? []) as readonly ExternalIdSourceOption[];
  const labelOverrides = (options?.labels ?? {}) as Partial<{
    key: string;
    value: string;
    addRow: string;
    removeRow: string;
    help: string;
    other: string;
  }>;
  const labels = {
    key: labelOverrides.key ?? 'System',
    value: labelOverrides.value ?? 'External ID',
    addRow: labelOverrides.addRow ?? 'Add row',
    removeRow: labelOverrides.removeRow ?? 'Remove row',
    help: labelOverrides.help ?? '',
    other: labelOverrides.other,
  };
  // Mirror the editor's row-list shape into local state derived from
  // the incoming map. We re-derive on every render because the JSON
  // schema layer only knows the final map — the editor's row ids are
  // a UI concern that doesn't need to round-trip.
  const map = (
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {}
  ) satisfies Record<string, string>;
  const entries = entriesFromMap(map, sources);
  const handle = (next: ExternalIdEntry[]) => onChange(mapFromEntries(next));
  if (disabled || readonly) {
    // Render the editor but downstream Inputs honor `disabled`. The
    // editor doesn't accept a top-level disabled prop yet; for now,
    // the visual is the same and the JSON-schema layer prevents
    // writes via the surrounding form's `disabled` prop.
  }
  return (
    <ExternalIdsEditor entries={entries} onChange={handle} sources={sources} labels={labels} />
  );
}

/**
 * Color picker — thin RJSF adapter over the canonical <ColorInput>.
 */
export function ColorWidget(props: WidgetProps) {
  const { id, value, disabled, readonly, onChange } = props;
  return (
    <ColorInput
      id={id}
      value={value ?? ''}
      disabled={disabled || readonly}
      onValueChange={onChange}
    />
  );
}

/**
 * Range slider for bounded numeric fields. Renders a single-thumb
 * Slider for scalar number/integer schemas, or a two-thumb "between"
 * Slider when the schema is a tuple of two numbers (`type: 'array'`,
 * `minItems: 2`, `maxItems: 2`, `items: { type: 'number' }`). The
 * live value is shown alongside as tabular-numeric so the column
 * stays steady as the user drags.
 *
 * Opt in via `'ui:widget': 'range'`. Reads `minimum` / `maximum` /
 * `multipleOf` from the schema for bounds + step (defaults: 0 / 100
 * / 1).
 */
export function RangeWidget(props: WidgetProps) {
  const { id, value, disabled, readonly, onChange, schema } = props;
  const min = typeof schema.minimum === 'number' ? schema.minimum : 0;
  const max = typeof schema.maximum === 'number' ? schema.maximum : 100;
  const step = typeof schema.multipleOf === 'number' ? schema.multipleOf : 1;
  const isBetween = schema.type === 'array';

  if (isBetween) {
    // Two-thumb "between" range. Value is `[lo, hi]`; Slider keeps the
    // thumbs ordered automatically. Both bounds clamp to min/max.
    const tuple: [number, number] = Array.isArray(value)
      ? [
          Number.isFinite(Number(value[0])) ? Number(value[0]) : min,
          Number.isFinite(Number(value[1])) ? Number(value[1]) : max,
        ]
      : [min, max];
    return (
      <div className="flex items-center gap-3">
        <span className="min-w-[3ch] text-left font-mono text-foreground text-sm tabular-nums">
          {tuple[0]}
        </span>
        <Slider
          value={tuple}
          onValueChange={(v) => onChange(v)}
          min={min}
          max={max}
          step={step}
          disabled={disabled || readonly}
          className="flex-1"
          // eslint-disable-next-line jsx-a11y/aria-proptypes -- VeloExpense kit: Base UI's Slider takes one label per thumb
          aria-label={['Lower bound', 'Upper bound']}
        />
        <span className="min-w-[3ch] text-right font-mono text-foreground text-sm tabular-nums">
          {tuple[1]}
        </span>
      </div>
    );
  }

  const num = typeof value === 'number' ? value : Number(value ?? min);
  return (
    <div className="flex items-center gap-3">
      <Slider
        value={Number.isFinite(num) ? num : min}
        onValueChange={(v) => onChange(v)}
        min={min}
        max={max}
        step={step}
        disabled={disabled || readonly}
        className="flex-1"
        aria-label={schema.title ?? 'Value'}
      />
      <span
        id={id ? undefined : undefined}
        className="min-w-[3ch] text-right font-mono text-foreground text-sm tabular-nums"
      >
        {Number.isFinite(num) ? num : min}
      </span>
    </div>
  );
}

/**
 * Stepper for bounded numbers — thin RJSF adapter over <NumberStepper>.
 * Opt in via `'ui:widget': 'updown'` on a number/integer field. Reads
 * `minimum` / `maximum` / `multipleOf` from the schema for bounds + step.
 */
export function UpDownWidget(props: WidgetProps) {
  const { id, value, disabled, readonly, required, onChange, schema } = props;
  const min = typeof schema.minimum === 'number' ? schema.minimum : undefined;
  const max = typeof schema.maximum === 'number' ? schema.maximum : undefined;
  const step = typeof schema.multipleOf === 'number' ? schema.multipleOf : 1;
  const num =
    typeof value === 'number' ? value : value === '' || value == null ? undefined : Number(value);
  return (
    <NumberStepper
      id={id}
      value={num}
      onValueChange={(v) => onChange(v ?? undefined)}
      min={min}
      max={max}
      step={step}
      disabled={disabled || readonly}
      required={required}
    />
  );
}

export const widgets = {
  SelectWidget,
  CheckboxWidget,
  TextareaWidget,
  RadioWidget,
  // Same widget registered under both names — `MultiSelectWidget` is
  // the canonical alias; `CheckboxesWidget` preserves RJSF's legacy
  // `'ui:widget': 'checkboxes'` slot.
  MultiSelectWidget,
  CheckboxesWidget,
  ColorWidget,
  ExternalIdsWidget,
  // Numeric widgets. The slider (`range`) is the explicit opt-in for
  // numbers that benefit from a visual drag affordance; `updown` is
  // the explicit opt-in for the stepper, though bounded numbers
  // (min/max declared) auto-promote to it via BaseInputTemplate.
  RangeWidget,
  UpDownWidget,
  // Lowercase aliases so `'ui:widget': '<name>'` resolves regardless
  // of schema type. RJSF's built-in widgetMap covers limited
  // type-specific slots; explicit lowercase registration ensures the
  // string-key path matches.
  range: RangeWidget,
  externalIds: ExternalIdsWidget,
};
