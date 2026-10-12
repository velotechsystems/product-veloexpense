'use client';

import {
  PREDICATE_FIELDS,
  type Predicate,
  type PredicateField,
  type PredicateOp,
} from '@expenseos/approvals';
/**
 * Filter-toolbar-style condition editor bound to our Predicate AST. Renders a
 * mode chip (Always / Match ALL / Match ANY) plus one pill per leaf — field in
 * bold, operator as a clickable word, value(s) as inner pills — mirroring the
 * data-table FilterBlock look. Used for the workflow trigger condition (Settings
 * drawer) and the IF / Switch-case conditions (node config). `CriteriaPills`
 * is the read-only sibling the node bodies use to surface their configuration.
 */
import { Button } from '@expenseos/design-system';
import type { Locale } from '@expenseos/i18n/locales';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import {
  type EditorOptions,
  type FacetOption,
  FIELD_LABEL,
  fieldFacets,
  isNumericField,
  labelForValue,
  OP_LABEL,
  opsForField,
} from './options';
import { joinAnd, joinOr } from '@/lib/i18n/list';

type Leaf = { field: PredicateField; op: PredicateOp; value: number | string | string[] | null };
type Mode = 'always' | 'all' | 'any';

const isMultiOp = (op: PredicateOp) => op === 'in' || op === 'nin';

// ── Predicate <-> flat-leaves ────────────────────────────────────────────────

function isLeaf(p: Predicate): p is Leaf {
  return 'field' in p;
}
function decompose(pred: Predicate): { mode: Mode; leaves: Leaf[] } {
  if ('always' in pred) return { mode: 'always', leaves: [] };
  if ('all' in pred) return { mode: 'all', leaves: pred.all.filter(isLeaf) };
  if ('any' in pred) return { mode: 'any', leaves: pred.any.filter(isLeaf) };
  return { mode: 'all', leaves: [pred] };
}
/** Compact one-line summary of a predicate (used by node pills). */
export function summarizePredicate(
  pred: Predicate,
  options: EditorOptions | undefined,
  locale: Locale,
): string {
  if ('always' in pred) return 'always';
  // VeloExpense: the connecting word is the locale's (`joinAnd` / `joinOr`, lib/i18n/list.ts —
  // scripts/check-i18n.mjs refuses a hard-coded ' and '). In English three or more read
  // "A, B and C" where ExpenseOS writes "A and B and C".
  if ('all' in pred)
    return joinAnd(pred.all.map((p) => summarizePredicate(p, options, locale)), locale);
  if ('any' in pred)
    return joinOr(pred.any.map((p) => summarizePredicate(p, options, locale)), locale);
  const field = FIELD_LABEL[pred.field];
  const op = OP_LABEL[pred.op];
  const v = Array.isArray(pred.value)
    ? pred.value.map((x) => labelForValue(pred.field, x, options, locale)).join(', ')
    : pred.value == null || pred.value === ''
      ? '—'
      : labelForValue(pred.field, String(pred.value), options, locale);
  return `${field} ${op} ${v}`;
}

/** Coerce a leaf's value into the shape its (field, op) expects. */
function coerceValue(field: PredicateField, op: PredicateOp, prev: Leaf['value']): Leaf['value'] {
  if (isMultiOp(op))
    return Array.isArray(prev) ? prev : prev == null || prev === '' ? [] : [String(prev)];
  if (Array.isArray(prev)) return prev[0] ?? (isNumericField(field) ? 0 : '');
  if (isNumericField(field)) return typeof prev === 'number' ? prev : Number(prev) || 0;
  return prev == null ? '' : String(prev);
}

// ── Tiny inline dropdown (field / op pickers + value picker) ──────────────────

export function InlineMenu({
  label,
  options,
  onSelect,
  className,
  title,
}: {
  label: React.ReactNode;
  options: FacetOption[];
  onSelect: (value: string) => void;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        title={title}
        onClick={() => setOpen((o) => !o)}
        className={
          className ?? 'rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground'
        }
      >
        {label}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40"
          />
          <div className="absolute top-full left-0 z-50 mt-1 max-h-64 min-w-[160px] overflow-y-auto rounded-md border border-input bg-popover py-1 shadow-md">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onSelect(o.value);
                  setOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left text-xs hover:bg-muted"
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

// ── Value rendering ──────────────────────────────────────────────────────────

function ValuePill({ children, onRemove }: { children: React.ReactNode; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-foreground">
      <span className="max-w-[160px] truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove value"
          className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <IconX size={10} />
        </button>
      )}
    </span>
  );
}

