'use client';

import { IconSearch, IconX } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cls } from '../data-table/helpers';
import { CustomScrollBox } from './CustomScrollBox';
import type { FacetOption } from './types';

/**
 * Fixed-height facet card. The header reserves space for the search
 * slot so opening the search input does NOT shift the values below.
 * The values area scrolls internally via CustomScrollBox (custom
 * thumb so the scrollbar is visible on macOS).
 */
export function FacetCard({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string;
  options: FacetOption[];
  selected: string[];
  onToggle: (v: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    return [...matched].sort((a, b) => a.label.localeCompare(b.label));
  }, [options, search]);

  return (
    <div className="flex h-[228px] flex-col rounded-sm border border-input bg-background p-2">
      <div className="mb-1 flex h-7 shrink-0 items-center gap-1">
        {searchOpen ? (
          <>
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search values…"
              className="h-6 flex-1 text-xs"
            />
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setSearchOpen(false);
              }}
              aria-label="Close search"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <IconX size={12} />
            </button>
          </>
        ) : (
          <>
            <span className="flex-1 truncate font-semibold text-foreground text-xs uppercase tracking-wide">
              {title}
            </span>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Search values"
            >
              <IconSearch size={12} />
            </button>
          </>
        )}
      </div>

      <CustomScrollBox className="min-h-0 flex-1">
        {filtered.length === 0 ? (
          <div className="px-1 py-2 text-muted-foreground text-xs italic">No matches</div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((o) => {
              const isSelected = selected.includes(o.value);
              const isZero = o.count === 0;
              return (
                <label
                  key={o.value}
                  className={cls(
                    'flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted',
                    isSelected && 'bg-primary/10 text-foreground',
                    isZero && !isSelected && 'opacity-50',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggle(o.value)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="flex-1 truncate">{o.label}</span>
                  {o.count !== undefined && (
                    <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                      {formatCount(o.count)}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </CustomScrollBox>
    </div>
  );
}

/** Compact count formatter for facet rows. 1234 → "1.2K". */
function formatCount(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function FacetRail<F extends string>({
  fields,
  labels,
  options,
  selectedFor,
  onToggleValue,
}: {
  fields: F[];
  labels: Record<F, string>;
  options: Record<F, FacetOption[]>;
  selectedFor: (field: F) => string[];
  onToggleValue: (field: F, value: string) => void;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2 p-2">
      {fields.map((field) => (
        <FacetCard
          key={field}
          title={labels[field]}
          options={options[field] ?? []}
          selected={selectedFor(field)}
          onToggle={(v) => onToggleValue(field, v)}
        />
      ))}
    </div>
  );
}
