'use client';

import { IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { cls } from './data-table/helpers';

/**
 * High-level scope selector — a small dropdown that filters BEFORE
 * facet filters apply. Generic-over-scope-union so each consumer
 * provides its own scope type (e.g. EmployeeDirectory's
 * `DirectoryScope`, an Expense Reports view's
 * 'mine' | 'team' | 'all' union, etc.).
 *
 * Renders null when only one scope is available — there's nothing
 * meaningful to switch between, so the chip suppresses itself.
 */
export function ScopeChip<S extends string>({
  availableScopes,
  current,
  onChange,
  scopeLabel,
}: {
  availableScopes: S[];
  current: S;
  onChange: (s: S) => void;
  scopeLabel: (s: S) => string;
}) {
  const [open, setOpen] = useState(false);
  if (availableScopes.length <= 1) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded px-2 py-1 font-semibold text-foreground text-sm hover:bg-muted"
      >
        {scopeLabel(current)}
        <IconChevronDown size={12} />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40"
          />
          <div className="absolute top-full left-0 z-50 mt-1 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md">
            {availableScopes.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  onChange(s);
                  setOpen(false);
                }}
                className={cls(
                  'flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-muted',
                  s === current && 'text-primary',
                )}
              >
                {scopeLabel(s)}
                {s === current && <span className="text-primary text-xs">●</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
