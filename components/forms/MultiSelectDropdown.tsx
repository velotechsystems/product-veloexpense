'use client';

import { IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { MultiSelectDropdownProps } from './MultiSelectDropdown.types';

/**
 * MultiSelectDropdown — the canonical multi-select control across forms.
 *
 * Closed state: selected values render as Badge "tags" inside a field-styled
 * trigger (matches the array-of-pills convention). Open state: a popover
 * hosts a searchable checkbox list (cmdk) with Select all / Clear / Done
 * actions on top.
 *
 * Used directly for hand-built multi-selects and indirectly via the RJSF
 * CheckboxesWidget for enum arrays (`array + items.enum + uniqueItems`).
 */
export function MultiSelectDropdown({
  items,
  value,
  onValueChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches',
  disabled,
  id,
  className,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const labelByValue = new Map(items.map((i) => [i.value, i.label]));

  function toggle(v: string) {
    onValueChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* VeloExpense kit: Radix `asChild` for Base UI `render`; Radix marks the open
          trigger `data-state=open` where Base UI sets `data-popup-open`. */}
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          className={cn(
            'flex min-h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm',
            'focus-visible:border-ring focus-visible:outline-none',
            'data-[state=open]:border-ring',
            'disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <div className="flex flex-1 flex-wrap items-center gap-1 text-left">
            {value.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : (
              value.map((v) => (
                <Badge key={v} variant="secondary">
                  {labelByValue.get(v) ?? v}
                </Badge>
              ))
            )}
          </div>
          <IconChevronDown size={14} className="shrink-0 opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>
      {/*
       * Width: AT LEAST the trigger, free to grow to fit the longest option, capped to the
       * viewport — the same contract `select.tsx` set and `combobox.tsx` follows.
       * `--anchor-width` is a FLOOR, not a ceiling: pinning the popup to the trigger width
       * clipped option text on narrow fields, reported twice from UAT as "fields cut off in
       * the dropdown because of screen size". The floor is 12rem here rather than the
       * combobox's 8rem; every row in this list carries a checkbox alongside its label.
       *
       * This one needs care the other two do not: `PopoverContent` contributes its OWN
       * `w-72 … p-4`, so this prop string is not the whole story and `cn` / tailwind-merge
       * decides the outcome. `MultiSelectDropdown.test.tsx` therefore asserts on the
       * RENDERED element and pins `w-72` absent — asserting the prop would pass on a class
       * Tailwind then discards.
       *
       * Known and accepted: `PopoverContent` defaults to `align="center"` and this call
       * does not override it, so unlike the two `align="start"` combobox popups this one
       * grows symmetrically and widening moves BOTH edges outward. The 92vw cap and Base
       * UI's collision shift keep it on screen, but there is no geometry test for this
       * popup at 375px the way `e2e/combobox-popup-width.spec.ts` is one for the combobox.
       */}
      {/* VeloExpense kit: Radix names the trigger width `--radix-popover-trigger-width`. */}
      <PopoverContent className="w-auto min-w-[max(12rem,var(--radix-popover-trigger-width))] max-w-[min(92vw,32rem)] p-0">
        <div className="flex border-input border-b">
          <button
            type="button"
            onClick={() => onValueChange(items.map((i) => i.value))}
            className="flex-1 border-input border-r px-2 py-1.5 font-semibold text-primary text-xs hover:bg-primary/5"
          >
            All
          </button>
          <button
            type="button"
            onClick={() => onValueChange([])}
            className="flex-1 border-input border-r px-2 py-1.5 font-semibold text-primary text-xs hover:bg-primary/5"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex-1 px-2 py-1.5 font-semibold text-muted-foreground text-xs hover:bg-muted"
          >
            Done
          </button>
        </div>
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {items.map((item) => {
                const checked = value.includes(item.value);
                return (
                  /*
                   * Wrap, don't clip — the other half of the width fix above. Past the popup's
                   * `min(92vw,32rem)` cap a label has to go somewhere, and there is no fallback
                   * affordance: this row sits inside THREE clipping ancestors (`CommandGroup`
                   * and `Command` are `overflow-hidden`, `CommandList` is `overflow-x-hidden`),
                   * so it was cut off with no ellipsis and no scrollbar. Ellipsis is not the
                   * answer either — it makes an option unpickable-by-reading exactly where a GL
                   * account's or legal entity's disambiguating part sits at the end.
                   *
                   * At the composition, not in `CommandItem`'s base, deliberately.
                   * `select.tsx` / `combobox.tsx` hold these classes in their bases because
                   * their item and their popup are one file under one width contract;
                   * `command.tsx` is a generic cmdk row that knows nothing of this cap, its
                   * base `items-center` is right for a single-line palette row, and it is
                   * re-exported from the public barrel (`ui/index.ts:25`). Per the admission
                   * rule pinned in `tests/components/ui/badge.test.tsx`, that class only
                   * belongs in a base if it holds in every context — and this file is the only
                   * `CommandItem` consumer in the repo, so a base change would buy nothing
                   * while widening a public contract on the strength of one call site.
                   *
                   * All three are load-bearing; measured in Chromium at 375x667 (cap 345px)
                   * with a 76-char slash-joined label:
                   *   - `break-words` — `white-space` is already `normal` here, and a
                   *     slash-joined run has no soft break point, so this is the half that
                   *     creates one.
                   *   - the label's own `min-w-0` box — the half the class pair alone does NOT
                   *     give you. `{item.label}` is a flex item, so its `min-width: auto`
                   *     resolves to min-content, and per css-text-3 `overflow-wrap:
                   *     break-word` deliberately does not reduce min-content. Measured:
                   *     `break-words` alone still put 557px of content in a 335px box (222px
                   *     clipped); with `min-w-0`, 335px, two lines, nothing clipped.
                   *   - `items-start` + the checkbox's `mt-0.5` — one decision with the wrap,
                   *     not a second, the same coupling `combobox.tsx` records. On the 52px
                   *     two-line row `items-center` parks the checkbox 18px down, mid-block
                   *     instead of on the line it marks; these put it at 8px, which is
                   *     `select.tsx:117`'s `top-2` within the same `py-1.5`.
                   */
                  <CommandItem
                    key={item.value}
                    value={item.label}
                    onSelect={() => toggle(item.value)}
                    className="cursor-pointer items-start whitespace-normal break-words"
                  >
                    <Checkbox
                      checked={checked}
                      className="pointer-events-none mt-0.5 mr-2"
                      tabIndex={-1}
                    />
                    <span className="min-w-0">{item.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
