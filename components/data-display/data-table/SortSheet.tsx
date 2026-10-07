'use client';

/**
 * `<SortSheet>` — the column-header sort menu, folded onto a phone.
 *
 * Cards have no header row, so the affordance that sorts a table on desktop
 * — the little arrow in a `<th>` — has nowhere to live. This is where it
 * goes: a bottom sheet listing the fields that can be sorted, plus the
 * direction.
 *
 * ── It cannot offer a dead arrow ────────────────────────────────────
 *
 * `options` is deliberately NOT `columns`. Whether a column can be sorted is
 * not a property of its declaration — `sortable: true` on a column with no
 * comparable value in the data sorts nothing, which is precisely the bug the
 * header's own resolution was written to stop (GA readiness report F04: an
 * indicator that moved and rows that did not). That resolution reads the
 * ROWS, lives in the host app next to the sort itself, and is the single
 * source both surfaces use:
 *
 *     resolveSortField / sortSheetOptions
 *       — apps/web/src/components/data-view/DataTable/sortRows.ts
 *
 * The table header calls `resolveSortField` per column; the sheet's caller
 * calls `sortSheetOptions`, which is that same function mapped over the
 * columns with the nulls dropped. Build `options` any other way and this
 * component will faithfully render whatever dead field you hand it — the
 * guarantee is in the resolver, not in here, because the resolver is the
 * only thing that has seen the rows.
 *
 * ── What is NOT here, and stays not here ────────────────────────────
 *
 * Column resize, pinning and reorder are meaningless without a header row.
 * Density maps three settings onto card padding that has its own vertical
 * rhythm — a control that appears to do something and does not. Row drag is
 * native HTML5 drag, which does not fire on touch at all. None of the five
 * are hidden behind a flag; they are absent, and this note is why.
 */

import { IconArrowDown, IconArrowsSort, IconArrowUp, IconCheck } from '@tabler/icons-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
// VeloExpense kit: the kit's `lg` button is 36px; ExpenseOS's is 44px, the touch target
// these mobile sheets are built around (see the tests). `h-11` restores it where `lg` is used.
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { cls } from './helpers';
import type { SortDir, SortState } from './types';

/**
 * One sortable field. `field` is the value that goes into `SortState.field`
 * — already resolved to the server field name where the column declares one
 * — and `label` is the column's header text, so the sheet reads the way the
 * table did.
 */
export interface SortSheetOption {
  field: string;
  label: string;
}

/** Copy for the sheet. English defaults; the host app supplies translations
 *  (this package takes no next-intl dependency by design). */
export interface SortSheetLabels {
  /** Trigger with nothing sorted. Default "Sort". */
  trigger: string;
  /** Trigger with an active sort. Default `Sort · Amount`. */
  triggerWithField: (fieldLabel: string) => string;
  /** Sheet title. Default "Sort by". */
  title: string;
  /** Group label over the field list. Default "Field". */
  field: string;
  /** Group label over the direction pair. Default "Direction". */
  direction: string;
  /** Ascending option. Default "Ascending". */
  ascending: string;
  /** Descending option. Default "Descending". */
  descending: string;
  /** Shown when no column in this table can be sorted. Default
   *  "Nothing on this list can be sorted." */
  empty: string;
  /** Footer: drops the sort entirely. Default "Clear sort". */
  clearSort: string;
  /** Footer: closes the sheet. Default "Done". */
  done: string;
}

export const DEFAULT_SORT_SHEET_LABELS: SortSheetLabels = {
  trigger: 'Sort',
  triggerWithField: (fieldLabel) => `Sort · ${fieldLabel}`,
  title: 'Sort by',
  field: 'Field',
  direction: 'Direction',
  ascending: 'Ascending',
  descending: 'Descending',
  empty: 'Nothing on this list can be sorted.',
  clearSort: 'Clear sort',
  done: 'Done',
};

export interface SortSheetProps {
  /**
   * Fields this table can actually sort by, in the order the columns appear.
   * Build it with `sortSheetOptions` — see the note at the top of this file.
   * An empty list is legal and renders the empty state rather than a sheet
   * with nothing in it.
   */
  options: SortSheetOption[];
  /** Current sort, or `null` for unsorted. */
  value: SortState | null;
  /** Called with the new sort, or `null` when it is cleared. */
  onChange: (next: SortState | null) => void;
  labels?: SortSheetLabels;
  /** Controlled open state. Omit both to let the sheet own it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra classes for the TRIGGER (the sheet itself is full-bleed). */
  className?: string;
}

