'use client';

import { IconPlus, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cls } from '../data-table/helpers';
import { DATE_PRESETS, LAST_N_DAYS_PREFIX, parseLastNDays, resolveDateFilter } from './dateFilter';
import {
  DEFAULT_FILTER_LABELS,
  type FacetOption,
  type FieldKind,
  type FilterClause,
  type FilterLabels,
  type FilterOp,
  OPS_BY_KIND,
  VALUELESS_OPS,
} from './types';

const CUSTOM_DAYS = '__customDays__';

/** Default value to seed when a date op is selected (the `within` editor opens
 *  on a preset; absolute/range ops start blank for the user to pick). */
const defaultDateValue = (op: FilterOp) => (op === 'within' ? 'last30' : '');

/** A date clause is ready to apply once it resolves to at least one bound. */
const dateClauseReady = (op: FilterOp, value: string) => {
  const w = resolveDateFilter(op, value, new Date());
  return w.gte !== undefined || w.lt !== undefined;
};

/**
 * Value editor for `'date'`-kind clauses. The op (chosen in the surrounding
 * op menu) decides the control: a preset dropdown for `within` (with a "Last N
 * days" custom branch), two date inputs for `between`, one for on/before/after.
 */
function DateFilterValue({
  op,
  value,
  onChange,
  labels = DEFAULT_FILTER_LABELS,
}: {
  op: FilterOp;
  value: string;
  onChange: (value: string) => void;
  labels?: FilterLabels;
}) {
  const inputCls =
    'rounded border border-primary bg-card px-1 py-0.5 text-foreground text-xs outline-none';

  if (op === 'within') {
    const customN = parseLastNDays(value);
    const isCustom = customN !== null;
    return (
      <span className="inline-flex items-center gap-1">
        <select
          value={isCustom ? CUSTOM_DAYS : value}
          onChange={(e) =>
            onChange(e.target.value === CUSTOM_DAYS ? `${LAST_N_DAYS_PREFIX}7` : e.target.value)
          }
          className={inputCls}
        >
          {DATE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value={CUSTOM_DAYS}>{labels.lastNDays}</option>
        </select>
        {isCustom && (
          <span className="inline-flex items-center gap-1">
            <input
              type="number"
              min={1}
              value={customN}
              onChange={(e) =>
                onChange(`${LAST_N_DAYS_PREFIX}${Math.max(1, Number(e.target.value) || 1)}`)
              }
              className={cls(inputCls, 'w-14')}
            />
            <span className="text-[10px] text-muted-foreground">days</span>
          </span>
        )}
      </span>
    );
  }

  if (op === 'between') {
    const [from = '', to = ''] = value.split('..');
    return (
      <span className="inline-flex items-center gap-1">
        <input
          type="date"
          value={from}
          onChange={(e) => onChange(`${e.target.value}..${to}`)}
          className={inputCls}
        />
        <span className="text-[10px] text-muted-foreground">→</span>
        <input
          type="date"
          value={to}
          onChange={(e) => onChange(`${from}..${e.target.value}`)}
          className={inputCls}
        />
      </span>
    );
  }

  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={inputCls}
    />
  );
}

/**
 * One block per (field, op). Field name bold, operator as a word
 * (clickable to switch), values as inner pills (each removable; the
 * group is joined by `or`). Trailing X removes the whole block.
 */