function LeafValue({
  leaf,
  options,
  locale,
  readOnly,
  onChange,
}: {
  leaf: Leaf;
  options: EditorOptions | undefined;
  locale: Locale;
  readOnly?: boolean;
  onChange: (value: Leaf['value']) => void;
}) {
  const facets = fieldFacets(leaf.field, options, locale);
  const [editing, setEditing] = useState(false);

  // Multi-value (in / not-in): a pill per value + an add affordance.
  if (isMultiOp(leaf.op)) {
    const values = Array.isArray(leaf.value) ? leaf.value : [];
    const available = facets?.filter((f) => !values.includes(f.value)) ?? [];
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {values.length === 0 && (
          <span className="text-[10px] text-muted-foreground italic">any</span>
        )}
        {values.map((v, i) => (
          <span key={v} className="inline-flex items-center">
            {i > 0 && <span className="mr-1 text-[10px] text-muted-foreground">or</span>}
            <ValuePill
              onRemove={readOnly ? undefined : () => onChange(values.filter((x) => x !== v))}
            >
              {labelForValue(leaf.field, v, options, locale)}
            </ValuePill>
          </span>
        ))}
        {!readOnly &&
          (facets ? (
            available.length > 0 && (
              <InlineMenu
                label={<IconPlus size={11} />}
                title="Add value"
                options={available}
                onSelect={(v) => onChange([...values, v])}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              />
            )
          ) : (
            <AddRawValue onAdd={(v) => onChange([...values, v])} />
          ))}
      </span>
    );
  }

  // Single value.
  const single = leaf.value == null ? '' : String(leaf.value);
  if (readOnly) {
    return (
      <ValuePill>
        {single ? (
          labelForValue(leaf.field, single, options, locale)
        ) : (
          <span className="italic">—</span>
        )}
      </ValuePill>
    );
  }
  if (facets) {
    return (
      <InlineMenu
        label={
          <span className="rounded-full bg-muted px-2 py-0.5">
            {single ? labelForValue(leaf.field, single, options, locale) : 'pick…'}
          </span>
        }
        options={facets}
        onSelect={(v) => onChange(v)}
        className=""
      />
    );
  }
  if (editing) {
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: inline edit, focus is expected
        autoFocus
        defaultValue={single}
        inputMode={isNumericField(leaf.field) ? 'numeric' : 'text'}
        onBlur={(e) => {
          onChange(isNumericField(leaf.field) ? Number(e.target.value) || 0 : e.target.value);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
        }}
        className="w-24 rounded border border-primary bg-card px-1 py-0.5 text-foreground text-xs outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="rounded-full bg-muted px-2 py-0.5 hover:underline"
      title="Click to edit"
    >
      {single || <span className="text-muted-foreground italic">value…</span>}
    </button>
  );
}

function AddRawValue({ onAdd }: { onAdd: (v: string) => void }) {
  const [v, setV] = useState('');
  const commit = () => {
    const t = v.trim();
    if (t) onAdd(t);
    setV('');
  };
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      placeholder="add…"
      className="w-20 rounded border border-primary bg-card px-1 py-0.5 text-foreground text-xs outline-none"
    />
  );
}

// ── Leaf pill ────────────────────────────────────────────────────────────────

