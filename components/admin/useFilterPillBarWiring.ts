'use client';

/**
 * Shared FilterPillBar plumbing for standalone DataTable admin pages
 * (Job Levels, Fiscal Years, Approval Thresholds, …). The full
 * AdminLookupPage shell already wires this up internally — these
 * lightweight pages don't go through the shell, so they call this
 * hook to get the same five-handler set and the four derived prop
 * bags FilterPillBar needs.
 *
 * Saved-views are intentionally not handled here — those tiny config
 * pages don't have a savedView resource yet.
 */
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import {
  type FieldKind as DataViewFieldKind,
  type FacetOption,
  type FilterOp,
  newClauseId,
  useFilterChromeLabels,
  useFilterSheetLabels,
  VALUELESS_OPS,
} from '@/components/data-view';
import type { ColumnDef, DataTableState } from '@/components/data-view/DataTable';

/** The value to carry when an op changes. Valueless ops drop the value; date
 *  ops have op-specific value encodings (preset token vs YYYY-MM-DD vs range),
 *  so switching among them resets to a sensible default rather than keeping an
 *  incompatible string; every other op keeps the current value. */
function nextOpValue(op: FilterOp, prev: string): string {
  if (VALUELESS_OPS.has(op)) return '';
  if (op === 'within') return 'last30';
  if (op === 'on' || op === 'before' || op === 'after' || op === 'between') return '';
  return prev;
}

export function useFilterPillBarWiring<R, C extends string>(
  columns: ColumnDef<R, C>[],
  tableState: DataTableState<C>,
  setTableState: React.Dispatch<React.SetStateAction<DataTableState<C>>>,
) {
  const t = useTranslations('table');
  // One bag, shared with the shells that build their own filter fields — see the hook.
  const chromeLabels = useFilterChromeLabels();
  // The frame the same blocks stack inside below `md`. See `sheetLabels` below.
  const sheetLabels = useFilterSheetLabels();
  const filterableColumns = useMemo(
    () => columns.filter((c) => c.filterable !== undefined),
    [columns],
  );
  const filterFields = useMemo(() => filterableColumns.map((c) => c.id), [filterableColumns]);
  const filterLabels = useMemo(
    () => Object.fromEntries(filterableColumns.map((c) => [c.id, c.label])) as Record<C, string>,
    [filterableColumns],
  );
  const filterKinds = useMemo(
    () =>
      Object.fromEntries(
        filterableColumns.map((c) => [c.id, c.filterable?.kind ?? 'text']),
      ) as Record<C, DataViewFieldKind>,
    [filterableColumns],
  );
  const filterOptions = useMemo(
    () =>
      Object.fromEntries(
        filterableColumns.map((c) => [c.id, c.filterable?.options ?? []]),
      ) as Record<C, FacetOption[]>,
    [filterableColumns],
  );

  const updateClauseOp = (id: string, op: FilterOp) => {
    setTableState((s) => ({
      ...s,
      filters: s.filters.map((c) =>
        c.id === id ? { ...c, op, value: nextOpValue(op, c.value) } : c,
      ),
    }));
  };
  const updateClauseValue = (id: string, value: string) => {
    setTableState((s) => ({
      ...s,
      filters: s.filters.map((c) => (c.id === id ? { ...c, value } : c)),
    }));
  };
  const removeClause = (id: string) => {
    setTableState((s) => ({ ...s, filters: s.filters.filter((c) => c.id !== id) }));
  };
  const addClause = (field: C, op: FilterOp, value: string) => {
    setTableState((s) => ({
      ...s,
      filters: [...s.filters, { id: newClauseId(), field, op, value }],
    }));
  };
  const clearClauses = () => setTableState((s) => ({ ...s, filters: [] }));

  return {
    /**
     * The pill bar's "Clear filters" text.
     *
     * `FilterPillBar` has always accepted a `clearLabel`, defaulting to English —
     * and 29 of its 30 call sites never passed one, so the only untranslated string
     * left in the product showed up on every listing page in a French session.
     * Returning it from the shared hook means a site gets it by wiring one more
     * prop from the bag it already spreads, rather than each remembering to reach
     * for a translator.
     */
    clearLabel: t('misc.clearFilters'),
    /**
     * Copy for the pill chrome itself — "Add filter", "Field", "Operator", the value
     * placeholder and the icon-button aria-labels.
     *
     * These lived as hardcoded English inside the design system, so a French reader saw
     * "Add filter" three times on one page among otherwise translated tiles (GA readiness
     * report F43). They were invisible to `check-used-keys` for the reason that made them
     * easy to miss: not being catalog keys, there was nothing for a coverage tool to look
     * for. Returned from the shared hook for the same reason `clearLabel` is.
     */
    chromeLabels,
    /**
     * Copy for the mobile filter SHEET's own frame — trigger, title, the `and`
     * between stacked blocks, and the footer pair.
     *
     * `<FilterSheet>` is the pill bar below `md` — same blocks, same callbacks,
     * same clause array — so when a listing folds onto a phone it reaches for the
     * bag it is already spreading rather than for a translator of its own.
     * `chromeLabels` had to be retrofitted onto 30 call sites after 29 of them
     * shipped English; this one was here before the first call site existed.
     *
     * That first call site is now `/expenses` (`ExpenseReportsList.tsx`), which
     * mounts the sheet in place of the bar below `md` and passes BOTH bags —
     * this one for the sheet's frame, `chromeLabels` for the pill chrome inside
     * it. Any listing that folds onto a phone next should do the same; a sheet
     * mounted without them falls back to the design system's English literals,
     * which `check-used-keys` cannot see.
     */
    sheetLabels,
    filters: tableState.filters,
    filterFields,
    filterLabels,
    filterKinds,
    filterOptions,
    updateClauseOp,
    updateClauseValue,
    removeClause,
    addClause,
    clearClauses,
  };
}
