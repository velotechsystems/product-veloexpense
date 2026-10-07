'use client';

import { IconX } from '@tabler/icons-react';
import type { ColumnFilter, DataTableLabels } from './types';

/**
 * Active-filter chip — the static, single-clause version of the
 * agreed filter-pill style. Format: `<Column> <operator> "value" ×`.
 *
 * Uses the same outer shape as `<FilterBlock>` (the editable, multi-
 * value variant) so the two read as one family across the app:
 * `rounded-md border-input bg-background px-2 py-1 text-xs`. Use
 * `<FilterBlock>` when the user needs to switch the operator or add
 * more values; reach for `<FilterChip>` for display-only chips
 * (recent searches, saved-view summaries, server-applied filters
 * the user can only remove).
 */
export function FilterChip({
  colLabel,
  filter,
  options,
  onRemove,
  labels,
}: {
  colLabel: string;
  filter: ColumnFilter;
  options: Array<{ value: string; label: string }>;
  onRemove: () => void;
  labels: DataTableLabels['colMenu'];
}) {
  const labelFor = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  // Operator word — rendered as a muted span between the field
  // label and the value (mirrors `<FilterBlock>`'s clickable
  // operator slot). Static here: `<FilterChip>` is the display-only
  // variant, so the op isn't editable.
  let opWord: string | null;
  let valueText: string;
  switch (filter.op) {
    case 'isAnyOf':
      opWord = filter.values.length === 1 ? labels.op_equals : labels.op_isAnyOf;
      valueText = filter.values.map(labelFor).join(', ');
      break;
    case 'isNoneOf':
      opWord = labels.op_isNoneOf;
      valueText = filter.values.map(labelFor).join(', ');
      break;
    case 'isEmpty':
      opWord = labels.op_isEmpty;
      valueText = '';
      break;
    case 'isNotEmpty':
      opWord = labels.op_isNotEmpty;
      valueText = '';
      break;
    default:
      opWord = labels[`op_${filter.op}`];
      valueText = filter.value;
      break;
  }
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-xs">
      <span className="font-bold text-foreground">{colLabel}</span>
      {opWord ? <span className="text-muted-foreground">{opWord}</span> : null}
      {valueText ? (
        <span className="truncate rounded-sm bg-muted px-1.5 py-0.5 font-medium text-foreground">
          {valueText}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={labels.removeFilter}
        className="ml-0.5 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <IconX size={12} />
      </button>
    </span>
  );
}
