'use client';

import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/**
 * Pointer-based column drag with live-slide FLIP animation.
 *
 * Press on a header label → `startDrag(colId, event)` opens a
 * drag session: a portaled ghost element follows the cursor, and
 * as the cursor crosses the natural midpoint of a different
 * (un-pinned) column, the parent's `onSwap(source, target)`
 * callback fires. The parent updates its column order; the
 * `pendingFlipOldX` ref persists the pre-commit positions across
 * the commit boundary so a useLayoutEffect can compute deltas and
 * fire WAAPI animations on the same tick, before the browser
 * paints.
 *
 * The hook returns the drag state (for ghost rendering) + a
 * `beginDrag` handler (to be invoked from a column header's
 * `onDragPointerDown`). The parent passes in its scroll
 * container ref + a function to test whether a column id is
 * swappable (i.e. not currently pinned).
 */

export interface ColumnDragState {
  col: string;
  width: number;
  label: string;
  ghostX: number;
  ghostY: number;
  ghostOffsetX: number;
  ghostOffsetY: number;
}

interface UseColumnDragArgs {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Returns true if `colId` is a valid swap target (i.e. not pinned).
   *  Pinned columns are skipped during drop detection so the source
   *  column doesn't get shoved into a pinned slot. */
  isSwappable: (colId: string) => boolean;
  /** Called when the cursor crosses a swap boundary. Parent
   *  updates `columnOrder` and arranges for the FLIP via the
   *  `pendingFlipOldX` ref returned from this hook. */
  onSwap: (source: string, target: string) => void;
}

const FLIP_DURATION_MS = 320;
const FLIP_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
const FLIP_ANIM_ID = 'flip-column';

export function useColumnDrag(args: UseColumnDragArgs) {
  const { scrollRef, isSwappable, onSwap } = args;
  const [drag, setDrag] = useState<ColumnDragState | null>(null);

  /** Snapshot of each header's left edge BEFORE a column-order
   *  state change. Set by `onSwap` (via a wrapper exposed below)
   *  and consumed by the useLayoutEffect that watches the parent's
   *  columnOrder. Cleared after the FLIP runs. */
  const pendingFlipOldX = useRef<Map<string, number> | null>(null);

  /** Capture each header's viewport-left position. Reads in-flight
   *  transforms (getBoundingClientRect returns visual position
   *  including transforms), so chained animations preserve
   *  continuity. */
  const captureHeaderPositions = (): Map<string, number> => {
    const map = new Map<string, number>();
    const tableEl = scrollRef.current?.querySelector('table');
    if (!tableEl) return map;
    for (const th of tableEl.querySelectorAll<HTMLTableCellElement>('th[data-col]')) {
      const key = th.dataset.col;
      if (key) map.set(key, th.getBoundingClientRect().left);
    }
    return map;
  };

  /** Wrap the parent's swap with the position snapshot. The
   *  parent's onSwap should do `setColumnOrder(...)`; this fn
   *  captures positions just before so the FLIP works. */
  const swap = (source: string, target: string) => {
    if (source === target) return;
    pendingFlipOldX.current = captureHeaderPositions();
    onSwap(source, target);
  };

  // Window-level pointer listeners while a drag is active.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect is keyed on the active drag (drag?.col); swap/isSwappable are caller-provided and stable for the drag's lifetime
  useEffect(() => {
    if (!drag) return;
    const tableEl = scrollRef.current?.querySelector('table');
    if (!tableEl) return;

    const onMove = (e: PointerEvent) => {
      // Track cursor so the ghost follows smoothly.
      setDrag((d) => (d ? { ...d, ghostX: e.clientX, ghostY: e.clientY } : null));

      // Layout-based hit testing (offsetLeft / offsetWidth ignore
      // active transforms, so the boundary is stable during the
      // slide animation — without this the column appears to
      // "shake" as it animates past the cursor).
      const tableLeft = tableEl.getBoundingClientRect().left;
      let overCol: string | null = null;
      for (const th of tableEl.querySelectorAll<HTMLTableCellElement>('thead tr > th[data-col]')) {
        const key = th.dataset.col;
        if (!key) continue;
        if (!isSwappable(key)) continue;
        const naturalLeft = tableLeft + th.offsetLeft;
        const naturalRight = naturalLeft + th.offsetWidth;
        if (e.clientX >= naturalLeft && e.clientX <= naturalRight) {
          overCol = key;
          break;
        }
      }
      if (overCol && overCol !== drag.col) {
        swap(drag.col, overCol);
      }
    };
    const onUp = () => {
      setDrag(null);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // `drag.col` is the only piece the closure needs; ghost
    // positions are read fresh from event.clientX/Y each fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate, as the line above says
  }, [drag?.col]);

  return {
    drag,
    pendingFlipOldX,
    /** Begin a drag — call from a header's `onDragPointerDown`. */
    beginDrag: (col: string, label: string, width: number, e: ReactPointerEvent<HTMLElement>) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setDrag({
        col,
        width,
        label,
        ghostX: e.clientX,
        ghostY: e.clientY,
        ghostOffsetX: e.clientX - rect.left,
        ghostOffsetY: e.clientY - rect.top,
      });
    },
  };
}

