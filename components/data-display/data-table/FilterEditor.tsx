'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  type ColumnFilter,
  type DataTableLabels,
  ENUM_OPS,
  type FilterColumnType,
  type FilterOp,
  MULTI_VALUE_OPS,
  NO_VALUE_OPS,
  SINGLE_VALUE_OPS,
  TEXT_OPS,
} from './types';

/**
 * Filter editor — operator selector + dynamic value editor. Builds a
 * `ColumnFilter` and hands it back via `onApply`. `null` means "clear
 * this column's filter".
 */
export function FilterEditor({
  columnType,
  options,
  current,
  onApply,
  onCancel,
  labels,
}: {
  columnType: FilterColumnType;
  options: Array<{ value: string; label: string }>;
  current: ColumnFilter | null;
  onApply: (next: ColumnFilter | null) => void;
  onCancel: () => void;
  labels: DataTableLabels['colMenu'];
}) {
  const availableOps: FilterOp[] =
    columnType === 'enum'
      ? ENUM_OPS
      : options.length > 0
        ? TEXT_OPS
        : TEXT_OPS.filter((o) => o !== 'isAnyOf');

  const [op, setOp] = useState<FilterOp>(
    current?.op ?? (columnType === 'enum' ? 'isAnyOf' : 'contains'),
  );
  const [text, setText] = useState<string>(
    current && SINGLE_VALUE_OPS.includes(current.op) ? (current as { value: string }).value : '',
  );
  const [values, setValues] = useState<string[]>(
    current && MULTI_VALUE_OPS.includes(current.op) ? (current as { values: string[] }).values : [],
  );

  const needsText = SINGLE_VALUE_OPS.includes(op);
  const needsMulti = MULTI_VALUE_OPS.includes(op);
  const needsNothing = NO_VALUE_OPS.includes(op);

  const canApply =
    needsNothing || (needsText && text.trim().length > 0) || (needsMulti && values.length > 0);

  const apply = () => {
    let next: ColumnFilter | null = null;
    if (needsNothing) next = { op } as ColumnFilter;
    else if (needsText && text.trim().length > 0) next = { op, value: text.trim() } as ColumnFilter;
    else if (needsMulti && values.length > 0) next = { op, values } as ColumnFilter;
    onApply(next);
  };

  return (
    <div className="p-2">
      <div className="mb-2 px-1 font-semibold text-foreground text-xs uppercase tracking-wide">
        {labels.filter}
      </div>
      <div className="mb-2 px-1">
        <Select value={op} onValueChange={(v) => setOp((v as FilterOp) ?? availableOps[0])}>
          <SelectTrigger>
            {/* VeloExpense kit: Radix's SelectValue renders the chosen item's own text, which
                is this same label; ExpenseOS's Base UI one needed a render function for it. */}
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableOps.map((o) => (
              <SelectItem key={o} value={o}>
                {labels[`op_${o}`]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {needsText && (
        <div className="mb-2 px-1">
          <Input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={labels.value}
            autoFocus
          />
        </div>
      )}
      {needsMulti && (
        <div className="mb-2 max-h-56 overflow-y-auto py-1">
          {options.map((o) => {
            const checked = values.includes(o.value);
            return (
              <label
                key={o.value}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    setValues(
                      e.target.checked ? [...values, o.value] : values.filter((v) => v !== o.value),
                    );
                  }}
                  className="h-4 w-4"
                />
                <span className="flex-1">{o.label}</span>
              </label>
            );
          })}
        </div>
      )}

      <div className="my-1 h-px bg-border" />
      <div className="flex justify-between gap-1 px-1">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {labels.cancel}
        </Button>
        <div className="flex gap-1">
          {current && (
            <Button variant="ghost" size="sm" onClick={() => onApply(null)}>
              {labels.clear}
            </Button>
          )}
          <Button variant="default" size="sm" onClick={apply} disabled={!canApply}>
            {labels.apply}
          </Button>
        </div>
      </div>
    </div>
  );
}