/**
 * A 44px row. Every tappable thing in this sheet is one — the field rows and
 * the two direction rows alike — because a list of choices where some are
 * reachable and some are fiddly is worse than a list where all of them are
 * the same size.
 */
const ROW = 'flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm';

export function SortSheet({
  options,
  value,
  onChange,
  labels = DEFAULT_SORT_SHEET_LABELS,
  open,
  onOpenChange,
  className,
}: SortSheetProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const isOpen = open ?? uncontrolledOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (open === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange],
  );

  const active = value?.field ? (options.find((o) => o.field === value.field) ?? null) : null;
  const dir: SortDir = value?.dir ?? 'asc';

  /** Picking a field keeps the direction the person already chose — they
   *  asked to re-sort, not to start over. */
  const pickField = (field: string) => onChange({ field, dir });
  /** The direction pair is inert until there is a field to apply it to,
   *  rather than silently sorting by whatever happens to be first. */
  const pickDir = (next: SortDir) => {
    if (!value?.field) return;
    onChange({ field: value.field, dir: next });
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className={['h-11 gap-1.5 px-4', className].filter(Boolean).join(' ')}
        onClick={() => setOpen(true)}
      >
        <IconArrowsSort size={16} aria-hidden="true" />
        {active ? labels.triggerWithField(active.label) : labels.trigger}
      </Button>

      {/* `dismissible` for the same reason the filter sheet is: nothing here
          is a draft, so trapping the reader over their own list buys
          nothing. */}
      <Drawer open={isOpen} onOpenChange={setOpen} dismissible>
        <DrawerContent side="bottom" hideCloseButton>
          <DrawerHeader className="pr-5">
            <DrawerTitle>{labels.title}</DrawerTitle>
          </DrawerHeader>

          <DrawerBody className="flex flex-col gap-1">
            {options.length === 0 ? (
              <p className="py-2 text-muted-foreground text-sm">{labels.empty}</p>
            ) : (
              <>
                {/*
                 * A radio GROUP, so a screen reader says "Amount, radio
                 * button, 2 of 6" rather than reading six unrelated buttons.
                 *
                 * Hand-rolled from `role="radio"` buttons rather than built
                 * on the design system's `<RadioGroup>` / `<Radio>`, and the
                 * reason is the tap target. Those wrap Base UI's radio, whose
                 * root is not a labelable element, so a `<label>` around the
                 * row does not name it or forward a click to it — the
                 * accessible name and the hit area both collapse onto the
                 * 16px dot. Phase 4 settled the principle for the kebab
                 * trigger: a 44px wrapper around a small control satisfies
                 * nothing, because the hit area is the control. Here the
                 * button IS the row, so the row is the target.
                 */}
                <div role="radiogroup" aria-label={labels.field} className="flex flex-col gap-0.5">
                  {options.map((o) => {
                    const selected = o.field === value?.field;
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: a real radio input puts the hit area on a 16px dot; this row has to be a 44px tap target, so the button IS the row
                      <button
                        key={o.field}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => pickField(o.field)}
                        className={cls(
                          ROW,
                          'hover:bg-muted',
                          selected && 'bg-primary/10 font-medium text-primary',
                        )}
                      >
                        <IconCheck
                          size={16}
                          aria-hidden="true"
                          className={cls('shrink-0', !selected && 'invisible')}
                        />
                        <span className="truncate">{o.label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-2 border-border border-t pt-2">
                  <div
                    role="radiogroup"
                    aria-label={labels.direction}
                    className="flex flex-col gap-0.5"
                  >
                    {(
                      [
                        ['asc', labels.ascending, IconArrowUp],
                        ['desc', labels.descending, IconArrowDown],
                      ] as const
                    ).map(([d, label, Icon]) => {
                      const selected = !!value?.field && dir === d;
                      return (
                        // biome-ignore lint/a11y/useSemanticElements: as above — the 44px row is the control
                        <button
                          key={d}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          disabled={!value?.field}
                          onClick={() => pickDir(d)}
                          className={cls(
                            ROW,
                            'hover:bg-muted disabled:pointer-events-none disabled:opacity-50',
                            selected && 'bg-primary/10 font-medium text-primary',
                          )}
                        >
                          <Icon size={16} aria-hidden="true" className="shrink-0" />
                          <span className="truncate">{label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </DrawerBody>

          <DrawerFooter className="justify-between">
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="px-4 h-11"
              disabled={!value?.field}
              onClick={() => onChange(null)}
            >
              {labels.clearSort}
            </Button>
            <Button type="button" size="lg" className="px-6 h-11" onClick={() => setOpen(false)}>
              {labels.done}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </>
  );
}
SortSheet.displayName = 'SortSheet';
