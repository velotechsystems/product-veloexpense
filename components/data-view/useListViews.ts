'use client';

/**
 * The saved-views wiring a listing page needs, in one hook.
 *
 * Every page that offers saved views repeats the same sixty lines: build the system
 * views, call `useSavedViews`, write a `loadView` that branches on system-vs-user, a
 * `captureViewState` that reads the table state back, three `window.prompt`/`confirm`
 * handlers, and a one-shot effect that applies the reader's pinned view on first load.
 * Four pages had already copied it, and the copies had begun to differ — one restored
 * `groupBy`, another did not; one reset `sort` on a system view, another left it.
 *
 * This is that wiring, returning the prop bag `FilterPillBar`'s `savedViews` takes. A page
 * supplies what is actually its own: which resource it persists under, and what its system
 * views are.
 *
 * The one-shot pinned-view effect is the part worth not re-deriving. It has to fire when
 * the views first ARRIVE (they are fetched) and never again — a later refetch re-running it
 * would yank the reader back to their default mid-session, which reads as the page
 * resetting itself while they work.
 */

import { useEffect, useRef, useState } from 'react';
import type { DataTableState } from './DataTable';
import { newClauseId, type PersistedViewState, type SystemView } from './types';
import { type SavedViewResource, useSavedViews } from './useSavedViews';

export interface ListViewsLabels {
  /** `window.prompt` title when saving the current state as a new view. */
  namePrompt: string;
  /** Pre-filled name in that prompt. */
  nameDefault: string;
  /** `window.prompt` title when renaming. */
  renamePrompt: string;
  /** `window.confirm` text before deleting; receives the view's name. */
  deleteConfirm: (name: string) => string;
}

export function useListViews<C extends string>({
  resource,
  systemViews,
  columnIds,
  tableState,
  setTableState,
  labels,
}: {
  resource: SavedViewResource;
  systemViews: SystemView<C>[];
  /** Every column id, so a saved view can restore which ones were visible. */
  columnIds: readonly C[];
  tableState: DataTableState<C>;
  setTableState: React.Dispatch<React.SetStateAction<DataTableState<C>>>;
  labels: ListViewsLabels;
}) {
  const [activeViewId, setActiveViewId] = useState<string>(systemViews[0]?.id ?? 'sys:default');
  const {
    allViews,
    createView,
    renameView,
    deleteView: deleteSavedView,
    togglePinnedView,
  } = useSavedViews<C>({
    resource,
    systemViews,
    onAfterCreate: (id) => setActiveViewId(id),
    onAfterDelete: () => setActiveViewId(systemViews[0]?.id ?? 'sys:default'),
  });

  const loadView = (id: string) => {
    const target = allViews.find((v) => v.id === id);
    if (!target) return;
    setActiveViewId(id);
    if (target.kind === 'system') {
      setTableState((s) => ({
        ...s,
        // Fresh clause ids: the same view selected twice must not reuse ids the pill bar
        // is already keying rows by.
        filters: target.filters?.map((f) => ({ ...f, id: newClauseId() })) ?? [],
        sort: null,
        // A view switch is a different set of rows; carrying a selection across it means
        // a bulk action aimed at rows nobody can see any more.
        selectedIds: new Set<string>(),
      }));
      return;
    }
    const v = target.state;
    const visible = v.visibleColumns;
    setTableState((s) => ({
      ...s,
      filters: v.filters.map((f) => ({ ...f, id: newClauseId() })),
      sort: v.sort ?? null,
      density: v.density ?? s.density,
      // `PersistedViewState.groupBy` is pinned to the People-domain union for
      // router-schema compatibility (see `types.ts`), while a table's own `groupBy` is
      // its column union. The stored value is only ever a column id this page grouped by,
      // so the cast is at the seam between those two spellings of the same thing.
      groupBy: (v.groupBy ?? null) as C | null,
      columnVisibility: visible
        ? Object.fromEntries(columnIds.map((id) => [id, visible.includes(id)]))
        : s.columnVisibility,
      selectedIds: new Set<string>(),
    }));
  };

  const captureViewState = (): PersistedViewState<C> => ({
    filters: tableState.filters,
    visibleColumns: tableState.columnOrder.filter(
      (id) => tableState.columnVisibility[id] !== false,
    ),
    sort: tableState.sort ?? undefined,
    density: tableState.density,
    groupBy: (tableState.groupBy ?? null) as PersistedViewState<C>['groupBy'],
  });

  // Applied once, when the views first arrive. Guarded by a ref so a later refetch cannot
  // yank the reader back to their default mid-session.
  const didApplyDefaultRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot — see the header
  useEffect(() => {
    if (didApplyDefaultRef.current || allViews.length === 0) return;
    const pinned = allViews.find((v) => v.kind === 'user' && v.pinned);
    didApplyDefaultRef.current = true;
    if (pinned) loadView(pinned.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- VeloExpense: the same one-shot exemption, for ESLint.
  }, [allViews]);

  /**
   * Rebuilt every render, deliberately not memoised. `loadView` and `captureViewState`
   * close over the CURRENT table state, so a memo would have to list it as a dependency
   * and would then rebuild on every keystroke anyway — while a memo that did not would
   * hand back a bag that saves a stale view.
   */
  return {
    views: allViews,
    activeViewId,
    onSelectView: loadView,
    onSaveAsNew: () => {
      const name = window.prompt(labels.namePrompt, labels.nameDefault);
      if (!name?.trim()) return;
      createView(name.trim(), captureViewState(), false);
    },
    onRenameView: (id: string, currentName: string) => {
      const name = window.prompt(labels.renamePrompt, currentName);
      if (!name?.trim() || name.trim() === currentName) return;
      renameView(id, name.trim());
    },
    onDeleteView: (id: string, name: string) => {
      if (!window.confirm(labels.deleteConfirm(name))) return;
      deleteSavedView(id);
    },
    onTogglePinned: togglePinnedView,
  };
}