export function FilterBlock<F extends string>({
  field,
  fieldKind,
  op,
  fieldLabel,
  clauses,
  options,
  onOpChange,
  onValueChange,
  onRemoveValue,
  onRemoveBlock,
  onAddValue,
  labels = DEFAULT_FILTER_LABELS,
}: {
  field: F;
  fieldKind: FieldKind;
  op: FilterOp;
  fieldLabel: string;
  clauses: FilterClause<F>[];
  options: FacetOption[];
  onOpChange: (op: FilterOp) => void;
  onValueChange: (id: string, value: string) => void;
  onRemoveValue: (id: string) => void;
  onRemoveBlock: () => void;
  onAddValue: (value: string) => void;
  /** Localized chrome copy. Defaults to English so existing callers are unchanged. */
  labels?: FilterLabels;
}) {
  const [opMenuOpen, setOpMenuOpen] = useState(false);
  const [addingValue, setAddingValue] = useState(false);
  const [newValue, setNewValue] = useState('');
  const [editingValueId, setEditingValueId] = useState<string | null>(null);
  const ops = OPS_BY_KIND[fieldKind];
  const isTextOp =
    op === 'contains' || op === 'doesNotContain' || op === 'startsWith' || op === 'endsWith';
  const isValueless = VALUELESS_OPS.has(op);
  const isDate = fieldKind === 'date';

  const labelFor = (val: string) => options.find((o) => o.value === val)?.label ?? val;
  const usedValues = new Set(clauses.map((c) => c.value));
  const availableEnumOptions = options.filter((o) => !usedValues.has(o.value));

  const commitNewValue = () => {
    const v = newValue.trim();
    if (!v) return;
    onAddValue(v);
    setNewValue('');
    setAddingValue(false);
  };

  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-xs">
      <span className="font-bold text-foreground">{fieldLabel}</span>

      {/* Portaled (via Popover) rather than absolutely positioned: the pill bar
          is a horizontally scrollable strip, and `overflow-x` also clips
          vertically — an absolute panel was cut off at the strip's edge. */}
      <Popover open={opMenuOpen} onOpenChange={setOpMenuOpen}>
        <PopoverTrigger
          title="Change operator"
          className={cls(
            'rounded px-1 font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
            (op === 'doesNotEqual' || op === 'doesNotContain') && 'text-destructive',
          )}
        >
          {labels.ops[op]}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="max-h-[min(60vh,20rem)] min-w-[160px] overflow-y-auto p-1"
        >
          {ops.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => {
                onOpChange(o);
                setOpMenuOpen(false);
              }}
              className={cls(
                'flex w-full items-center justify-between gap-2 rounded px-3 py-1.5 text-left text-xs hover:bg-muted',
                o === op && 'font-semibold text-primary',
              )}
            >
              <span>{labels.ops[o]}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {isDate && clauses[0] && (
        <DateFilterValue
          op={op}
          value={clauses[0].value}
          onChange={(v) => onValueChange(clauses[0]?.id ?? '', v)}
        />
      )}

      {!isValueless &&
        !isDate &&
        clauses.map((c, idx) => (
          <span key={c.id} className="inline-flex items-center">
            {idx > 0 && <span className="mr-1 text-[10px] text-muted-foreground">or</span>}
            {editingValueId === c.id && isTextOp ? (
              <input
                value={c.value}
                onChange={(e) => onValueChange(c.id, e.target.value)}
                onBlur={() => setEditingValueId(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') setEditingValueId(null);
                }}
                className="w-24 rounded border border-primary bg-card px-1 py-0.5 text-foreground text-xs outline-none"
              />
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-foreground">
                <button
                  type="button"
                  onClick={() => isTextOp && setEditingValueId(c.id)}
                  className={cls('max-w-[140px] truncate', isTextOp && 'hover:underline')}
                  title={isTextOp ? 'Click to edit' : undefined}
                >
                  {labelFor(c.value) || <span className="text-muted-foreground italic">empty</span>}
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveValue(c.id)}
                  aria-label={labels.removeValue}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <IconX size={10} />
                </button>
              </span>
            )}
          </span>
        ))}

      {!isValueless && !isDate && addingValue ? (
        <span className="inline-flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">or</span>
          {fieldKind === 'enum' && !isTextOp ? (
            <select
              value={newValue}
              onChange={(e) => {
                setNewValue(e.target.value);
                if (e.target.value) {
                  onAddValue(e.target.value);
                  setNewValue('');
                  setAddingValue(false);
                }
              }}
              onBlur={() => setAddingValue(false)}
              className="rounded border border-primary bg-card px-1 py-0.5 text-foreground text-xs outline-none"
            >
              <option value="">— pick —</option>
              {availableEnumOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onBlur={commitNewValue}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNewValue();
                if (e.key === 'Escape') {
                  setNewValue('');
                  setAddingValue(false);
                }
              }}
              placeholder={labels.valuePlaceholder}
              list={`block-list-${field}`}
              className="w-24 rounded border border-primary bg-card px-1 py-0.5 text-foreground text-xs outline-none"
            />
          )}
          {fieldKind === 'text' && (
            // `value={o.label}`, NOT `o.value`. A text filter is matched by the
            // server against the human string, and facet options are routinely
            // id-keyed (`{ value: bu.id, label: 'Finance' }`) — suggesting
            // `o.value` put a raw UUID in the box and in the resulting pill.
            <datalist id={`block-list-${field}`}>
              {availableEnumOptions.map((o) => (
                <option key={o.value} value={o.label} />
              ))}
            </datalist>
          )}
        </span>
      ) : !isValueless && !isDate ? (
        <button
          type="button"
          onClick={() => setAddingValue(true)}
          aria-label={labels.addValue}
          className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={labels.addAnotherValue}
        >
          <IconPlus size={11} />
        </button>
      ) : null}

      <button
        type="button"
        onClick={onRemoveBlock}
        aria-label={labels.removeCondition}
        className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      >
        <IconX size={12} />
      </button>
    </span>
  );
}

/** "+ Add filter" dashed pill that opens a small form to add a new
 *  (field, op, value) clause. */
