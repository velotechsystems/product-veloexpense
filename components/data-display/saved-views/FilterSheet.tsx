'use client';

/**
 * `<FilterSheet>` — the filter pill bar, folded onto a phone.
 *
 * The bar is a horizontal strip; below `md` there is no horizontal room for
 * it, so the same blocks stack vertically inside a bottom sheet. It hosts
 * `<FilterBlock>` UNCHANGED — same component, same callbacks, same clause
 * array — so there is exactly one filter-editing implementation and the two
 * surfaces cannot disagree about what a filter does.
 *
 * ── The `and` is drawn here, and only here ──────────────────────────
 *
 * `or` survives the trip: `<FilterBlock>` draws it between the values inside
 * one block, and stacking does not touch that. `and` does not survive. On
 * desktop it is never drawn at all — it is implied by two pills sitting side
 * by side, and a reader supplies it for free. Stack the same two pills
 * vertically and that implication is gone: a column of filters reads as a
 * list, and a list of conditions is as easily read as "any of these" as
 * "all of these". So the sheet draws the word. It is real semantics, not
 * decoration, and it is not `aria-hidden` for the same reason.
 *
 * ── Edits apply immediately ─────────────────────────────────────────
 *
 * There is no buffered draft and no Apply. `<FilterBlock>`'s callbacks write
 * straight through to the host's clause array, exactly as they do in the bar
 * — that is what "as-is" costs and what it buys. Buffering would mean a
 * second add/update/remove implementation living in this file, which is the
 * divergence this component exists to avoid. The footer's primary button is
 * therefore `Done` (it closes the sheet) and not `Apply`: a button labelled
 * Apply, next to filters that already applied, describes something that is
 * not happening.
 *
 * ── The result count is announced, but not from here ────────────────
 *
 * SC 4.1.3 requires the new row count be announced when a filter is applied,
 * because on a phone the count is off-screen behind the sheet. That live
 * region already exists, mounted with the card list (`DataTableCards`), and
 * this component deliberately does NOT add a second one: a region must be
 * mounted BEFORE its text changes to be announced, and this sheet unmounts
 * around every interaction. Because edits here apply immediately to the same
 * clause array the list filters on, the existing region fires on its own.
 */

import { IconFilter } from '@tabler/icons-react';
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
import { AddFilterPill, FilterBlock } from '../filters/FilterBlock';
import type {
  FacetOption,
  FieldKind,
  FilterClause,
  FilterLabels,
  FilterOp,
} from '../filters/types';
import { clauseGroupKey, groupClauses } from './groupClauses';

/**
 * Copy for the sheet's own chrome. Separate from `FilterLabels`, which is
 * the pill chrome shared with the bar.
 *
 * Every field has an English default, and this package takes no next-intl
 * dependency by design — the host app supplies the translated bag. The two
 * count-dependent strings are functions rather than templates so a catalog
 * can put the number wherever its grammar wants it.
 */
export interface FilterSheetLabels {
  /** Sheet trigger with nothing active. Default "Filters". */
  trigger: string;
  /**
   * Sheet trigger with N active filters. Default `Filters · 3`.
   *
   * N is clause GROUPS, never clauses — see `countClauseGroups`. "Status is
   * Submitted or Approved" is one filter to the person who set it, and a
   * trigger that called it 2 would be describing a screen they cannot see.
   */
  triggerWithCount: (groupCount: number) => string;
  /** Sheet title. Default "Filters". */
  title: string;
  /**
   * The conjunction drawn BETWEEN stacked blocks. Default "and".
   *
   * Translators: this is a standalone word on its own line joining two
   * conditions, not a fragment of a sentence.
   */
  and: string;
  /** Shown when no filters are set. Default "No filters yet." */
  empty: string;
  /** Footer: removes every clause. Default "Clear all". */
  clearAll: string;
  /** Footer: closes the sheet. Default "Done". */
  done: string;
}

export const DEFAULT_FILTER_SHEET_LABELS: FilterSheetLabels = {
  trigger: 'Filters',
  triggerWithCount: (n) => `Filters · ${n}`,
  title: 'Filters',
  and: 'and',
  empty: 'No filters yet.',
  clearAll: 'Clear all',
  done: 'Done',
};

export interface FilterSheetProps<F extends string> {
  filters: FilterClause<F>[];
  fields: F[];
  fieldLabels: Record<F, string>;
  fieldKinds: Record<F, FieldKind>;
  options: Record<F, FacetOption[]>;
  onUpdateOp: (id: string, op: FilterOp) => void;
  onUpdateValue: (id: string, value: string) => void;
  onRemoveClause: (id: string) => void;
  onAddClause: (field: F, op: FilterOp, value: string) => void;
  onClearAll: () => void;
  /** Pill chrome copy — the same bag `<FilterPillBar>` takes. */
  labels?: FilterLabels;
  /** Sheet chrome copy. English defaults; see `FilterSheetLabels`. */
  sheetLabels?: FilterSheetLabels;
  /** Controlled open state. Omit both to let the sheet own it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra classes for the TRIGGER (the sheet itself is full-bleed). */
  className?: string;
}

