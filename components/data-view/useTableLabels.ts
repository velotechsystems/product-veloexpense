'use client';

import type { FilterLabels, FilterSheetLabels, SortSheetLabels } from '@expenseos/design-system';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import type { DataTableLabels as DataTableLabelsX } from './DataTable';

/**
 * The full, i18n-backed table chrome label bag — the single source of
 * truth for every list page (admin lookups, People, Role Builder,
 * Virtual Cards, …). Built from the `table.*` catalog so the column
 * menu, settings dropdown, and footer read identically everywhere and
 * in every locale.
 *
 * It is a superset of both label contracts the app uses:
 *   - the app's `<DataTable>` (`DataTableLabelsX`)
 *   - the DS `<TableSettingsButton>` (`settings` needs `groupBy`)
 * so callers pass `labels={tableLabels}` to the table and
 * `labels={tableLabels.settings}` to the gear button.
 */
export type TableLabels = DataTableLabelsX & {
  settings: DataTableLabelsX['settings'] & { groupBy: string };
  misc: { clearAll: string };
  loading: string;
  endOfList: string;
  /**
   * The per-row accessible names and the card bag, narrowed from optional to
   * REQUIRED here.
   *
   * They are optional on `DataTableLabels` so the bags that predate them keep
   * compiling; this hook is the one that always has a catalog behind it, so
   * anything it returns is translated. Narrowing means a new field added to
   * either surface fails the build in this file — which is the only file that
   * can actually fix it — rather than silently falling back to English on
   * forty-three pages.
   */
  selectRow: string;
  expandRow: string;
  collapseRow: string;
  dragToReorder: string;
  cards: Required<NonNullable<DataTableLabelsX['cards']>>;
};

/**
 * The toolbar's copy, in one bag to spread onto every `<DataTableToolbar>`:
 *
 *   <DataTableToolbar {...useToolbarLabels()} resultCount={…} … />
 *
 * The strings are deliberately generic — "12 results", "3 selected". Per-page
 * nouns ("12 transactions", "3 reports selected") are what made every list read
 * slightly differently, and the page heading already says what is being listed.
 */
export interface ToolbarLabels {
  resultLabel: (n: number) => string;
  bulkActionsLabel: (n: number) => string;
  loadingLabel: string;
}

export function useToolbarLabels(): ToolbarLabels {
  const t = useTranslations('table.misc');
  return useMemo<ToolbarLabels>(
    () => ({
      resultLabel: (count) => t('results', { count }),
      bulkActionsLabel: (count) => t('selected', { count }),
      loadingLabel: t('loading'),
    }),
    [t],
  );
}

/**
 * Copy for the filter-pill chrome — "Add filter", the field/operator/value words, the
 * operator vocabulary, and the icon-button aria-labels — in one bag.
 *
 * WHY A HOOK. The design system takes no next-intl dependency (the same reason
 * `DataTableLabels` exists), so every one of these strings has to arrive as a prop. PR #333
 * threaded them through `useFilterPillBarWiring` for the 28 listings that use that hook — and
 * the shells that build their own filter fields (AdminLookupPage, which alone serves business
 * units, legal entities, departments and approval workflows, plus the expense-category, role
 * and NetSuite-reference screens) were left rendering English (GA readiness report F43).
 *
 * One bag, one place, so the next screen cannot be missed the same way.
 */
export function useFilterChromeLabels(): FilterLabels {
  const t = useTranslations('table');
  return {
    addFilter: t('filters.addFilter'),
    field: t('filters.field'),
    operator: t('filters.operator'),
    value: t('filters.value'),
    valuePlaceholder: t('filters.valuePlaceholder'),
    typeAValue: t('filters.typeAValue'),
    typeOrPick: t('filters.typeOrPick'),
    add: t('filters.add'),
    cancel: t('filters.cancel'),
    addValue: t('filters.addValue'),
    addAnotherValue: t('filters.addAnotherValue'),
    changeOperator: t('filters.changeOperator'),
    removeCondition: t('filters.removeCondition'),
    removeValue: t('filters.removeValue'),
    lastNDays: t('filters.lastNDays'),
    /**
     * Spelled out rather than looped, so a new `FilterOp` fails the build here instead of
     * silently rendering `undefined` on a pill.
     */
    ops: {
      equals: t('filterOps.equals'),
      doesNotEqual: t('filterOps.doesNotEqual'),
      contains: t('filterOps.contains'),
      doesNotContain: t('filterOps.doesNotContain'),
      startsWith: t('filterOps.startsWith'),
      endsWith: t('filterOps.endsWith'),
      isEmpty: t('filterOps.isEmpty'),
      isNotEmpty: t('filterOps.isNotEmpty'),
      on: t('filterOps.on'),
      before: t('filterOps.before'),
      after: t('filterOps.after'),
      between: t('filterOps.between'),
      within: t('filterOps.within'),
    },
  };
}

