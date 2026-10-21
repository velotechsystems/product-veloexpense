// VeloExpense (eos batch 3): ExpenseOS's design-system `navigation/Tabs` (67db2e33), unchanged
// but for the `cn` import. VeloExpense's vendored kit has no tab bar, and `components/navigation`
// is the kit's, so it lives here. The mileage-balance drawer is its first user.
'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Tabs — underline-style tab bar driven by a controlled `value`.
 *
 * Intentionally minimal: a row of buttons with a 2px border-bottom
 * accent on the active tab. No animated indicator, no panels-as-
 * children plumbing — the consumer owns the active state and decides
 * what to render below. That matches every existing usage in the app
 * (Platform settings, …) and keeps the API trivial.
 *
 * Usage:
 *   <Tabs<'modules' | 'integrations' | 'settings'>
 *     value={tab}
 *     onChange={setTab}
 *     tabs={[
 *       { value: 'modules',      label: 'Modules' },
 *       { value: 'integrations', label: 'Integrations' },
 *       { value: 'settings',     label: 'Settings' },
 *     ]}
 *   />
 */

export interface TabDef<T extends string> {
  value: T;
  label: ReactNode;
  /** Hide this tab without removing it from the type-level value union.
   *  Useful for permission-gated tabs. */
  hidden?: boolean;
  /** Disable interaction while keeping the tab visible. */
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  tabs: TabDef<T>[];
  /** Override the underlying `<div>` className — useful for spacing
   *  the bar against neighbouring chrome. */
  className?: string;
  /** Aria label for the tablist region. */
  ariaLabel?: string;
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
  ariaLabel,
}: TabsProps<T>) {
  return (
    <div
      className={cn('flex gap-1 border-border border-b', className)}
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => {
          const isActive = t.value === value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={isActive}
              disabled={t.disabled}
              onClick={() => onChange(t.value)}
              /* `einc-tap-slop` (coarse pointers only) floors the tab's hit target
                 at 44px vertically. The rendered tab is 38px in border-box —
                 `py-2` 16 + `text-sm` line-height 20 + `border-b-2` 2, measured —
                 so the class's own 44px produces the slop arithmetically; no
                 number is written here, and none should be. Vertical only: the
                 tabs sit in a `gap-1` row, and a horizontal floor would reach
                 into a neighbour's box.

                 The 6px overhang splits 4 above / 2 below, not 3/3, and that is
                 correct rather than a rounding slip: an absolutely positioned
                 `::after` resolves `height: 100%` and `top: 50%` against its
                 containing block, which is this button's PADDING box. `border-b-2`
                 is bottom-only, so the padding box (36px) sits 1px high inside the
                 border box (38px) and the centred 44px pseudo-element inherits the
                 offset. 38 + 4 + 2 = 44, so the target is met. A symmetric border
                 cancels out, which is why every `Button` size splits evenly.

                 `-mb-px` is deliberately untouched — it is what makes the active
                 tab's 2px border sit on the tablist's own 1px rule instead of
                 below it. The `::after` is a positioned overflow of this button,
                 not part of its box, so it does not interact with that offset.

                 The tablist is NOT a horizontal scroll container: measured across
                 both call sites (2 tabs in `BudgetChart`, 3 in `AnalyticsDashboard`)
                 the widest label row is 77-103px at a 360px viewport in either
                 locale, so overflow is not an observed condition. */
              className={cn(
                'einc-tap-slop -mb-px border-b-2 px-3 py-2 font-medium text-sm transition-colors',
                isActive
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
                t.disabled && 'cursor-not-allowed opacity-50 hover:text-muted-foreground',
              )}
            >
              {t.label}
            </button>
          );
        })}
    </div>
  );
}