/**
 * useLayoutEffect-driven FLIP runner. Watches `columnOrder` (any
 * change → animate). Reads `pendingFlipOldX` (set by the drag
 * hook OR by any other code that wants to animate a column
 * reorder, e.g. pin/unpin). If the ref is null, no animation runs
 * — that's intentional, so initial mount and unrelated re-renders
 * don't trigger spurious slides.
 */
export function useColumnFlip(opts: {
  scrollRef: RefObject<HTMLDivElement | null>;
  columnOrder: readonly string[];
  pendingFlipOldX: RefObject<Map<string, number> | null>;
}) {
  const { scrollRef, columnOrder, pendingFlipOldX } = opts;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect *reads* refs but is *triggered* by columnOrder — that's the whole point of the FLIP pattern (capture before swap → re-render with new order → measure new positions → animate from old to new).
  useLayoutEffect(() => {
    const oldX = pendingFlipOldX.current;
    if (!oldX) return;
    pendingFlipOldX.current = null;

    const tableEl = scrollRef.current?.querySelector('table');
    if (!tableEl) return;
    const headerRow = tableEl.querySelector<HTMLTableRowElement>('thead tr');
    if (!headerRow) return;

    const headers = Array.from(headerRow.children) as HTMLTableCellElement[];
    const bodyRows = Array.from(tableEl.querySelectorAll<HTMLTableRowElement>('tbody tr'));

    // Cancel any in-flight FLIP animations (id-tagged) so the next
    // measurement reads clean layout. Don't touch unrelated
    // animations (opacity transitions for the drag-source dim, etc).
    const cancelFlipAnims = (el: Element) => {
      for (const a of (el as HTMLElement).getAnimations()) {
        if (a.id === FLIP_ANIM_ID) a.cancel();
      }
    };
    for (const th of headers) cancelFlipAnims(th);
    for (const row of bodyRows) {
      for (const cell of row.children) cancelFlipAnims(cell);
    }

    // table-layout: fixed + colgroup → every cell at column index i
    // shares the same x delta. Measure headers, apply deltas by
    // index to body cells.
    const deltas: (number | null)[] = headers.map((th) => {
      const key = th.dataset.col;
      if (!key) return null;
      const old = oldX.get(key);
      if (old === undefined) return null;
      const newX = th.getBoundingClientRect().left;
      const dx = old - newX;
      return Math.abs(dx) < 0.5 ? null : dx;
    });

    if (deltas.every((d) => d === null)) return;

    const animOpts: KeyframeAnimationOptions = {
      duration: FLIP_DURATION_MS,
      easing: FLIP_EASING,
      fill: 'none',
      id: FLIP_ANIM_ID,
    };
    const animate = (el: HTMLElement, dx: number) => {
      el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], animOpts);
    };

    for (let i = 0; i < headers.length; i++) {
      const dx = deltas[i];
      const header = headers[i];
      if (dx == null || !header) continue;
      animate(header, dx);
    }
    for (const row of bodyRows) {
      const cells = row.children;
      for (let i = 0; i < cells.length; i++) {
        const dx = deltas[i];
        if (dx == null) continue;
        animate(cells[i] as HTMLTableCellElement, dx);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per reorder, by design
  }, [columnOrder]);
}