export function useTableLabels(): TableLabels {
  const tColMenu = useTranslations('table.colMenu');
  const tSettings = useTranslations('table.settings');
  const tMisc = useTranslations('table.misc');

  return useMemo<TableLabels>(
    () => ({
      colMenu: {
        menu: tColMenu('menu'),
        sortAsc: tColMenu('sortAsc'),
        sortDesc: tColMenu('sortDesc'),
        filter: tColMenu('filter'),
        hide: tColMenu('hide'),
        cancel: tColMenu('cancel'),
        clear: tColMenu('clear'),
        apply: tColMenu('apply'),
        value: tColMenu('value'),
        resize: tColMenu('resize'),
        removeFilter: tColMenu('removeFilter'),
        op_contains: tColMenu('op_contains'),
        op_doesNotContain: tColMenu('op_doesNotContain'),
        op_equals: tColMenu('op_equals'),
        op_doesNotEqual: tColMenu('op_doesNotEqual'),
        op_startsWith: tColMenu('op_startsWith'),
        op_endsWith: tColMenu('op_endsWith'),
        op_isEmpty: tColMenu('op_isEmpty'),
        op_isNotEmpty: tColMenu('op_isNotEmpty'),
        op_isAnyOf: tColMenu('op_isAnyOf'),
        op_isNoneOf: tColMenu('op_isNoneOf'),
      },
      settings: {
        trigger: tSettings('trigger'),
        columns: tSettings('columns'),
        groupBy: tSettings('groupBy'),
        density: tSettings('density'),
        densityCompact: tSettings('densityCompact'),
        densityNormal: tSettings('densityNormal'),
        densityComfortable: tSettings('densityComfortable'),
        resetDefaults: tSettings('resetDefaults'),
      },
      misc: { clearAll: tMisc('clearAll') },
      /**
       * The header checkbox's accessible name. It lives here rather than at each call
       * site for the reason `useFilterChromeLabels` gives above: a string every listing
       * needs, that most listings will not remember to pass.
       */
      selectAll: tMisc('selectAll'),
      /**
       * The per-row accessible names, for the same reason `selectAll` is here:
       * a string every listing needs and no listing would remember to pass.
       * They were literals in `DataTable` and so were invisible to
       * `check-used-keys` — not being catalog keys, there was nothing for the
       * gate to look for (the same blind spot that let the filter-pill chrome
       * ship in English, GA readiness report F43).
       */
      selectRow: tMisc('selectRow'),
      expandRow: tMisc('expandRow'),
      collapseRow: tMisc('collapseRow'),
      dragToReorder: tMisc('dragToReorder'),
      /**
       * The card tree's own three, filled from the seam Phase 3 left optional.
       *
       * Two of them are deliberately the SAME catalog keys the table tree
       * reads: a card's checkbox and a row's checkbox are one control in two
       * frames, and the card list's live region counts the same rows the
       * toolbar does (`useToolbarLabels().resultLabel`). Two keys with
       * identical English is how a locale ends up saying it two ways.
       */
      cards: {
        rowActions: tMisc('rowActions'),
        selectRow: tMisc('selectRow'),
        resultCount: (count) => tMisc('results', { count }),
      },
      loading: tMisc('loading'),
      endOfList: tMisc('endOfList'),
    }),
    [tColMenu, tSettings, tMisc],
  );
}

/**
 * Copy for the mobile FILTER sheet's own chrome — the trigger, the title, the
 * `and` between stacked blocks, and the footer pair.
 *
 * Separate from `useFilterChromeLabels`, mirroring the design system's own
 * split: `FilterLabels` is the pill chrome the sheet shares verbatim with the
 * bar, `FilterSheetLabels` is the frame around it that only exists below `md`.
 * A caller mounting the sheet passes both, because the sheet renders both.
 *
 * `and` is the one to be careful with. It is not decoration and it is not
 * `aria-hidden`: stacked vertically, two filter blocks read as a list, and a
 * list of conditions is as easily read "any of these" as "all of these". The
 * word is the only thing that says which. FR-CA "et".
 */
export function useFilterSheetLabels(): FilterSheetLabels {
  const t = useTranslations('table');
  return {
    trigger: t('mobile.filtersTrigger'),
    /** Clause GROUPS, not clauses — see `FilterSheetLabels.triggerWithCount`. */
    triggerWithCount: (groupCount) => t('mobile.filtersWithCount', { count: groupCount }),
    title: t('mobile.filtersTitle'),
    and: t('mobile.and'),
    empty: t('mobile.filtersEmpty'),
    /** Shared with the pill bar's own "Clear all" rather than duplicated. */
    clearAll: t('misc.clearAll'),
    done: t('mobile.done'),
  };
}

/**
 * Copy for the mobile SORT sheet — the column header's sort menu, folded onto a
 * phone where there is no header row to hang it from.
 *
 * The direction words are `Croissant` / `Décroissant` in FR-CA, matching
 * `colMenu.sortAsc` ("Trier par ordre croissant") so the two surfaces name the
 * same thing the same way.
 */
export function useSortSheetLabels(): SortSheetLabels {
  const t = useTranslations('table');
  return {
    trigger: t('mobile.sortTrigger'),
    triggerWithField: (fieldLabel) => t('mobile.sortWithField', { field: fieldLabel }),
    title: t('mobile.sortTitle'),
    field: t('mobile.sortField'),
    direction: t('mobile.sortDirection'),
    ascending: t('mobile.sortAscending'),
    descending: t('mobile.sortDescending'),
    empty: t('mobile.sortEmpty'),
    clearSort: t('mobile.clearSort'),
    done: t('mobile.done'),
  };
}
