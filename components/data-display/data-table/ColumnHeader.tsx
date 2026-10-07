'use client';

import {
  IconArrowAutofitWidth,
  IconArrowDown,
  IconArrowUp,
  IconDotsVertical,
  IconEyeOff,
  IconFilter,
  IconFilterFilled,
  IconPinned,
} from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FilterEditor } from './FilterEditor';
import { cls } from './helpers';
import { MenuDivider, MenuItem } from './Menu';
import type { ColumnFilter, DataTableLabels, FilterColumnType, SortDir, SortState } from './types';

/**
 * Header cell for a data-table column.
 *
 * Features:
 *  - hover-revealed overlay with sort arrow + kebab (column actions
 *    menu: Sort ↑/↓, Filter, Hide)
 *  - active-filter chip rendered inline next to the kebab when set
 *  - draggable for column reorder (deterministic drop indicator on the
 *    right-edge separator)
 *  - resizable via the right-edge handle
 *  - sticky variant for the pinned first column
 *
 * Stateless — all behavioural state (sort, dropAfterCol, etc.) is
 * controlled by the parent so the table can orchestrate cross-column
 * effects (e.g. only one separator highlighted at a time).
 */
export function ColumnHeader<C extends string, F extends string>({
  col,
  label,
  stickyLeft,
  stickyRight,
  className,
  sortField,
  sortState,
  onSort,
  filterable,
  filterType,
  activeFilter,
  filterOptions = [],
  onFilter,
  hideable,
  draggable: isDraggable,
  chrome = true,
  onHide,
  labels,
  onStartResize,
  isDragSource,
  onDragPointerDown,
  onPinLeft,
  onPinRight,
  onUnpin,
  pinned,
  onAutoSize,
}: {
  col: C;
  label: string;
  /** Pin to the LEFT with this pixel offset (cumulative from the
   *  table's left edge). When set, the column header becomes
   *  `position: sticky; left: <stickyLeft>px`. Omit to keep the
   *  column non-sticky. Mutually exclusive with `stickyRight`. */
  stickyLeft?: number;
  /** Pin to the RIGHT with this pixel offset (cumulative from the
   *  table's right edge). Mutually exclusive with `stickyLeft`. */
  stickyRight?: number;
  className?: string;
  sortField: F | null;
  sortState: SortState<F>;
  onSort: (f: F, d: SortDir) => void;
  filterable: boolean;
  filterType: FilterColumnType;
  activeFilter: ColumnFilter | null;
  filterOptions?: Array<{ value: string; label: string }>;
  onFilter?: (next: ColumnFilter | null) => void;
  hideable: boolean;
  draggable: boolean;
  /** When the column is the live drag SOURCE — visually dimmed so the
   *  cursor's ghost element reads as the "real" version. The position
   *  in the order is already updated live as the user drags. */
  isDragSource?: boolean;
  /** Pointer-based drag handler. When provided, mousedown on the
   *  header label starts a pointer-tracking drag (live column swap
   *  controlled by the parent). When omitted, the column is not
   *  draggable. */
  onDragPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  onHide: () => void;
  labels: DataTableLabels['colMenu'];
  onStartResize?: (e: React.MouseEvent<HTMLSpanElement>) => void;
  /** Off for a small, fixed table: no sort/filter/menu cluster and no resize
   *  handle, so the header is just its label. Those affordances reserve 3rem of
   *  right padding in every header, which on a five-column pane costs more than
   *  they're worth. */
  chrome?: boolean;
  /** Pin this column to the left edge (sticky). When provided, the
   *  menu shows "Pin to left" (or "Unpin" if already pinned-left). */
  onPinLeft?: () => void;
  /** Pin this column to the right edge (sticky). */
  onPinRight?: () => void;
  /** Remove any pinning on this column. */
  onUnpin?: () => void;
  /** Current pin state — drives which menu items are highlighted/
   *  swapped between "Pin" and "Unpin". */
  pinned?: 'left' | 'right' | null;
  /** Auto-size column to its widest cell. When provided, the menu
   *  shows an "Auto-size column" entry. */
  onAutoSize?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [filterMode, setFilterMode] = useState(false);
  const sortActive = sortField !== null && sortState.field === sortField;
  const hasActiveFilter = activeFilter !== null;

  // Click-vs-drag arbitration: the label is both a sort trigger AND
  // the drag handle. We track pointer-down position; if pointerup
  // fires without moving much (<4 px), it's a click — apply sort. If
  // pointerup happens after motion or the parent installed a global
  // pointermove (drag in progress), the click handler is suppressed.
  const downRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const handleLabelPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    downRef.current = { x: e.clientX, y: e.clientY, moved: false };
    if (isDraggable) onDragPointerDown?.(e);
  };
  const handleLabelPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = downRef.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4) {
      d.moved = true;
    }
  };
  const handleLabelClick = () => {
    const moved = downRef.current?.moved ?? false;
    downRef.current = null;
    if (moved) return; // suppress sort click after a drag
    if (sortField) onSort(sortField, sortActive ? flipDir(sortState.dir) : 'asc');
  };

  const isHorizontallySticky = stickyLeft !== undefined || stickyRight !== undefined;
  return (
    <th
      data-col={col}
      style={{
        ...(stickyLeft !== undefined ? { left: stickyLeft } : {}),
        ...(stickyRight !== undefined ? { right: stickyRight } : {}),
      }}
      className={cls(
        'group relative sticky top-0 z-20 bg-card px-4 py-2.5 text-left align-top font-medium text-[11px] text-muted-foreground uppercase tracking-wide shadow-[inset_0_-1px_0_var(--color-border)] transition-opacity',
        // Horizontally-sticky headers stack ABOVE non-sticky middle
        // headers (which are only top-sticky) during horizontal
        // scroll. z-30 wins the cross-section.
        isHorizontallySticky && 'z-30',
        isDragSource && 'opacity-40',
        className,
      )}
    >
      <div className={cls('flex items-center', chrome && 'pr-12')}>
        <button
          type="button"
          onPointerDown={handleLabelPointerDown}
          onPointerMove={handleLabelPointerMove}
          onClick={handleLabelClick}
          className={cls(
            // Wrap to multiple lines when the header label is wider than
            // the column. `break-words` lets long single tokens (slugs,
            // codes, URLs) break mid-word instead of forcing horizontal
            // overflow.
            'block w-full select-none whitespace-normal break-words text-left',
            isDraggable && 'cursor-grab active:cursor-grabbing',
          )}
          aria-disabled={!sortField}
        >
          {label}
        </button>
      </div>

      {chrome && (
        <div className="pointer-events-none absolute top-0 right-3 z-30 flex h-[40px] items-center">
          <div
            className={cls(
              'pointer-events-auto flex items-center gap-1 rounded bg-muted/40 px-1 backdrop-blur-sm transition-opacity',
              sortActive || hasActiveFilter || menuOpen
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100',
            )}
          >
            {sortField && (
              <button
                type="button"
                onClick={() => onSort(sortField, sortActive ? flipDir(sortState.dir) : 'asc')}
                className="rounded p-0.5 hover:bg-background"
                aria-label={labels.menu}
              >
                {sortActive && sortState.dir === 'desc' ? (
                  <IconArrowDown size={14} />
                ) : (
                  <IconArrowUp size={14} className={sortActive ? '' : 'opacity-60'} />
                )}
              </button>
            )}
            {(filterable || hideable) && (
              <Popover
                open={menuOpen}
                onOpenChange={(v) => {
                  setMenuOpen(v);
                  if (!v) setFilterMode(false);
                }}
              >
                <PopoverTrigger
                  className="rounded p-0.5 hover:bg-background"
                  aria-label={labels.menu}
                >
                  {hasActiveFilter ? (
                    <IconFilterFilled size={14} className="text-primary" />
                  ) : (
                    <IconDotsVertical size={14} />
                  )}
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={4} className="z-50 w-72 p-1">
                  {filterMode && filterable && onFilter ? (
                    <FilterEditor
                      columnType={filterType}
                      options={filterOptions}
                      current={activeFilter}
                      onApply={(next) => {
                        onFilter(next);
                        setMenuOpen(false);
                        setFilterMode(false);
                      }}
                      onCancel={() => setFilterMode(false)}
                      labels={labels}
                    />
                  ) : (
                    <div className="space-y-0.5">
                      {/* Pin / Unpin — SentinelOne pattern.
                        Highlight the active side, swap to "Unpin" if
                        the column is already pinned to that side. */}
                      {(onPinLeft || onPinRight || onUnpin) && (
                        <>
                          {onPinLeft && (
                            <MenuItem
                              icon={<IconPinned size={14} />}
                              onClick={() => {
                                if (pinned === 'left') onUnpin?.();
                                else onPinLeft();
                                setMenuOpen(false);
                              }}
                            >
                              {pinned === 'left' ? 'Unpin' : 'Pin to left'}
                            </MenuItem>
                          )}
                          {onPinRight && (
                            <MenuItem
                              icon={<IconPinned size={14} className="-scale-x-100" />}
                              onClick={() => {
                                if (pinned === 'right') onUnpin?.();
                                else onPinRight();
                                setMenuOpen(false);
                              }}
                            >
                              {pinned === 'right' ? 'Unpin' : 'Pin to right'}
                            </MenuItem>
                          )}
                          <MenuDivider />
                        </>
                      )}
                      {sortField && (
                        <>
                          <MenuItem
                            icon={<IconArrowUp size={14} />}
                            onClick={() => {
                              onSort(sortField, 'asc');
                              setMenuOpen(false);
                            }}
                          >
                            {labels.sortAsc}
                          </MenuItem>
                          <MenuItem
                            icon={<IconArrowDown size={14} />}
                            onClick={() => {
                              onSort(sortField, 'desc');
                              setMenuOpen(false);
                            }}
                          >
                            {labels.sortDesc}
                          </MenuItem>
                          {(filterable || hideable || onAutoSize) && <MenuDivider />}
                        </>
                      )}
                      {filterable && (
                        <MenuItem
                          icon={<IconFilter size={14} />}
                          onClick={() => setFilterMode(true)}
                        >
                          {labels.filter}
                        </MenuItem>
                      )}
                      {onAutoSize && (
                        <MenuItem
                          icon={<IconArrowAutofitWidth size={14} />}
                          onClick={() => {
                            onAutoSize();
                            setMenuOpen(false);
                          }}
                        >
                          Auto-size column
                        </MenuItem>
                      )}
                      {hideable && (
                        <MenuItem
                          icon={<IconEyeOff size={14} />}
                          onClick={() => {
                            onHide();
                            setMenuOpen(false);
                          }}
                        >
                          {labels.hide}
                        </MenuItem>
                      )}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      )}

      {/* Right-edge separator — a thin static line that doubles as
          the resize handle. The drop-target highlight is gone now:
          live column-slide IS the indicator, so there's no need for
          a separator state.
          For columns pinned to the right, the separator line is
          omitted. There's no neighbouring column to the right of the
          rightmost pinned column to delineate from, AND the line
          sits 1px from the cell's right edge — at max horizontal
          scroll, sub-pixel rounding on `position: sticky` can flicker
          that pixel into view as a stray sliver. The resize handle
          itself (this <span>) stays in place and remains
          interactive — only the visible colored stripe is dropped. */}
      {chrome && onStartResize && (
        // Pointer-only column-resize handle. The wrapping <th> already
        // carries the column role; this span is intentionally aria-hidden
        // because keyboard users adjust column widths via the column-
        // actions kebab menu (which carries an aria-label).
        <span
          aria-hidden
          title={labels.resize}
          onMouseDown={onStartResize}
          className={cls(
            'absolute top-2 right-0 bottom-2 z-40 -mr-1 w-2 cursor-col-resize select-none',
            'before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:transition-colors',
            stickyRight === undefined && 'before:bg-foreground/15 hover:before:bg-primary/60',
          )}
        />
      )}
    </th>
  );
}

function flipDir(d: SortDir): SortDir {
  return d === 'asc' ? 'desc' : 'asc';
}
