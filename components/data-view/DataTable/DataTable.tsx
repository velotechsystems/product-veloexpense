'use client';

import {
  CARDS_ONLY,
  Checkbox,
  type ColumnFilter,
  ColumnHeader,
  cls,
  DENSITY_PADDING,
  GroupHeaderRow,
  ROW_STATE_CLASSES,
  rowStateOf,
  Scroll2D,
  type SortDir,
  TABLE_ONLY,
  useColumnDrag,
  useColumnFlip,
  useIsCompact,
} from '@expenseos/design-system';
import {
  IconArrowsMove,
  IconChevronDown,
  IconChevronRight,
  IconGripVertical,
} from '@tabler/icons-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { newClauseId, VALUELESS_OPS } from '../types';
import { DataTableCards } from './DataTableCards';
import { groupRows, type RowGroup } from './groupRows';
import { resolveSortField, sortRows } from './sortRows';
import type { ColumnDef, DataTableProps, DataTableState, FilterClause } from './types';
import { useStickyLayout } from './useStickyLayout';

const SELECT_COLUMN_WIDTH = 44;
const ROW_DND_HANDLE_WIDTH = 32;
const EXPAND_COLUMN_WIDTH = 36;

/** Estimated uniform row height per density, used by row virtualization. */
const ROW_HEIGHT_BY_DENSITY: Record<string, number> = {
  compact: 36,
  normal: 44,
  comfortable: 52,
};

/**
 * Move `dragId` to `overId`'s slot within an id list (splice-move).
 * Pure + exported for unit testing the row-reorder reducer.
 */
export function moveRow(ids: string[], dragId: string, overId: string): string[] {
  if (dragId === overId) return ids;
  const from = ids.indexOf(dragId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, dragId);
  return next;
}

/**
 * Generic directory-style data table. See ./types.ts for the
 * contract. Each consumer plugs in:
 *
 *   - `columns` (ColumnDef[]) — what cells to render
 *   - `rows` (Row[]) — the data
 *   - `state` + `onStateChange` — controlled state
 *   - `onRowClick` — row interaction (typically opens a drawer)
 *
 * The table owns: layout, sticky pinning, drag-reorder + FLIP,
 * resize, column header dropdown (sort/filter/pin/auto-size/hide),
 * selection, and Scroll2D bounding.
 */
