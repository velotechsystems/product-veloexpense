'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * EmojiPicker — a dropdown listing the full Unicode emoji library.
 *
 * The dataset (`emojibase-data`, ~1.9k emojis) is a data-only dependency with
 * no runtime/CDN calls; it's dynamically imported on first open and cached at
 * module scope so the ~500KB JSON loads once per session and never bloats the
 * initial bundle. Chrome strings default to English and can be overridden by
 * the consumer for i18n (this is a design-system component, so it stays
 * next-intl-agnostic).
 */

type CompactEmoji = {
  unicode: string;
  label: string;
  group?: number;
  order?: number;
  tags?: string[];
};

// emojibase group indices → English names. Group 2 (component: skin-tone /
// hair modifiers) and ungrouped entries (regional indicators) are excluded.
const GROUP_ORDER = [0, 1, 3, 4, 5, 6, 7, 8, 9];
const GROUP_LABELS_EN: Record<number, string> = {
  0: 'Smileys & Emotion',
  1: 'People & Body',
  3: 'Animals & Nature',
  4: 'Food & Drink',
  5: 'Travel & Places',
  6: 'Activities',
  7: 'Objects',
  8: 'Symbols',
  9: 'Flags',
};

let cache: CompactEmoji[] | null = null;
let inFlight: Promise<CompactEmoji[]> | null = null;
function loadEmojis(): Promise<CompactEmoji[]> {
  if (cache) return Promise.resolve(cache);
  if (!inFlight) {
    inFlight = import('emojibase-data/en/compact.json').then((m) => {
      cache = ((m as { default?: CompactEmoji[] }).default ?? m) as CompactEmoji[];
      return cache;
    });
  }
  return inFlight;
}

export type EmojiPickerProps = {
  value?: string | null;
  onSelect: (emoji: string) => void;
  onClear?: () => void;
  disabled?: boolean;
  /** aria-label for the trigger. */
  triggerLabel?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  clearLabel?: string;
  /** Override the English category headers (keyed by emojibase group index). */
  categoryLabels?: Partial<Record<number, string>>;
  className?: string;
};

export function EmojiPicker({
  value,
  onSelect,
  onClear,
  disabled,
  triggerLabel = 'Choose an emoji',
  searchPlaceholder = 'Search emoji…',
  emptyLabel = 'No emoji found',
  clearLabel = 'Clear',
  categoryLabels,
  className,
}: EmojiPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [data, setData] = React.useState<CompactEmoji[] | null>(cache);
  const searchRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open && !data) loadEmojis().then(setData);
  }, [open, data]);

  React.useEffect(() => {
    if (open) {
      // focus the search box once the popup is mounted
      const id = window.setTimeout(() => searchRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    setQuery('');
    return undefined;
  }, [open]);

  const groups = React.useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return GROUP_ORDER.map((g) => {
      const label = categoryLabels?.[g] ?? GROUP_LABELS_EN[g];
      const items = data
        .filter((e) => e.group === g && e.unicode)
        .filter(
          (e) =>
            !q ||
            e.label.toLowerCase().includes(q) ||
            e.tags?.some((t) => t.toLowerCase().includes(q)),
        )
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return { g, label, items };
    }).filter((grp) => grp.items.length > 0);
  }, [data, query, categoryLabels]);

  const pick = (emoji: string) => {
    onSelect(emoji);
    setOpen(false);
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label={triggerLabel}
          disabled={disabled}
          className={cn(
            'flex h-10 w-14 items-center justify-center rounded-md border border-input bg-background text-xl leading-none',
            'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {value || <span className="text-base opacity-40">🙂</span>}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-2">
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="mb-2 h-9"
          />
          <div className="max-h-64 overflow-y-auto pr-1">
            {!data ? (
              <div className="grid grid-cols-8 gap-1">
                {Array.from({ length: 32 }).map((_, i) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                    key={i}
                    className="h-8 w-8 animate-pulse rounded bg-muted"
                  />
                ))}
              </div>
            ) : groups.length === 0 ? (
              <p className="px-1 py-6 text-center text-muted-foreground text-sm">{emptyLabel}</p>
            ) : (
              groups.map((grp) => (
                <div key={grp.g} className="mb-2">
                  <p className="sticky top-0 bg-popover px-1 py-1 font-medium text-muted-foreground text-xs">
                    {grp.label}
                  </p>
                  <div className="grid grid-cols-8 gap-1">
                    {grp.items.map((e) => (
                      <button
                        key={e.unicode}
                        type="button"
                        title={e.label}
                        aria-label={e.label}
                        onClick={() => pick(e.unicode)}
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded text-lg leading-none hover:bg-muted',
                          value === e.unicode && 'bg-primary/10 ring-1 ring-primary',
                        )}
                      >
                        {e.unicode}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
      {value && onClear && (
        <Button size="sm" variant="ghost" onClick={onClear} disabled={disabled}>
          {clearLabel}
        </Button>
      )}
    </div>
  );
}
EmojiPicker.displayName = 'EmojiPicker';