export function FilterSheet<F extends string>({
  filters,
  fields,
  fieldLabels,
  fieldKinds,
  options,
  onUpdateOp,
  onUpdateValue,
  onRemoveClause,
  onAddClause,
  onClearAll,
  labels,
  sheetLabels = DEFAULT_FILTER_SHEET_LABELS,
  open,
  onOpenChange,
  className,
}: FilterSheetProps<F>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const isOpen = open ?? uncontrolledOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (open === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange],
  );

  // The same partition the bar renders, from the same module. See
  // `groupClauses.ts` — group order and within-group clause order are part
  // of that contract, and the server payload depends on both.
  const groups = groupClauses(filters);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="lg"
        // `size="lg"` is the 44px tier. `px-4` narrows its `px-8`, which is
        // sized for a page CTA and would push Sort off a 360px row.
        className={['h-11 gap-1.5 px-4', className].filter(Boolean).join(' ')}
        onClick={() => setOpen(true)}
      >
        <IconFilter size={16} aria-hidden="true" />
        {groups.length > 0 ? sheetLabels.triggerWithCount(groups.length) : sheetLabels.trigger}
      </Button>

      {/* `dismissible`: a sheet floating over a list the reader is trying to
          see must yield to a tap outside it and to Esc. The Drawer default is
          the opposite because the case it was written for is a half-filled
          form, where the same gesture loses work. Nothing is lost here —
          every edit has already applied. */}
      <Drawer open={isOpen} onOpenChange={setOpen} dismissible>
        <DrawerContent
          side="bottom"
          // No X. The built-in close button is a 24px target, and this is a
          // touch surface — the footer's `Done` (44px), a tap outside, and
          // Esc are the ways out, all of which a thumb or a keyboard can
          // actually reach.
          hideCloseButton
        >
          <DrawerHeader className="pr-5">
            <DrawerTitle>{sheetLabels.title}</DrawerTitle>
          </DrawerHeader>

          <DrawerBody className="flex flex-col items-start gap-2">
            {groups.length === 0 ? (
              <p className="py-2 text-muted-foreground text-sm">{sheetLabels.empty}</p>
            ) : (
              groups.map((group, i) => (
                <React.Fragment key={clauseGroupKey(group)}>
                  {i > 0 && (
                    // The literal `and`. Not decoration and not
                    // `aria-hidden` — on desktop this word is carried by
                    // horizontal juxtaposition, which vertical stacking
                    // destroys, so here it has to be said out loud.
                    <span className="px-0.5 font-medium text-muted-foreground text-xs">
                      {sheetLabels.and}
                    </span>
                  )}
                  <FilterBlock
                    labels={labels}
                    field={group.field}
                    fieldKind={fieldKinds[group.field]}
                    op={group.op}
                    fieldLabel={fieldLabels[group.field]}
                    clauses={group.clauses}
                    options={options[group.field] ?? []}
                    onOpChange={(newOp) => {
                      for (const c of group.clauses) onUpdateOp(c.id, newOp);
                    }}
                    onValueChange={onUpdateValue}
                    onRemoveValue={onRemoveClause}
                    onRemoveBlock={() => {
                      for (const c of group.clauses) onRemoveClause(c.id);
                    }}
                    onAddValue={(value) => onAddClause(group.field, group.op, value)}
                  />
                </React.Fragment>
              ))
            )}

            {/* Bottom, per the interaction map: the reader scans what is
                already filtered before deciding to add to it. Same component
                and the same `onAddClause` the bar calls, so a clause added
                here lands in the same place in the array it would have on
                desktop — which is what keeps the server payload identical. */}
            <div className="pt-1">
              <AddFilterPill
                labels={labels}
                fields={fields}
                fieldKinds={fieldKinds}
                facetLabels={fieldLabels}
                facetOptions={options}
                onAdd={onAddClause}
              />
            </div>
          </DrawerBody>

          <DrawerFooter className="justify-between">
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="px-4 h-11"
              disabled={filters.length === 0}
              onClick={onClearAll}
            >
              {sheetLabels.clearAll}
            </Button>
            <Button type="button" size="lg" className="px-6 h-11" onClick={() => setOpen(false)}>
              {sheetLabels.done}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </>
  );
}
FilterSheet.displayName = 'FilterSheet';
