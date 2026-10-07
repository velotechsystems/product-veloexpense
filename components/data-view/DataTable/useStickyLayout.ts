'use client';

import { useMemo } from 'react';
import type { ColumnDef, DataTableState } from './types';

/**
 * Smallest width at which a header label still reads, in pixels.
 *
 * WHY THIS EXISTS. Every `defaultWidth` in the product was chosen against the ENGLISH
 * label, and French runs roughly 20% longer for the same column. `ColumnHeader` wraps its
 * label with `whitespace-normal break-words`, so a column too narrow for its own heading
 * does not overflow — it breaks the word in half. "Gravité" rendered as "Gravi / té", and
 * "Sévérité" and "Catégorie" did the same, on columns that look fine in English (GA
 * readiness report F43).
 *
 * The measure is the LONGEST WORD, not the whole label. Wrapping a two-word heading across
 * two lines is correct and intended; breaking one word across two lines never is. So the
 * floor only has to guarantee that the widest single word fits on a line by itself, which
 * is exactly the condition `overflow-wrap: break-word` breaks a word to satisfy.
 */
const HEADER_CHAR_PX = 6.4; // 11px semibold, uppercase, tracking-wide
/** Sort arrow + column menu button + the th's own horizontal padding. */
const HEADER_CHROME_PX = 52;
/**
 * A long word must not be allowed to demand an unusable column. Past this, accept the
 * break — a 40-character heading is a copy problem, not a layout one.
 */
const LABEL_WIDTH_CAP = 260;

export function minWidthForLabel(label: string): number {
  let longest = 0;
  for (const word of label.split(/\s+/)) longest = Math.max(longest, word.length);
  return Math.min(Math.ceil(longest * HEADER_CHAR_PX) + HEADER_CHROME_PX, LABEL_WIDTH_CAP);
}

/**
 * Compute cumulative sticky offsets for pinned columns + the
 * scrollbar insets for the bounded Scroll2D wrapper.
 *
 * The left-edge cascade walks pinned-left columns in order, summing
 * widths to produce each column's `left: Npx`. Same on the right
 * edge in reverse for pinned-right columns. The horizontal
 * scrollbar starts where the pinned-left band ends and ends where
 * the pinned-right band begins.
 *
 * Memoized on `(columnWidths, pinnedColumns)` so React doesn't
 * recompute on unrelated re-renders.
 */
export function useStickyLayout<Row, ColumnId extends string>(opts: {
  columns: ColumnDef<Row, ColumnId>[];
  state: DataTableState<ColumnId>;
  /** Width of the leading select column (0 when not rendered). */
  selectColumnWidth: number;
}) {
  const { columns, state, selectColumnWidth } = opts;
  const { columnWidths, pinnedColumns } = state;

  return useMemo(() => {
    // Width lookup: state.columnWidths first, then ColumnDef.defaultWidth.
    const widthOf = (id: ColumnId): number => {
      // An explicit width is a width somebody CHOSE — by dragging the resize handle, or by
      // auto-sizing. Widening it back would fight them, so the label floor below applies
      // only to the declared default.
      const explicit = columnWidths[id];
      if (explicit != null) return explicit;
      const def = columns.find((c) => c.id === id);
      const declared = def?.defaultWidth ?? 180;
      return def ? Math.max(declared, minWidthForLabel(def.label)) : declared;
    };

    // ─── Left band ──────────────────────────────────────────────
    let leftCursor = selectColumnWidth;
    const leftOffsets = new Map<ColumnId, number>();
    for (const id of pinnedColumns.left) {
      leftOffsets.set(id, leftCursor);
      leftCursor += widthOf(id);
    }
    const insetLeft = leftCursor;

    // ─── Right band (cumulative from the right edge) ────────────
    let rightCursor = 0;
    const rightOffsets = new Map<ColumnId, number>();
    // Iterate right-pinned right→left so the rightmost has offset 0,
    // the one next to it has offset = its right neighbour's width,
    // etc.
    for (let i = pinnedColumns.right.length - 1; i >= 0; i--) {
      const id = pinnedColumns.right[i];
      if (id == null) continue;
      rightOffsets.set(id, rightCursor);
      rightCursor += widthOf(id);
    }
    const insetRight = rightCursor;

    return {
      leftOffsets,
      rightOffsets,
      insetLeft,
      insetRight,
      widthOf,
    };
  }, [columns, columnWidths, pinnedColumns, selectColumnWidth]);
}