export function DataTable<Row, ColumnId extends string = string>(
  props: DataTableProps<Row, ColumnId>,
) {
  const {
    columns,
    rows: rawRows,
    rowKey,
    loading = false,
    state,
    onStateChange,
    onRowClick,
    activeRowId = null,
    selectable = false,
    rowSelectable,
    facetCounts,
    renderEmpty,
    plainHeaders = false,
    labels,
    sortFieldFor,
    hasNextPage,
    isFetchingNextPage,
    onLoadMore,
    disableInfiniteScroll = false,
    sortMode = 'client',
    groupKeyFor,
    groupLabelFor,
    groupCountLabel,
    rowDnd,
    renderExpanded,
    virtualizeRows = false,
    rowHeight,
    layout = 'auto',
    mobile,
  } = props;

  /**
   * Which tree mounts: the table, or the compact card list.
   *
   * The decision is made HERE, in JS, and exactly one tree is returned —
   * rather than rendering both and letting CSS hide one. Two trees would
   * mean two copies of every row in the DOM: duplicate matches for every
   * `getByRole`, doubled work on every state change, and two elements
   * competing for the same `id`. The `CARDS_ONLY` / `TABLE_ONLY` classes
   * composed onto the returned tree are a cloak, not the mechanism — they
   * only cover the window between SSR (which has no viewport, so
   * `useIsCompact` reports `false` and the server always emits the table)
   * and hydration, so a phone never flashes a table it is about to
   * replace.
   *
   * The hook is called unconditionally, above every early return, because
   * it is a hook. `layout` overrides it in both directions.
   *
   * ── `'auto'` IS GATED ON THE OPT-IN, AND THAT IS THE CONTRACT ──────
   *
   * Cards are per-page opt-in. A table that has not named its card columns
   * keeps the horizontal scroller it has today — the table tree inside
   * `<Scroll2D>`, whose `overflow-x` contains it — and does NOT get a
   * degenerate card list.
   *
   * This gate was missing and the omission was silent, which is why it is
   * spelled out here. Without it every listing below 768px took the card
   * branch, configured or not, and an unconfigured card falls back to the
   * first visible column for its title and renders no field rows at all —
   * see `DataTableCards`. On the three bare `<DataTable>`s the dashboard
   * mounts that meant one column per card and the rest of the row simply
   * gone: "My expense reports" showed the report and dropped total, updated
   * and status. A dropped column is worse than a wide one. An overflowing
   * table can still be scrolled to; a column that was never drawn cannot be
   * reached by any gesture, and nothing on screen says it is missing.
   *
   * `title` rather than a bare `mobile !== undefined` check. It is the one
   * field a card cannot do without, and it is exactly what the degenerate
   * fallback was substituting for. `fields` is deliberately NOT part of the
   * test: an empty field list is a legal, documented outcome (every
   * configured column hidden by the reader leaves a title-and-badge card),
   * so requiring it would drop a page back to the table for exercising a
   * setting. The type already requires `title`, so this only catches a
   * config assembled outside TypeScript.
   *
   * `layout="cards"` still forces the card tree with no config at all. That
   * is the explicit, deliberate request — a surface that is card-shaped at
   * every width — and the fallback title exists precisely to keep it
   * rendering something recognisable.
   */
  const isCompact = useIsCompact();
  /** Has this page named its card columns? See the note above. */
  const hasCardConfig = mobile?.title !== undefined;
  const compact = layout === 'cards' || (layout === 'auto' && isCompact && hasCardConfig);

  /**
   * Whether the returned tree needs a CLOAK — and it usually does not.
   *
   * The cloak covers exactly one window: SSR has no viewport, so
   * `useIsCompact` reports `false` and the server always emits the TABLE; on
   * a phone that markup has to be hidden until hydration swaps in the cards.
   * That window only exists when the two trees can disagree, which is when
   * `'auto'` can actually reach the card tree — `layout === 'auto'` AND the
   * page has opted in.
   *
   * In every other case the cloak is not merely redundant, it is WRONG, and
   * applying it unconditionally (as this did) hid real content:
   *
   *   - `'auto'` with no config now returns the table at every width. Cloaked
   *     `hidden md:block`, that table would be invisible below 768px — so the
   *     opt-in gate above, on its own, would have turned a silent column loss
   *     on 41 of the 42 listings that mount `<DataTable>` into a silent
   *     whole-table loss. Caught before it shipped; this is why the two
   *     changes are one commit.
   *   - `layout="cards"` returns the card tree at every width. Cloaked
   *     `md:hidden`, a deliberately card-shaped surface would vanish on a
   *     desktop. Latent today (no page passes `layout`), wrong regardless.
   *   - `layout="table"` returns the table at every width, and `hidden
   *     md:block` would have hidden it on a phone — the same latent bug.
   *
   * jsdom applies no CSS, so no unit test could have caught any of these.
   */
  const cloaked = layout === 'auto' && hasCardConfig;

  /**
   * The rows actually rendered, in the order the header arrow claims.
   *
   * `state.sort` used to be recorded and drawn and never applied — sorting was left to
   * the consumer, as filtering still is, and only nine of the twenty-one listings did it.
   * The rest drew an indicator that meant nothing (GA readiness report F04). A listing
   * that sorts for itself passes `sortMode="external"`; everything else gets this.
   *
   * Row drag-and-drop is an explicit order the person is setting by hand, so a sort would
   * fight it — those listings gate drag on there being no sort, and this respects the
   * same rule by leaving the rows alone while a drag order is held.
   */
  const rows = useMemo(
    () => (sortMode === 'external' ? rawRows : sortRows(rawRows, state.sort, columns)),
    [rawRows, sortMode, state.sort, columns],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);

  /**
   * The CARD tree's scroll container. A second ref, not a reuse of
   * `scrollRef`.
   *
   * `scrollRef` is the table's: it is attached to `<Scroll2D>`, and it is
   * read by `useStickyLayout` (which queries it for a `<table>`) and by
   * `useRowWindow`. Pointing it at a `<ul>` would leave both hooks looking
   * at an element whose contract they do not share, and it would make
   * "which tree is mounted" something you reconstruct from the ref's
   * contents. Two refs, one per tree, exactly one attached at any moment.
   */
  const cardScrollRef = useRef<HTMLDivElement | null>(null);

  // ─── Row expansion + inline cell editing (both opt-in) ─────────
  const expandable = Boolean(renderExpanded);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [editingCell, setEditingCell] = useState<{ key: string; col: ColumnId } | null>(null);
  const toggleExpanded = (id: string) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ─── Row drag-and-drop (flat lists only) ───────────────────────
  // Transient order held internally during a drag; committed to the
  // consumer via `rowDnd.onReorder` on drop. Disabled while grouped.
  const [rowDragId, setRowDragId] = useState<string | null>(null);
  const [rowDragOrder, setRowDragOrder] = useState<string[] | null>(null);
  const isGrouped = Boolean(state.groupBy && groupKeyFor);
  const rowDndActive = Boolean(rowDnd) && !isGrouped;

  // ─── Derived: column lookup + visible columns ──────────────────
  const columnById = useMemo(() => {
    const m = new Map<ColumnId, ColumnDef<Row, ColumnId>>();
    for (const c of columns) m.set(c.id, c);
    return m;
  }, [columns]);

  const visibleColumnIds = useMemo<ColumnId[]>(() => {
    return state.columnOrder.filter((id) => {
      const def = columnById.get(id);
      if (!def) return false;
      // Visible unless explicitly hidden. Default = visible.
      return state.columnVisibility[id] !== false;
    });
  }, [state.columnOrder, state.columnVisibility, columnById]);

  // ─── Sticky layout (pinned column offsets + scrollbar insets) ──
  // Leading band, left → right: expand chevron, drag grip, select checkbox.
  const expandLeft = 0;
  const dndLeft = expandable ? EXPAND_COLUMN_WIDTH : 0;
  const selectLeft = dndLeft + (rowDndActive ? ROW_DND_HANDLE_WIDTH : 0);
  const sticky = useStickyLayout({
    columns,
    state,
    selectColumnWidth:
      (expandable ? EXPAND_COLUMN_WIDTH : 0) +
      (rowDndActive ? ROW_DND_HANDLE_WIDTH : 0) +
      (selectable ? SELECT_COLUMN_WIDTH : 0),
  });

  // ─── State helpers ─────────────────────────────────────────────
  const update = (partial: Partial<DataTableState<ColumnId>>) =>
    onStateChange({ ...state, ...partial });

  // Filter clauses: column header → FilterClause[] adapter. The
  // column header speaks `ColumnFilter | null`; we expand to
  // clauses (per-value pills) to match the data-view chrome.
  const setColumnFilter = (col: ColumnId, next: ColumnFilter | null) => {
    const without = state.filters.filter((c) => c.field !== col);
    if (next === null) {
      update({ filters: without });
      return;
    }
    const expanded = columnFilterToClauses(col, next);
    update({ filters: [...without, ...expanded] });
  };

  // Sort: cycle asc → desc → none on header click, or set
  // explicitly from the dropdown.
  const setSort = (field: string, dir: SortDir) => {
    update({ sort: { field, dir } });
  };

  // Column visibility
  const hideColumn = (col: ColumnId) => {
    update({ columnVisibility: { ...state.columnVisibility, [col]: false } });
  };

  // Pin / unpin
  const pinColumn = (col: ColumnId, side: 'left' | 'right') => {
    // Remove from any existing pin side
    const left = state.pinnedColumns.left.filter((c) => c !== col);
    const right = state.pinnedColumns.right.filter((c) => c !== col);
    if (side === 'left') left.push(col);
    else right.push(col);
    // Reorder: pinned-left at start, pinned-right at end. Within
    // each band, preserve the pin-add order. Unpinned middle keeps
    // current order.
    const newOrder = reorderForPinning(state.columnOrder, { left, right });
    update({
      pinnedColumns: { left, right },
      columnOrder: newOrder,
    });
  };
  const unpinColumn = (col: ColumnId) => {
    const left = state.pinnedColumns.left.filter((c) => c !== col);
    const right = state.pinnedColumns.right.filter((c) => c !== col);
    update({ pinnedColumns: { left, right } });
  };

  // Resize
  const startResize = (col: ColumnId, e: React.MouseEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = sticky.widthOf(col);
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(60, startWidth + ev.clientX - startX);
      onStateChange({
        ...state,
        columnWidths: { ...state.columnWidths, [col]: next },
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Auto-size: walks the headers + body rows for this column,
  // finds the widest scrollWidth, sets the width to that + 24 px.
  const autoSizeColumn = (col: ColumnId) => {
    const tableEl = scrollRef.current?.querySelector('table');
    if (!tableEl) return;
    const headerCell = tableEl.querySelector<HTMLElement>(`th[data-col="${col}"]`);
    if (!headerCell?.parentElement) return;
    const colIndex = Array.from(headerCell.parentElement.children).indexOf(headerCell);
    if (colIndex < 0) return;
    let widest = headerCell.scrollWidth;
    for (const row of tableEl.querySelectorAll<HTMLElement>('tbody tr')) {
      const cell = row.children[colIndex] as HTMLElement | undefined;
      if (cell) widest = Math.max(widest, cell.scrollWidth);
    }
    const next = Math.min(Math.max(widest + 24, 60), 600);
    onStateChange({
      ...state,
      columnWidths: { ...state.columnWidths, [col]: next },
    });
  };

  // ─── Column drag (pointer-based + FLIP) ─────────────────────────
  const isSwappable = (id: string) => {
    return (
      !state.pinnedColumns.left.includes(id as ColumnId) &&
      !state.pinnedColumns.right.includes(id as ColumnId)
    );
  };
  const { drag, pendingFlipOldX, beginDrag } = useColumnDrag({
    scrollRef,
    isSwappable,
    onSwap: (source, target) => {
      const next = [...state.columnOrder];
      const srcIdx = next.indexOf(source as ColumnId);
      const tgtIdx = next.indexOf(target as ColumnId);
      if (srcIdx < 0 || tgtIdx < 0) return;
      next.splice(srcIdx, 1);
      next.splice(tgtIdx, 0, source as ColumnId);
      onStateChange({ ...state, columnOrder: next });
    },
  });
  useColumnFlip({ scrollRef, columnOrder: state.columnOrder, pendingFlipOldX });

  // ─── Selection helpers ─────────────────────────────────────────
  const toggleSelectRow = (id: string) => {
    const next = new Set(state.selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onStateChange({ ...state, selectedIds: next });
  };
  /**
   * Rows a bulk action could actually apply to.
   *
   * `rowSelectable` lets a consumer say a row is ineligible — an import preview row for a
   * card that already exists, say. Select-all then means "all the ones this could apply
   * to", which is the only reading that does not silently include rows the action will
   * drop: a header checkbox that ticks 300 rows and then imports 12 of them describes
   * neither number.
   */
  const selectableRows = rowSelectable ? rows.filter((r) => rowSelectable(r)) : rows;
  const allVisibleSelected =
    selectableRows.length > 0 && selectableRows.every((r) => state.selectedIds.has(rowKey(r)));
  const someVisibleSelected =
    !allVisibleSelected && selectableRows.some((r) => state.selectedIds.has(rowKey(r)));
  const toggleSelectAll = (checked: boolean) => {
    const next = new Set(state.selectedIds);
    for (const r of selectableRows) {
      if (checked) next.add(rowKey(r));
      else next.delete(rowKey(r));
    }
    onStateChange({ ...state, selectedIds: next });
  };

  // ─── Row click ─────────────────────────────────────────────────
  const handleRowClick = (e: React.MouseEvent, row: Row) => {
    if (!onRowClick) return;
    // Bail if click landed on a nested interactive.
    //
    // The role selectors are not belt-and-braces: the design system's Checkbox is a
    // Base UI primitive that renders a `<span role="checkbox">`, so a tag-only guard
    // let every selection tick fall through to the row and open the record drawer —
    // which made choosing rows for a bulk action a fight with the drawer.
    const target = e.target as HTMLElement;
    if (
      target.closest(
        'button, a, input, label, [role="checkbox"], [role="button"], [role="switch"], [role="menuitem"]',
      )
    )
      return;
    onRowClick(row);
  };

  // Padding utility for body cells based on density.
  const padY = DENSITY_PADDING[state.density];
  const colSpan =
    (expandable ? 1 : 0) + (rowDndActive ? 1 : 0) + (selectable ? 1 : 0) + visibleColumnIds.length;

  // ─── Row virtualization (opt-in, uniform-height rows only) ─────
  // Falls back to a full render when grouping or detail-panel expansion is
  // active (those break the uniform-height assumption). `vwin` (the visible
  // range) is computed below, once `orderedRows` exists.
  // Card mode forces it off at the SOURCE rather than at the render site:
  // `virtual` feeds `useRowWindow`, the spacer rows and the row slice, and a
  // stale `true` here would have the window hook measuring a `scrollRef` that
  // the card tree never attaches. (It would survive — the effect bails on
  // `if (!enabled)` before it ever reads the ref — but "survives by accident"
  // is not the property we want on the path that decides which rows exist.)
  const virtual = virtualizeRows && !isGrouped && !expandable && !compact;
  const rowH = rowHeight ?? ROW_HEIGHT_BY_DENSITY[state.density];

  // ─── Row-DnD derived state + handlers ──────────────────────────
  const rowById = useMemo(() => {
    const m = new Map<string, Row>();
    for (const r of rows) m.set(rowKey(r), r);
    return m;
  }, [rows, rowKey]);

  const orderedRows = useMemo(() => {
    if (!rowDragOrder) return rows;
    const seen = new Set(rowDragOrder);
    const reordered = rowDragOrder.map((id) => rowById.get(id)).filter((r): r is Row => r != null);
    const extras = rows.filter((r) => !seen.has(rowKey(r)));
    return [...reordered, ...extras];
  }, [rowDragOrder, rows, rowById, rowKey]);

  const canDragRow = (row: Row) => rowDndActive && (rowDnd?.canDrag ? rowDnd.canDrag(row) : true);

  // Visible row range for virtualization (full range when disabled).
  const vwin = useRowWindow(scrollRef, orderedRows.length, rowH, virtual);

  const handleRowDragStart = (id: string) => {
    setRowDragId(id);
    setRowDragOrder(orderedRows.map(rowKey));
  };
  const handleRowDragOver = (overId: string, e: React.DragEvent) => {
    e.preventDefault();
    if (!rowDragId || rowDragId === overId) return;
    const overRow = rowById.get(overId);
    if (overRow && !canDragRow(overRow)) return; // can't displace a fixed row
    setRowDragOrder((prev) => moveRow(prev ?? orderedRows.map(rowKey), rowDragId, overId));
  };
  const handleRowDragEnd = () => {
    if (rowDragOrder && rowDnd) rowDnd.onReorder(rowDragOrder);
    setRowDragId(null);
    setRowDragOrder(null);
  };

  // Row renderer — extracted so both the flat (ungrouped) and
  // grouped tbody branches can reuse it. Keeps the per-row chrome
  // (sticky select cell, pinned column offsets, hover / selected /
  // active visuals) in one place.
  const renderRow = (row: Row, rowIndex: number) => {
    const id = rowKey(row);
    const isSelected = state.selectedIds.has(id);
    const isActive = activeRowId === id;
    const isExpanded = expandable && expandedKeys.has(id);
    // Resolve the canonical row state + per-DOM-node classes via the
    // shared DS tokens. `active` wins over `selected` (see rowState.ts).
    const stateClasses = ROW_STATE_CLASSES[rowStateOf({ isSelected, isActive })];
    const draggable = canDragRow(row);
    return (
      <Fragment key={id}>
        <tr
          id={`data-row-${id}`}
          /* Shared with the card tree's <li>. See `useScrollAnchor`: the two
             trees' `id` prefixes are deliberately different so they can never
             collide, which is exactly what makes them useless as the anchor's
             selector. This attribute is the one thing both trees agree on. */
          data-dt-row-key={id}
          draggable={rowDndActive ? draggable : undefined}
          onDragStart={rowDndActive && draggable ? () => handleRowDragStart(id) : undefined}
          onDragOver={rowDndActive ? (e) => handleRowDragOver(id, e) : undefined}
          onDragEnd={rowDndActive ? handleRowDragEnd : undefined}
          onClick={(e) => handleRowClick(e, row)}
          className={cls(
            'group border-border/40 border-b transition-colors last:border-b-0',
            /**
             * The pointer is a PROMISE that clicking here does something, and it used to sit
             * on every row of every listing — including the ten of thirty-nine mounts that
             * pass no `onRowClick` at all, where clicking a row does nothing whatsoever.
             *
             * WHAT ELSE THIS CLASS WAS HOLDING UP. `cursor` inherits, so anything in the row
             * with no cursor of its own took the row's. Measured in Chrome rather than
             * assumed: `<button>`, `<input>` and `<select>` are given `cursor: default` by
             * the UA stylesheet, which beats inheritance, so no button in any row was ever
             * getting its pointer from here. A `<span>` is — and the design system's
             * `Checkbox` is a Base UI primitive that renders `<span role="checkbox">`. That
             * one control WOULD have lost its pointer on the selectable tables that pass no
             * `onRowClick`, so it now declares its own; so, on the same pass and for
             * consistency rather than for repair, do DS `Button` and the expand chevron
             * below. Anchors were never involved: `a[href]` gets a pointer from the UA sheet.
             */
            onRowClick && 'cursor-pointer',
            rowDragId === id && 'opacity-50',
            stateClasses.row,
          )}
        >
          {expandable && (
            <td
              style={{ left: expandLeft, width: EXPAND_COLUMN_WIDTH }}
              className={cls(
                'sticky z-10 px-1 text-center align-middle',
                padY,
                stateClasses.leadingCell,
              )}
            >
              <button
                type="button"
                aria-label={
                  isExpanded
                    ? (labels.collapseRow ?? 'Collapse row')
                    : (labels.expandRow ?? 'Expand row')
                }
                aria-expanded={isExpanded}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpanded(id);
                }}
                // `cursor-pointer` explicitly. Not a repair — Chrome's UA sheet gives a
                // `<button>` `cursor: default` and always did, so this never inherited the
                // row's pointer. On a table with no `onRowClick` the chevron is the row's
                // only affordance, and it should look like one.
                className="mx-auto flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {isExpanded ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
              </button>
            </td>
          )}
          {rowDndActive && (
            <td
              className={cls(
                'sticky z-10 px-1 text-center align-middle',
                padY,
                stateClasses.leadingCell,
              )}
              style={{ left: dndLeft, width: ROW_DND_HANDLE_WIDTH }}
            >
              {draggable && (
                <IconGripVertical
                  size={14}
                  aria-label={labels.dragToReorder ?? 'Drag to reorder'}
                  className="mx-auto cursor-grab text-muted-foreground"
                />
              )}
            </td>
          )}
          {selectable && (
            <td
              style={{ left: selectLeft }}
              className={cls(
                'sticky z-10 w-11 px-3 text-center align-middle',
                padY,
                stateClasses.leadingCell,
              )}
            >
              <Checkbox
                checked={isSelected}
                disabled={rowSelectable ? !rowSelectable(row) : false}
                onCheckedChange={() => toggleSelectRow(id)}
                aria-label={labels.selectRow ?? 'Select row'}
              />
            </td>
          )}
          {visibleColumnIds.map((colId) => {
            const def = columnById.get(colId);
            if (!def) return null;
            const pinnedSide = state.pinnedColumns.left.includes(colId)
              ? 'left'
              : state.pinnedColumns.right.includes(colId)
                ? 'right'
                : null;
            const stickyLeft = pinnedSide === 'left' ? sticky.leftOffsets.get(colId) : undefined;
            const stickyRight = pinnedSide === 'right' ? sticky.rightOffsets.get(colId) : undefined;
            const cellStyle: React.CSSProperties =
              stickyLeft !== undefined
                ? { left: stickyLeft }
                : stickyRight !== undefined
                  ? { right: stickyRight }
                  : {};
            const isEditing = editingCell?.key === id && editingCell?.col === colId;
            const ctx = { rowIndex, depth: 0, isSelected, isActive };
            return (
              <td
                key={colId}
                style={cellStyle}
                className={cls(
                  'px-4',
                  // `break-words` so a long token wraps INSIDE its own column instead of
                  // spilling across the next one. Under `table-layout: fixed` a cell whose
                  // content is wider than its column overflows visibly, and a browser will
                  // not break on `/` — so the fr-CA category
                  // "Messagerie/Expédition/Affranchissement" ran straight through the
                  // Status column and read as "…AffranchissementOuverte" (GA readiness
                  // report F43). Wrapping is preferred to clipping here because cells carry
                  // popovers and menus, and `overflow: hidden` would cut those off.
                  'break-words',
                  padY,
                  pinnedSide && 'sticky z-10',
                  // Apply `stateClasses.cell` to EVERY cell (sticky or
                  // not). Putting bg on the row instead of the cells
                  // creates an asymmetry between the leading sticky
                  // cell (which sets its own bg) and body cells (which
                  // inherit the row's bg) — visible during hover /
                  // transition. With every cell owning its bg, the
                  // leading and body cells render identically.
                  stateClasses.cell,
                )}
              >
                {isEditing && def.editable ? (
                  def.editable(row, { close: () => setEditingCell(null) })
                ) : def.editable ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingCell({ key: id, col: colId });
                    }}
                    title={labels.colMenu.filter}
                    className="-mx-1 block w-full rounded px-1 text-left hover:bg-muted/50"
                  >
                    {def.cell(row, ctx)}
                  </button>
                ) : (
                  def.cell(row, ctx)
                )}
              </td>
            );
          })}
        </tr>
        {isExpanded && renderExpanded && (
          <tr className={cls('border-border/40 border-b bg-muted/20')}>
            <td colSpan={colSpan} className="px-4 py-3">
              {renderExpanded(row)}
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  // ─── Group-by partitioning ─────────────────────────────────────
  // The partition itself lives in `./groupRows`, because the CARD tree
  // needs the identical one — same rows under the same headers, in the
  // same order, with the same collapsed and selected verdicts. Two copies
  // of it would agree today and drift the first time either surface is
  // touched. Same discipline as `groupClauses` in the design system.
  //
  // Note what is passed: `rows`, NOT `orderedRows`. `rows` is already
  // client-sorted (see its `useMemo` above), so grouping runs AFTER the
  // sort and the two compose — the groups appear in the order the sorted
  // list first reaches them. What `rows` leaves out is the row-DRAG order,
  // which `orderedRows` adds on top: grouping and a hand-dragged order do
  // not compose, exactly as when this was inline here, and this extraction
  // does not quietly change that on every grouped page at once.
  const groups: RowGroup<Row>[] = useMemo(
    () =>
      groupRows(rows, {
        groupBy: state.groupBy,
        groupKeyFor,
        groupLabelFor,
        rowKey,
        selectedIds: state.selectedIds,
        collapsedGroups: state.collapsedGroups,
      }),
    [
      state.groupBy,
      state.collapsedGroups,
      state.selectedIds,
      rows,
      rowKey,
      groupKeyFor,
      groupLabelFor,
    ],
  );

  // Toggle one group's collapsed flag.
  const toggleGroupCollapsed = (key: string) => {
    const next = new Set(state.collapsedGroups ?? []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onStateChange({ ...state, collapsedGroups: next });
  };
  // Toggle selection for every row in a group at once.
  const toggleGroupSelection = (group: RowGroup<Row>) => {
    const next = new Set(state.selectedIds);
    if (group.allSelected) {
      for (const r of group.rows) next.delete(rowKey(r));
    } else {
      for (const r of group.rows) next.add(rowKey(r));
    }
    onStateChange({ ...state, selectedIds: next });
  };

  // ─── Crossing the breakpoint ───────────────────────────────────
  /**
   * WHAT ACTUALLY HAPPENS WHEN THE VIEWPORT CROSSES 768px.
   *
   * This comment used to say the flip "unmounts one tree and mounts the
   * other, so a `useState` on either side of the branch resets on rotate".
   * The first half is true and the second half is false, and the plan for
   * this phase was written on the strength of the false half — so it is
   * worth being exact, because the two readings ask for opposite code.
   *
   * The branch below is an EARLY RETURN inside `DataTable()`. `DataTable`
   * itself does not unmount when `compact` flips; only the subtree it
   * returns is swapped. So:
   *
   *   - State declared BELOW the branch cannot exist at all — a hook after
   *     a conditional return is a conditional hook. That is the real reason
   *     nothing below this line may introduce state, and it has nothing to
   *     do with remounting.
   *   - State declared inside `DataTableCards` genuinely does reset, because
   *     that component IS unmounted. Hence its own no-`useState` rule.
   *   - State declared ABOVE the branch — `expandedKeys`, `editingCell`,
   *     `rowDragId`, `rowDragOrder` — SURVIVES. React keeps the hooks of a
   *     component instance that is still mounted, and this one is.
   *
   * That survival is not a happy accident, it is the failure mode. Card
   * mode renders no inline editor and no drag handle, so a half-finished
   * edit stays live and invisible: still in state, still able to be
   * committed or blurred by something the person cannot see, and back on
   * screen the moment they rotate again. Same for an uncommitted row
   * reorder. The two effects below therefore CANCEL them on purpose. The
   * cancel is the feature; without it, nothing would have reset and the
   * bug would have been silence rather than loss.
   *
   * Consumer state (`selectedIds`, `sort`, `filters`, `columnOrder`,
   * `columnVisibility`, `density`, `groupBy`, `collapsedGroups`) lives in
   * the `state` prop and was never at risk from either reading.
   */
  const wasCompact = useRef(compact);
  useEffect(() => {
    if (wasCompact.current === compact) return;
    wasCompact.current = compact;

    /**
     * Cancel, visibly.
     *
     * `editingCell` closes the editor. On the table→cards leg the editor is
     * about to stop rendering anyway, so "visible" means the person does not
     * find it re-opened on the way back with text they typed a rotation ago
     * and no longer expects; on the cards→table leg — reachable by flipping
     * twice — it is the difference between an empty cell and a stale open
     * input. Uncommitted keystrokes are lost. That is the accepted loss the
     * risk register named, and losing them at a moment the person can see
     * beats keeping them somewhere they cannot.
     *
     * `rowDragOrder` reverts to the consumer's order. Dropping it rather
     * than committing it is deliberate: `rowDnd.onReorder` persists, and a
     * rotation is not consent to persist a reorder that was still mid-drag.
     *
     * `expandedKeys` is deliberately NOT cleared. It is not in-progress
     * work — it holds no unsaved input and discarding it destroys nothing —
     * and it is not shown in card mode, so leaving it alone is invisible
     * while compact and restores the rows the person had open when they
     * come back. Clearing it would be a loss with no corresponding risk.
     *
     * Ordering note, honestly: this state update commits AFTER the scroll
     * restore below has already measured, so a rotate that interrupts a
     * drag can land the scroll on the pre-cancel row order. A drag in
     * progress means a pointer is held down, which makes an orientation
     * change during one close to unreachable, and the drag itself is
     * already an accepted loss — so this is not worth a layout effect and a
     * second commit to chase.
     */
    setEditingCell(null);
    setRowDragId(null);
    setRowDragOrder(null);
  }, [compact]);

  /**
   * Scroll position, which is the one thing that must survive.
   *
   * Unlike the state above, this is a GENUINE loss and no amount of hook
   * placement fixes it: the table's scroll node is `<Scroll2D>`'s div and
   * the card list's is its own, so the flip destroys the element the offset
   * lived on and mounts a fresh one at zero. Rotate after paging through
   * 500 rows and you are back at the top.
   */
  useScrollAnchor({
    compact,
    scrollRef,
    cardScrollRef,
    rowHeight: rowH,
    virtualized: virtual,
    // Read only on the fallback path, and only at flip time — see the hook.
    indexOfRowKey: (key) => orderedRows.findIndex((r) => rowKey(r) === key),
  });

  // ─── Render ────────────────────────────────────────────────────

  // Compact branch. Everything above this line is shared by both trees —
  // sorting, grouping, selection, the sticky-layout measurements — so the
  // card list gets the same rows in the same order the table would have
  // shown, without a second derivation to keep in sync.
  if (compact) {
    return (
      <DataTableCards
        className={cloaked ? CARDS_ONLY : undefined}
        scrollRef={cardScrollRef}
        columns={columns}
        rows={orderedRows}
        rowKey={rowKey}
        state={state}
        mobile={mobile}
        onRowClick={onRowClick}
        activeRowId={activeRowId}
        loading={loading}
        renderEmpty={renderEmpty}
        labels={labels}
        /**
         * Two flags, both required. `selectable` says the page has
         * selection; `mobile.selectable` says it survives the trip to a
         * card. No page sets the second one today — see the note on
         * `DataTableMobileConfig.selectable` for why inheriting the first
         * alone would have shipped checkboxes with nothing to act on.
         */
        selectable={selectable && mobile?.selectable === true}
        rowSelectable={rowSelectable}
        /**
         * The single write seam into the card tree. Not `onStateChange`:
         * one row id in, one selection toggle out, and no way to reach
         * `columnVisibility` / `columnWidths` / `density` from a phone.
         */
        onToggleSelect={toggleSelectRow}
        /**
         * The same partition the table's `<GroupHeaderRow>`s are drawn from,
         * handed over rather than re-derived. `isGrouped` gates it so an
         * ungrouped list passes `undefined` and takes the flat path, exactly
         * as the table does.
         */
        groups={isGrouped ? groups : undefined}
        groupCountLabel={groupCountLabel}
        /**
         * The second (and last) write seam into the card tree, alongside
         * `onToggleSelect`. `collapsedGroups` is ephemeral view state and is
         * not part of `PersistedViewState`, so unlike `columnVisibility` /
         * `columnWidths` / `density` a phone cannot write it into a saved
         * view. Without it a group collapsed on the desktop would arrive on
         * the phone with no way to open it again.
         */
        onToggleGroupCollapsed={toggleGroupCollapsed}
        /**
         * The sentinel is BUILT here and PLACED there.
         *
         * It has to be a descendant of its own `IntersectionObserver` root
         * or the observer never fires, and in card mode that root is
         * `cardScrollRef` — an element only the card tree renders. Handing
         * over the element (rather than six pagination props) keeps the
         * root and the sentinel in the same expression, where the pairing
         * is impossible to break silently.
         *
         * Card mode had no sentinel at all until now: phase 2's branch
         * returned before this block, so a compact listing quietly stopped
         * at page one.
         */
        sentinel={
          !disableInfiniteScroll && onLoadMore ? (
            <InfiniteScrollSentinel
              onLoadMore={onLoadMore}
              hasNextPage={hasNextPage ?? false}
              isFetching={isFetchingNextPage ?? false}
              loadingLabel={labels.loading ?? 'Loading…'}
              endLabel={labels.endOfList ?? 'End of list'}
              rootRef={cardScrollRef}
              showEnd={rows.length > 0}
            />
          ) : null
        }
      />
    );
  }

  return (
    <Scroll2D
      ref={scrollRef}
      className={cls('min-h-0 flex-1', cloaked && TABLE_ONLY)}
      insetLeft={sticky.insetLeft}
      insetRight={sticky.insetRight}
      // H scrollbar sits at the bottom edge of the visible table
      // area (Scroll2D's default). It's an overlay — always visible
      // when overflow exists, regardless of vertical scroll position.
    >
      <table
        className="text-sm"
        // `min-width: max-content` keeps horizontal scroll behaviour
        // intact when the sum of column widths exceeds the viewport,
        // while `width: 100%` lets the table stretch to the viewport
        // when columns are narrower than it — extra space gets
        // proportionally distributed across columns under
        // `table-layout: fixed`. Sticky-pinned cells use cumulative
        // pixel offsets from their CONFIGURED widths, which stay
        // accurate as long as no column carries a `width: 100%` <col>.
        style={{ minWidth: 'max-content', width: '100%', tableLayout: 'fixed' }}
      >
        <colgroup>
          {expandable && <col style={{ width: EXPAND_COLUMN_WIDTH }} />}
          {rowDndActive && <col style={{ width: ROW_DND_HANDLE_WIDTH }} />}
          {selectable && <col style={{ width: SELECT_COLUMN_WIDTH }} />}
          {visibleColumnIds.map((id) => (
            <col key={id} style={{ width: sticky.widthOf(id) }} />
          ))}
        </colgroup>

        <thead className="bg-card" data-scroll2d-header>
          <tr>
            {expandable && (
              <th
                aria-hidden
                style={{ left: expandLeft, width: EXPAND_COLUMN_WIDTH }}
                className="sticky top-0 z-30 bg-card px-1 py-2.5 shadow-[inset_0_-1px_0_var(--color-border)]"
              />
            )}
            {rowDndActive && (
              <th
                aria-hidden
                style={{ left: dndLeft, width: ROW_DND_HANDLE_WIDTH }}
                className="sticky top-0 z-30 bg-card px-1 py-2.5 shadow-[inset_0_-1px_0_var(--color-border)]"
              />
            )}
            {selectable && (
              <th
                style={{ left: selectLeft }}
                className="sticky top-0 z-30 w-11 bg-card px-3 py-2.5 text-center align-middle shadow-[inset_0_-1px_0_var(--color-border)]"
              >
                <Checkbox
                  aria-label={labels.selectAll}
                  disabled={selectableRows.length === 0}
                  checked={
                    allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false
                  }
                  onCheckedChange={(c) => toggleSelectAll(c === true)}
                />
              </th>
            )}
            {visibleColumnIds.map((id) => {
              const def = columnById.get(id);
              if (!def) return null;
              const pinnedSide = state.pinnedColumns.left.includes(id)
                ? 'left'
                : state.pinnedColumns.right.includes(id)
                  ? 'right'
                  : null;
              const stickyLeft = pinnedSide === 'left' ? sticky.leftOffsets.get(id) : undefined;
              const stickyRight = pinnedSide === 'right' ? sticky.rightOffsets.get(id) : undefined;

              /**
               * Only offer the arrow where a click will actually reorder something.
               *
               * A `sortable: true` column with no export accessor has no comparable value,
               * so client sorting cannot honour it — and drawing the affordance anyway is
               * how F04 looked from the outside: an indicator that appeared, and rows that
               * did not move. `sortMode="external"` keeps its arrow regardless, because
               * there the listing is doing the work.
               *
               * The rule itself lives in `sortRows.ts` because the mobile
               * `<SortSheet>` has to answer the same question with no header
               * row to hang it off, and two copies of it would be two
               * different answers.
               */
              const sortFieldStr = resolveSortField(def, rows, { sortMode, sortFieldFor });

              const activeFilter = filterClauseToColumnFilter(state.filters, id);
              const options =
                def.filterable?.options ??
                facetCounts?.[id]?.map((o) => ({
                  value: o.value,
                  label: o.label ?? o.value,
                })) ??
                [];

              return (
                <ColumnHeader
                  key={id}
                  col={id as string}
                  label={def.label}
                  stickyLeft={stickyLeft}
                  stickyRight={stickyRight}
                  sortField={sortFieldStr as string | null}
                  sortState={state.sort ?? { field: '', dir: 'asc' as SortDir }}
                  onSort={(field, dir) => setSort(field, dir)}
                  filterable={!!def.filterable}
                  filterType={def.filterable?.kind ?? 'text'}
                  activeFilter={activeFilter}
                  filterOptions={options}
                  onFilter={def.filterable ? (next) => setColumnFilter(id, next) : undefined}
                  onPinLeft={def.pinnable !== false ? () => pinColumn(id, 'left') : undefined}
                  onPinRight={def.pinnable !== false ? () => pinColumn(id, 'right') : undefined}
                  onUnpin={def.pinnable !== false ? () => unpinColumn(id) : undefined}
                  pinned={pinnedSide}
                  onAutoSize={def.resizable !== false ? () => autoSizeColumn(id) : undefined}
                  hideable={def.hideable !== false}
                  draggable={def.draggable !== false && pinnedSide === null}
                  isDragSource={drag?.col === id}
                  onDragPointerDown={
                    def.draggable !== false && pinnedSide === null
                      ? (e) => beginDrag(id, def.label, sticky.widthOf(id), e)
                      : undefined
                  }
                  onHide={() => hideColumn(id)}
                  labels={labels.colMenu}
                  chrome={!plainHeaders}
                  onStartResize={def.resizable !== false ? (e) => startResize(id, e) : undefined}
                />
              );
            })}
          </tr>
        </thead>

        <tbody>
          {loading && rows.length === 0 ? (
            <tr>
              <td colSpan={colSpan} className="p-6 text-center text-muted-foreground">
                {labels.loading ?? 'Loading…'}
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={colSpan} className="p-6 text-center">
                {renderEmpty ? (
                  renderEmpty()
                ) : (
                  <span className="text-muted-foreground">No results.</span>
                )}
              </td>
            </tr>
          ) : isGrouped ? (
            // Grouped render: emit a GroupHeaderRow between groups.
            // When a group is collapsed, its body rows are omitted;
            // the header alone documents that the group exists. Row
            // indices remain monotonic across groups so consumers
            // that count rows for striping/parity still work.
            (() => {
              let rowIndex = -1;
              return groups.flatMap((group) => {
                const header = (
                  <GroupHeaderRow
                    key={`hdr-${group.key}`}
                    label={group.label}
                    countLabel={
                      groupCountLabel ? groupCountLabel(group.rows.length) : `${group.rows.length}`
                    }
                    collapsed={group.collapsed}
                    onToggle={() => toggleGroupCollapsed(group.key)}
                    colSpan={colSpan}
                    showSelect={selectable}
                    allSelected={group.allSelected}
                    someSelected={group.someSelected}
                    onToggleSelectGroup={() => toggleGroupSelection(group)}
                  />
                );
                if (group.collapsed) return [header];
                const body = group.rows.map((row) => {
                  rowIndex += 1;
                  return renderRow(row, rowIndex);
                });
                return [header, ...body];
              });
            })()
          ) : virtual ? (
            // Windowed: spacer rows preserve the full scroll height; only the
            // visible slice renders. Row indices stay absolute.
            <>
              {vwin.start > 0 && (
                <tr aria-hidden style={{ height: vwin.start * rowH }}>
                  <td colSpan={colSpan} className="border-0 p-0" />
                </tr>
              )}
              {orderedRows
                .slice(vwin.start, vwin.end)
                .map((row, i) => renderRow(row, vwin.start + i))}
              {vwin.end < orderedRows.length && (
                <tr aria-hidden style={{ height: (orderedRows.length - vwin.end) * rowH }}>
                  <td colSpan={colSpan} className="border-0 p-0" />
                </tr>
              )}
            </>
          ) : (
            orderedRows.map((row, rowIndex) => renderRow(row, rowIndex))
          )}
        </tbody>
      </table>

      {/* Infinite-scroll sentinel lives INSIDE Scroll2D — the
          IntersectionObserver below uses `scrollRef.current` (the
          inner scrolling div) as its `root`, and observers only
          fire on descendants of their root. */}
      {!disableInfiniteScroll && onLoadMore && (
        <InfiniteScrollSentinel
          onLoadMore={onLoadMore}
          hasNextPage={hasNextPage ?? false}
          isFetching={isFetchingNextPage ?? false}
          loadingLabel={labels.loading ?? 'Loading…'}
          endLabel={labels.endOfList ?? 'End of list'}
          rootRef={scrollRef}
          showEnd={rows.length > 0}
        />
      )}

      {drag && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[100] flex items-center gap-2 rounded-md border border-primary bg-card px-3 py-2 shadow-lg"
          style={{
            left: drag.ghostX - drag.ghostOffsetX,
            top: drag.ghostY - drag.ghostOffsetY,
            width: Math.min(drag.width, 280),
            transform: 'rotate(1.5deg)',
          }}
        >
          <IconArrowsMove size={14} className="text-primary" />
          <span className="truncate font-medium text-[11px] text-foreground uppercase tracking-wide">
            {drag.label}
          </span>
        </div>
      )}
    </Scroll2D>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Expand a `ColumnFilter` (the design-system shape returned by
 *  the column-header filter editor) into one or more
 *  `FilterClause`s (the per-value pill model used everywhere
 *  else in the chrome). */
export function columnFilterToClauses<F extends string>(
  field: F,
  f: ColumnFilter,
): FilterClause<F>[] {
  switch (f.op) {
    case 'isAnyOf':
      return f.values.map((v) => ({
        id: newClauseId(),
        field,
        op: 'equals' as const,
        value: v,
      }));
    case 'isNoneOf':
      return f.values.map((v) => ({
        id: newClauseId(),
        field,
        op: 'doesNotEqual' as const,
        value: v,
      }));
    case 'isEmpty':
    case 'isNotEmpty':
      return [{ id: newClauseId(), field, op: f.op, value: '' }];
    default:
      return [{ id: newClauseId(), field, op: f.op, value: f.value }];
  }
}

/** Collapse the per-column slice of `state.filters` back into a
 *  single `ColumnFilter` for the column-header dropdown. Returns
 *  `null` when there are no clauses (or when multi-clause OR groups
 *  exist that can't be represented in one editor — the user edits
 *  those via the toolbar pills instead). */
export function filterClauseToColumnFilter<F extends string>(
  filters: FilterClause<F>[],
  field: F,
): ColumnFilter | null {
  const own = filters.filter((c) => c.field === field);
  const first = own[0];
  if (!first) return null;
  if (own.length === 1) {
    const c = first;
    if (VALUELESS_OPS.has(c.op)) return { op: c.op } as ColumnFilter;
    return { op: c.op, value: c.value } as ColumnFilter;
  }
  const allEquals = own.every((c) => c.op === 'equals');
  const allNotEquals = own.every((c) => c.op === 'doesNotEqual');
  if (allEquals) return { op: 'isAnyOf', values: own.map((c) => c.value) };
  if (allNotEquals) return { op: 'isNoneOf', values: own.map((c) => c.value) };
  return null; // mixed ops — editor can't represent
}

/** Reorder columns so the linear order matches the pinned bands:
 *  pinnedLeft first (in pin-add order), then unpinned (preserving
 *  their relative order from the input), then pinnedRight. */
export function reorderForPinning<ColumnId extends string>(
  current: ColumnId[],
  pins: { left: ColumnId[]; right: ColumnId[] },
): ColumnId[] {
  const leftSet = new Set(pins.left);
  const rightSet = new Set(pins.right);
  const unpinned = current.filter((id) => !leftSet.has(id) && !rightSet.has(id));
  return [...pins.left, ...unpinned, ...pins.right];
}

// ─── Scroll anchoring across the breakpoint flip ──────────────────

/**
 * Both trees tag their row element with the row's key under this attribute.
 * The table puts it on the `<tr>`, the card list on the `<li>`.
 *
 * It exists because the two trees' `id`s deliberately do not match
 * (`data-row-…` vs `data-card-…`, so a page can hold both prefixes without
 * a duplicate-id collision), which is precisely what makes `id` useless as
 * the anchor's selector. One attribute, one meaning, both trees.
 */
const ROW_KEY_ATTR = 'data-dt-row-key';

/**
 * The key of the topmost row still visible in `el` — the first row whose
 * bottom edge has not scrolled above the container's top edge.
 *
 * Exported for test. jsdom has no layout engine, so every
 * `getBoundingClientRect()` in a component test returns zeroes and this
 * function is unobservable from the outside there; the only way to pin its
 * arithmetic is to call it directly against stubbed rects.
 *
 * Binary search, not a scan. Rows are laid out in document order and their
 * edges increase monotonically, so the predicate "bottom is below the fold"
 * is false-then-true exactly once across the list. A scan would read a rect
 * per row — 500 forced layout reads on a list that is being scrolled, every
 * animation frame — where this reads about nine.
 */
export function topmostRowKey(el: HTMLElement): string | null {
  const nodes = el.querySelectorAll<HTMLElement>(`[${ROW_KEY_ATTR}]`);
  if (nodes.length === 0) return null;
  const fold = el.getBoundingClientRect().top;
  let lo = 0;
  let hi = nodes.length - 1;
  let found: HTMLElement | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const node = nodes[mid];
    if (!node) break;
    if (node.getBoundingClientRect().bottom > fold) {
      found = node;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found?.getAttribute(ROW_KEY_ATTR) ?? null;
}

/** The row element for `key` inside `el`, or null if it is not rendered. */
function rowNodeFor(el: HTMLElement, key: string): HTMLElement | null {
  for (const node of el.querySelectorAll<HTMLElement>(`[${ROW_KEY_ATTR}]`)) {
    if (node.getAttribute(ROW_KEY_ATTR) === key) return node;
  }
  return null;
}

/**
 * Carry the reading position across a breakpoint flip.
 *
 * ── Why a key and never a pixel offset ──────────────────────────────
 *
 * The obvious implementation is to stash `scrollTop` and put it back. It is
 * wrong here, and not marginally: a card is roughly twice the height of a
 * table row, and how much more depends on how many of its field rows
 * survived the visibility intersection. 4 000px down a table is a different
 * row from 4 000px down the card list, so restoring the number restores a
 * position nobody was reading. The key of the topmost visible row is the
 * thing the person actually has in front of them, and it means the same in
 * both trees.
 *
 * ── How exact the restoration is ────────────────────────────────────
 *
 * Exact when the anchor row is in the DOM of the tree that just mounted:
 * the row is scrolled to the container's top edge, which is where it was.
 * Sub-row precision is NOT preserved — a row that was half-scrolled off the
 * top comes back fully visible. That is deliberate rather than tolerated:
 * to the person, "the row I was looking at is at the top" is the property,
 * and reproducing a partial cut on an element of a different height would
 * be arithmetic pretending to be fidelity.
 *
 * Approximate in exactly one case: flipping cards→table with row
 * virtualization on, where the anchor row is outside the mounted window and
 * so has no element to measure. There we fall back to `index * rowHeight`,
 * which is the same uniform-height assumption `useRowWindow` and the spacer
 * rows already run on, so it lands on the right row; the window then
 * re-measures on the resulting scroll event. Card mode never virtualizes
 * (`virtual` is forced false while compact), so the table→cards leg always
 * finds its element.
 *
 * Does nothing at all until the person has scrolled: the anchor is captured
 * from scroll events, so an unscrolled list flips with a null anchor and
 * the new tree is left where it mounted, at the top. Which is correct — the
 * top is where they were.
 */
function useScrollAnchor(params: {
  compact: boolean;
  /** The table tree's scroll container. Attached only while not compact. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The card tree's scroll container. Attached only while compact. */
  cardScrollRef: React.RefObject<HTMLDivElement | null>;
  rowHeight: number;
  virtualized: boolean;
  /** Position of a row key in the rendered order. Called only on the
   *  virtualized fallback path, and only at flip time. */
  indexOfRowKey: (key: string) => number;
}): void {
  const { compact, scrollRef, cardScrollRef, rowHeight, virtualized, indexOfRowKey } = params;

  const anchorKey = useRef<string | null>(null);
  const lastCompact = useRef(compact);
  /**
   * The fallback's inputs, read at flip time only.
   *
   * They live in a ref rather than in the effect's dependency array because
   * naming them there would tear down and rebuild the scroll listener every
   * time a row arrived from pagination or the density changed — a
   * subscription churning on data changes it does not read.
   */
  const fallback = useRef({ rowHeight, virtualized, indexOfRowKey });
  fallback.current = { rowHeight, virtualized, indexOfRowKey };

  // Capture. One listener on whichever container is currently mounted,
  // rAF-throttled the same way `useRowWindow` throttles its own measure —
  // a scroll fires far faster than a frame, and this reads layout.
  useEffect(() => {
    const el = compact ? cardScrollRef.current : scrollRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      anchorKey.current = topmostRowKey(el);
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    // Deliberately no measure on attach. The effect re-runs as part of the
    // flip commit, before the restore below has moved the new container, so
    // measuring here would overwrite the anchor with "row 0" a moment
    // before we tried to use it.
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [compact, scrollRef, cardScrollRef]);

  // Restore, on the flip only. Refs are attached during commit and effects
  // run after it, so the container this reads is the newly mounted one.
  useEffect(() => {
    if (lastCompact.current === compact) return;
    lastCompact.current = compact;
    const key = anchorKey.current;
    if (key === null) return;
    const el = compact ? cardScrollRef.current : scrollRef.current;
    if (!el) return;

    const node = rowNodeFor(el, key);
    if (node) {
      // Relative, not absolute: `scrollTop + (row top − container top)` is
      // correct whatever the container's own offset in the page happens to
      // be, and it does not care how tall anything above the row is.
      el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top;
      return;
    }

    const { rowHeight: h, virtualized: v, indexOfRowKey: indexOf } = fallback.current;
    if (!v) return;
    const index = indexOf(key);
    if (index >= 0) el.scrollTop = index * h;
  }, [compact, scrollRef, cardScrollRef]);
}

// ─── Row windowing (virtualization) ───────────────────────────────

/** Track the visible row range within the scroll container. Returns the full
 *  range when disabled. Re-measures on scroll (rAF-throttled) and resize. */
function useRowWindow(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  total: number,
  rowHeight: number,
  enabled: boolean,
  overscan = 10,
): { start: number; end: number } {
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: total });

  useEffect(() => {
    if (!enabled) {
      setRange({ start: 0, end: total });
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      const scrollTop = el.scrollTop;
      const h = el.clientHeight || 600;
      const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
      const end = Math.min(total, Math.ceil((scrollTop + h) / rowHeight) + overscan);
      setRange({ start, end });
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [scrollRef, total, rowHeight, enabled, overscan]);

  return enabled ? range : { start: 0, end: total };
}

// ─── Infinite-scroll sentinel ─────────────────────────────────────

function InfiniteScrollSentinel(props: {
  rootRef: React.RefObject<HTMLDivElement | null>;
  onLoadMore: () => void;
  hasNextPage: boolean;
  isFetching: boolean;
  loadingLabel: string;
  endLabel: string;
  showEnd: boolean;
}) {
  const { rootRef, onLoadMore, hasNextPage, isFetching, loadingLabel, endLabel, showEnd } = props;
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Re-establish the observer whenever `hasNextPage` flips (e.g.
  // after the first page loads and the query learns there are
  // more results) or when the load-more callback identity changes.
  // The previous use-once version captured stale values on mount
  // before the first page had even loaded, so the observer was
  // never set up.
  useEffect(() => {
    if (!hasNextPage) return;
    const node = sentinelRef.current;
    if (!node) return;
    /**
     * Read the root at EFFECT time, and say something if it is missing.
     *
     * A null `root` is not an error to the browser — the observer silently
     * falls back to the viewport and keeps running. That fallback is what
     * makes an unattached ref dangerous rather than merely broken: rooted
     * at a viewport the sentinel is not laid out against, it either
     * intersects on the first frame and pulls every page at once, or never
     * intersects and pagination stops without a symptom. Nothing in the UI
     * says "there were four more pages".
     *
     * Both trees pass a ref they attach themselves (`scrollRef` →
     * `<Scroll2D>`, `cardScrollRef` → the card list's scroller), and refs
     * are attached during commit, before effects run, so `current` should
     * always be there by now. If a third caller ever forgets, this is the
     * line that tells them instead of leaving them a list that ends early.
     */
    const root = rootRef.current;
    if (process.env.NODE_ENV !== 'production' && root === null) {
      console.warn(
        '[DataTable] Infinite-scroll sentinel: rootRef is not attached, so the ' +
          'IntersectionObserver has fallen back to the viewport. Pagination will either ' +
          'fire on mount or never fire. Attach the ref to the element that scrolls.',
      );
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetching) onLoadMore();
      },
      { root, rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // `isFetching` is intentionally read fresh on each intersection
    // event via the closure; we don't want to tear down + rebuild
    // the observer mid-fetch (would miss the post-fetch intersection
    // that triggers the NEXT page). Same reason `onLoadMore` is
    // referenced live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasNextPage, rootRef, onLoadMore, isFetching]);

  return (
    <div ref={sentinelRef} className="py-2 text-center text-muted-foreground text-sm">
      {isFetching ? loadingLabel : !hasNextPage && showEnd ? endLabel : null}
    </div>
  );
}