function LeafPill({
  leaf,
  fields = PREDICATE_FIELDS,
  options,
  locale,
  readOnly,
  bare,
  onChange,
  onRemove,
}: {
  leaf: Leaf;
  fields?: readonly PredicateField[];
  options: EditorOptions | undefined;
  locale: Locale;
  readOnly?: boolean;
  /** Drop the bordered-pill chrome (used inside a <fieldset> row). */
  bare?: boolean;
  onChange: (leaf: Leaf) => void;
  onRemove: () => void;
}) {
  const fieldOpts: FacetOption[] = fields.map((f) => ({
    value: f,
    label: FIELD_LABEL[f],
  }));
  // Operators are constrained to the field's type (item: a Department can't be
  // "greater than" — only equals / is any of, etc).
  const opOpts: FacetOption[] = opsForField(leaf.field).map((o) => ({
    value: o,
    label: OP_LABEL[o],
  }));
  const negated = leaf.op === 'neq' || leaf.op === 'nin';

  const content = (
    <>
      {readOnly ? (
        <span className="font-bold text-foreground">{FIELD_LABEL[leaf.field]}</span>
      ) : (
        <InlineMenu
          label={<span className="font-bold text-foreground">{FIELD_LABEL[leaf.field]}</span>}
          options={fieldOpts}
          title="Change field"
          onSelect={(f) => {
            const field = f as PredicateField;
            // Keep the operator only if it's valid for the new field's type.
            const ops = opsForField(field);
            const op = ops.includes(leaf.op) ? leaf.op : ops[0];
            onChange({ ...leaf, field, op, value: coerceValue(field, op, leaf.value) });
          }}
        />
      )}

      {readOnly ? (
        <span className={negated ? 'px-1 text-destructive' : 'px-1 text-muted-foreground'}>
          {OP_LABEL[leaf.op]}
        </span>
      ) : (
        <InlineMenu
          label={OP_LABEL[leaf.op]}
          options={opOpts}
          title="Change operator"
          className={
            negated
              ? 'rounded px-1 font-medium text-destructive hover:bg-muted'
              : 'rounded px-1 font-medium text-muted-foreground hover:bg-muted hover:text-foreground'
          }
          onSelect={(o) => {
            const op = o as PredicateOp;
            onChange({ ...leaf, op, value: coerceValue(leaf.field, op, leaf.value) });
          }}
        />
      )}

      <LeafValue
        leaf={leaf}
        options={options}
        locale={locale}
        readOnly={readOnly}
        onChange={(value) => onChange({ ...leaf, value })}
      />
    </>
  );

  // Editable (fieldset row): content wraps inside a flex-1 column; the remove
  // button stays pinned top-right and never wraps to its own line.
  if (bare) {
    return (
      <span className="flex w-full items-center gap-1.5 text-xs">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{content}</span>
        {!readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onRemove}
            aria-label="Remove condition"
            className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <IconX size={12} />
          </Button>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-xs">
      {content}
    </span>
  );
}

// ── ConditionBar ─────────────────────────────────────────────────────────────

export function ConditionBar({
  value,
  onChange,
  options,
  locale,
  allowAlways = true,
  fields = PREDICATE_FIELDS,
  hideTitle = false,
}: {
  value: Predicate;
  onChange: (p: Predicate) => void;
  options: EditorOptions | undefined;
  locale: Locale;
  /** Trigger conditions allow the "Always" catch-all; IF/Switch do not. */
  allowAlways?: boolean;
  /** Restrict the selectable fields (e.g. the approver-filter domain). */
  fields?: readonly PredicateField[];
  /** Hide the built-in "Conditions:" label (when a FormField already labels it). */
  hideTitle?: boolean;
}) {
  const { mode, leaves } = decompose(value);
  const realMode: 'all' | 'any' = mode === 'any' ? 'any' : 'all';

  const newLeaf = (): Leaf => {
    const f = fields[0] ?? 'amount';
    return { field: f, op: isNumericField(f) ? 'gte' : 'eq', value: isNumericField(f) ? 0 : '' };
  };
  const setLeaves = (next: Leaf[]) => {
    if (next.length === 0) {
      onChange(allowAlways ? { always: true } : { all: [] });
      return;
    }
    onChange(realMode === 'any' ? { any: next } : { all: next });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        {!hideTitle && <span className="font-medium text-muted-foreground">Conditions:</span>}
        {leaves.length > 1 ? (
          <InlineMenu
            title="Combine conditions"
            options={[
              { value: 'all', label: 'AND' },
              { value: 'any', label: 'OR' },
            ]}
            onSelect={(m) => onChange(m === 'any' ? { any: leaves } : { all: leaves })}
            className="rounded-md border border-input bg-background px-2 py-0.5 font-medium text-foreground hover:bg-muted"
            label={realMode === 'any' ? 'OR' : 'AND'}
          />
        ) : leaves.length === 0 ? (
          <span className="text-muted-foreground italic">none — always applies</span>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          onClick={() => setLeaves([...leaves, newLeaf()])}
        >
          <IconPlus size={12} className="mr-1" />
          Add
        </Button>
      </div>

      {leaves.map((leaf, i) => (
        <fieldset
          // biome-ignore lint/suspicious/noArrayIndexKey: positional, editable rows
          key={i}
          className="rounded-md border border-border px-2 py-1.5"
        >
          <LeafPill
            bare
            leaf={leaf}
            fields={fields}
            options={options}
            locale={locale}
            onChange={(next) => {
              const copy = [...leaves];
              copy[i] = next;
              setLeaves(copy);
            }}
            onRemove={() => setLeaves(leaves.filter((_, j) => j !== i))}
          />
        </fieldset>
      ))}
    </div>
  );
}

// ── CriteriaPills (read-only node summary) ───────────────────────────────────

export interface Criterion {
  label: string;
  value: string;
  /** Render in a warning tone (e.g. an unset required field). */
  warn?: boolean;
}

/** Node-body summary: a muted label followed by a value pill (label sits
 *  outside the pill). One row per criterion. */
export function CriteriaPills({ items }: { items: Criterion[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-1.5 space-y-1">
      {items.map((c) => (
        <div key={`${c.label}:${c.value}`} className="flex items-start gap-1.5 text-[11px]">
          <span className="shrink-0 pt-0.5 font-medium text-muted-foreground">{c.label}</span>
          <span
            className={`inline-flex min-w-0 items-center rounded-full px-2 py-0.5 ${
              c.warn ? 'bg-warning text-warning-foreground' : 'bg-muted text-foreground'
            }`}
          >
            <span className="truncate">{c.value}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Read-only condition display for node bodies: each condition as its own pill
 *  (bold field + operator + value), with the and/or conjunction between, wrapping. */
export function PredicatePills({
  value,
  options,
  locale,
}: {
  value: Predicate;
  options: EditorOptions | undefined;
  locale: Locale;
}) {
  const { mode, leaves } = decompose(value);
  if (leaves.length === 0) {
    return <CriteriaPills items={[{ label: '', value: 'Always' }]} />;
  }
  const conj = mode === 'any' ? 'or' : 'and';
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {leaves.map((leaf, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: positional read-only pills
          key={`${leaf.field}-${leaf.op}-${i}`}
          className="inline-flex items-center gap-1"
        >
          {i > 0 && <span className="text-[9px] text-muted-foreground uppercase">{conj}</span>}
          <LeafPill
            leaf={leaf}
            options={options}
            locale={locale}
            readOnly
            onChange={() => {}}
            onRemove={() => {}}
          />
        </span>
      ))}
    </div>
  );
}