export function AddFilterPill<F extends string>({
  fields,
  fieldKinds,
  facetLabels,
  facetOptions,
  onAdd,
  labels = DEFAULT_FILTER_LABELS,
}: {
  fields: F[];
  fieldKinds: Record<F, FieldKind>;
  facetLabels: Record<F, string>;
  facetOptions: Record<F, FacetOption[]>;
  onAdd: (field: F, op: FilterOp, value: string) => void;
  /** Localized chrome copy. Defaults to English so existing callers are unchanged. */
  labels?: FilterLabels;
}) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<F>(fields[0] as F);
  // Default op follows the initial field's kind (text → contains, enum →
  // equals, date → within) — the same rule applied on field change below.
  const [op, setOp] = useState<FilterOp>(
    () => OPS_BY_KIND[fieldKinds[fields[0] as F]]?.[0] ?? 'equals',
  );
  const [value, setValue] = useState('');
  const kind = fieldKinds[field];
  const ops = OPS_BY_KIND[kind];
  const enumOptions = facetOptions[field] ?? [];
  const isTextOp =
    op === 'contains' || op === 'doesNotContain' || op === 'startsWith' || op === 'endsWith';
  const isDate = kind === 'date';

  const isValueless = VALUELESS_OPS.has(op);
  const canApply = isValueless
    ? true
    : isDate
      ? dateClauseReady(op, value)
      : value.trim().length > 0;
  const commit = () => {
    if (!canApply) return;
    onAdd(field, op, isValueless ? '' : isDate ? value : value.trim());
    setValue('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Portaled: the pill bar scrolls horizontally, and `overflow-x` clips
          vertically too, so an absolutely-positioned panel was cut off by the
          strip (and by the table shell below it). `PopoverContent` positions
          against the viewport, so the whole form is always visible. */}
      <PopoverTrigger className="inline-flex h-6 items-center rounded-md border border-input bg-background px-2 text-foreground text-xs hover:bg-muted">
        <IconPlus size={12} className="mr-1" />
        {labels.addFilter}
      </PopoverTrigger>
      {open && (
        <PopoverContent
          align="end"
          className="max-h-[min(70vh,28rem)] w-[min(18rem,calc(100vw-2rem))] overflow-y-auto p-2"
        >
          <div className="space-y-2">
            <label className="block font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
              {labels.field}
              <select
                value={field}
                onChange={(e) => {
                  const f = e.target.value as F;
                  setField(f);
                  const nextOp = OPS_BY_KIND[fieldKinds[f]][0];
                  if (nextOp) setOp(nextOp);
                  setValue(fieldKinds[f] === 'date' && nextOp ? defaultDateValue(nextOp) : '');
                }}
                className="mt-1 w-full rounded border border-input bg-card px-2 py-1 text-foreground text-sm"
              >
                {fields.map((f) => (
                  <option key={f} value={f}>
                    {facetLabels[f]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
              {labels.operator}
              <select
                value={op}
                onChange={(e) => {
                  const o = e.target.value as FilterOp;
                  setOp(o);
                  if (isDate) setValue(defaultDateValue(o));
                }}
                className="mt-1 w-full rounded border border-input bg-card px-2 py-1 text-foreground text-sm"
              >
                {ops.map((o) => (
                  <option key={o} value={o}>
                    {labels.ops[o]}
                  </option>
                ))}
              </select>
            </label>
            {!isValueless && (
              // biome-ignore lint/a11y/noLabelWithoutControl: both ternary branches below render a control (select or input)
              <label className="block font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
                {labels.value}
                {isDate ? (
                  <div className="mt-1">
                    <DateFilterValue op={op} value={value} onChange={setValue} labels={labels} />
                  </div>
                ) : kind === 'enum' && !isTextOp ? (
                  <select
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="mt-1 w-full rounded border border-input bg-card px-2 py-1 text-foreground text-sm"
                  >
                    <option value="">— pick a value —</option>
                    {enumOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commit();
                    }}
                    placeholder={isTextOp ? labels.typeAValue : labels.typeOrPick}
                    list={`addf-list-${field}`}
                    className="mt-1 w-full rounded border border-input bg-card px-2 py-1 text-foreground text-sm"
                  />
                )}
                {kind === 'text' && (
                  // The label, not the id — see the note on the sibling
                  // datalist in FilterBlock.
                  <datalist id={`addf-list-${field}`}>
                    {enumOptions.map((o) => (
                      <option key={o.value} value={o.label} />
                    ))}
                  </datalist>
                )}
              </label>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded px-2 py-1 text-muted-foreground text-xs hover:bg-muted"
              >
                {labels.cancel}
              </button>
              <button
                type="button"
                onClick={commit}
                disabled={!canApply}
                className="rounded bg-primary px-3 py-1 font-semibold text-primary-foreground text-xs disabled:opacity-50"
              >
                {labels.add}
              </button>
            </div>
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}
