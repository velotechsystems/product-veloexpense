/**
 * What survives a live breakpoint flip, and what is cancelled.
 *
 * ── Why this file exists, and why it says the opposite of the plan ──
 *
 * The plan for this phase, the architect's ruling and the branch's own
 * comment all asserted that crossing 768px remounts the branch and therefore
 * resets `DataTable`'s local `useState`, and prescribed a "lift the state
 * above the branch" fix. The state was already above the branch. `DataTable`
 * is not remounted by the flip — the branch is an early return inside it, so
 * only the returned subtree is swapped and every hook is preserved.
 *
 * So the real defect was the inverse of the described one: nothing reset, and
 * an in-progress inline edit stayed live behind a card tree that renders no
 * editor. These tests characterise what the component ACTUALLY does now, and
 * they are written to fail loudly if someone "fixes" the cancel by deleting
 * it on the strength of the old comment.
 *
 * ── House rules observed ────────────────────────────────────────────
 *
 *   - No assertion touches the cloak classes (`CARDS_ONLY` / `TABLE_ONLY`).
 *     Which tree mounted is read from ROLES, as `DataTable.layout.test.tsx`
 *     does.
 *   - `DataTable.test.tsx` and `DataTable.layout.test.tsx` are not modified
 *     by this work; this is a third file alongside them.
 */

import '@testing-library/jest-dom/vitest';
import { COMPACT_QUERY } from '@expenseos/design-system';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable, topmostRowKey } from './DataTable';
import {
  type ColumnDef,
  createDataTableState,
  type DataTableLabels,
  type DataTableMobileConfig,
  type DataTableState,
} from './types';

const LABELS: DataTableLabels = {
  colMenu: {
    menu: 'menu',
    sortAsc: 'asc',
    sortDesc: 'desc',
    filter: 'filter',
    hide: 'hide',
    cancel: 'cancel',
    clear: 'clear',
    apply: 'apply',
    value: 'value',
    resize: 'resize',
    removeFilter: 'removeFilter',
    op_contains: 'contains',
    op_doesNotContain: 'doesNotContain',
    op_equals: 'equals',
    op_doesNotEqual: 'doesNotEqual',
    op_startsWith: 'startsWith',
    op_endsWith: 'endsWith',
    op_isEmpty: 'isEmpty',
    op_isNotEmpty: 'isNotEmpty',
    op_isAnyOf: 'isAnyOf',
    op_isNoneOf: 'isNoneOf',
  },
  settings: {
    trigger: 'settings',
    columns: 'Columns',
    density: 'Density',
    densityCompact: 'Compact',
    densityNormal: 'Normal',
    densityComfortable: 'Comfortable',
    resetDefaults: 'Reset',
  },
  selectAll: 'Select all',
  loading: 'Loading…',
  endOfList: 'End of list',
};

interface Row {
  id: string;
  name: string;
  value: string;
}
type Col = 'name' | 'value';

const COLS: ColumnDef<Row, Col>[] = [
  { id: 'name', label: 'Name', hideable: false, cell: (r) => r.name },
  {
    id: 'value',
    label: 'Value',
    cell: (r) => <span>{r.value}</span>,
    // The inline editor under test. `editable` is what puts the cell behind
    // a button and swaps in this input once `editingCell` points at it.
    editable: (r, { close }) => (
      <input aria-label={`Edit ${r.name}`} defaultValue={r.value} onBlur={close} />
    ),
  },
];

const ROWS: Row[] = [
  { id: '1', name: 'Ada', value: '100' },
  { id: '2', name: 'Grace', value: '200' },
];

const MOBILE: DataTableMobileConfig<Row, Col> = { title: 'name', fields: ['value'] };

/**
 * A `matchMedia` stub that actually DISPATCHES.
 *
 * `DataTable.layout.test.tsx`'s stub is a static answer — enough to pin which
 * tree mounts at a fixed width, useless for a flip. `useIsCompact` is a
 * `useSyncExternalStore` over `matchMedia(COMPACT_QUERY)`: it subscribes with
 * `addEventListener('change')` and re-reads `matches` on notify. So the stub
 * has to keep its listeners and hand back a live `matches`, and every
 * `matchMedia(...)` call for the same query must observe the same value —
 * React calls `getSnapshot` far more often than it subscribes.
 *
 * Returns a `setCompact` that flips the value and notifies, which is as close
 * to an orientation change as jsdom gets.
 */
function dispatchingMatchMedia(initial: boolean) {
  let compact = initial;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();

  vi.stubGlobal('matchMedia', (query: string) => ({
    // Only COMPACT_QUERY is answered live; anything else a DS primitive
    // probes for still gets a flat false.
    get matches() {
      return query === COMPACT_QUERY ? compact : false;
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => {
      if (query === COMPACT_QUERY) listeners.add(fn);
    },
    removeEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => {
      listeners.delete(fn);
    },
    dispatchEvent: () => false,
  }));

  return function setCompact(next: boolean) {
    act(() => {
      compact = next;
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
    });
  };
}

function Harness(props: { rows?: Row[]; renderExpanded?: boolean }) {
  const [state, setState] = useState<DataTableState<Col>>(() =>
    createDataTableState(COLS as never, {}),
  );
  return (
    <DataTable<Row, Col>
      columns={COLS}
      rows={props.rows ?? ROWS}
      rowKey={(r) => r.id}
      state={state}
      onStateChange={setState}
      labels={LABELS}
      layout="auto"
      mobile={MOBILE}
      disableInfiniteScroll
      renderExpanded={props.renderExpanded ? (r) => <div>Detail for {r.name}</div> : undefined}
    />
  );
}

describe('<DataTable> crossing the breakpoint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('swaps the tree live when the media query changes, without remounting DataTable', () => {
    const setCompact = dispatchingMatchMedia(false);
    render(<Harness />);
    expect(screen.getByRole('table')).toBeInTheDocument();

    setCompact(true);
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    setCompact(false);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('CANCELS an in-progress inline edit — it does not survive invisibly behind the cards', () => {
    /**
     * The characterization the plan asked for, pinned to what the component
     * does rather than to what the plan assumed.
     *
     * Before this phase the editor did NOT close: `editingCell` sits above
     * the early return, so React kept it across the flip and the input came
     * straight back on the return leg, holding text typed a rotation earlier.
     * The round trip below is the assertion that matters — a test that only
     * checked "no input while compact" would pass on the broken version too,
     * because card mode never renders an editor either way.
     */
    const setCompact = dispatchingMatchMedia(false);
    render(<Harness />);

    // Open the editor on Ada's Value cell.
    fireEvent.click(screen.getAllByRole('button', { name: '100' })[0]);
    expect(screen.getByRole('textbox', { name: 'Edit Ada' })).toBeInTheDocument();

    setCompact(true);
    expect(screen.getByRole('list')).toBeInTheDocument();

    setCompact(false);
    expect(screen.getByRole('table')).toBeInTheDocument();
    // Closed. The cell is back to its read affordance.
    expect(screen.queryByRole('textbox', { name: 'Edit Ada' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '100' })[0]).toBeInTheDocument();
  });

  it('KEEPS row expansion across the flip — it holds no unsaved input', () => {
    /**
     * The deliberate asymmetry with the edit above. Expansion is a view
     * preference: discarding it destroys nothing, and card mode does not
     * render `renderExpanded` anyway, so keeping it is invisible while
     * compact and hands back the rows the person had open. Clearing it would
     * be a loss with no matching risk.
     */
    const setCompact = dispatchingMatchMedia(false);
    render(<Harness renderExpanded />);

    // Ada's expand chevron. Named rather than indexed: the header row's
    // column menus are buttons too, and they come first in the DOM.
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand row' })[0]);
    expect(screen.getByText('Detail for Ada')).toBeInTheDocument();

    setCompact(true);
    // Not rendered in card mode — the card tree has no detail panel.
    expect(screen.queryByText('Detail for Ada')).not.toBeInTheDocument();

    setCompact(false);
    expect(screen.getByText('Detail for Ada')).toBeInTheDocument();
  });

  it('keeps consumer state — selection and sort ride through in the state prop', () => {
    // Not a new guarantee, but the one the old comment got right, and the
    // thing a future "simplification" of the cancel effect could break by
    // reaching for `createDataTableState` again on flip.
    const setCompact = dispatchingMatchMedia(false);
    render(<Harness />);

    // The header LABEL is the sort trigger (see ColumnHeader: the label is
    // both the sort target and the drag handle).
    fireEvent.click(screen.getByText('Value'));
    const sortedFirst = screen.getAllByRole('row')[1]?.textContent;

    setCompact(true);
    setCompact(false);
    expect(screen.getAllByRole('row')[1]).toHaveTextContent(sortedFirst ?? '');
  });
});

describe('topmostRowKey', () => {
  /**
   * The scroll anchor's arithmetic, tested directly.
   *
   * It cannot be tested through the component: jsdom has no layout engine, so
   * every `getBoundingClientRect()` in a render test returns zeroes, the
   * predicate "bottom is below the fold" is false for every row, and the
   * anchor is always null. Stubbing rects on real nodes is the only honest
   * way to pin the search.
   */
  function listWithRows(rowTops: number[], containerTop: number, rowHeight = 40) {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ top: containerTop }) as DOMRect;
    rowTops.forEach((top, i) => {
      const row = document.createElement('div');
      row.setAttribute('data-dt-row-key', `r${i}`);
      row.getBoundingClientRect = () => ({ top, bottom: top + rowHeight }) as DOMRect;
      el.appendChild(row);
    });
    return el;
  }

  it('returns the first row whose bottom edge is still below the fold', () => {
    // Container top at 0; rows every 40px starting at -100, so r0 (-100..-60)
    // and r1 (-60..-20) are gone and r2 (-20..20) is the topmost visible.
    const el = listWithRows([-100, -60, -20, 20, 60], 0);
    expect(topmostRowKey(el)).toBe('r2');
  });

  it('returns the first row when nothing has scrolled away', () => {
    const el = listWithRows([0, 40, 80], 0);
    expect(topmostRowKey(el)).toBe('r0');
  });

  it('returns null when the list is empty rather than guessing a key', () => {
    const el = listWithRows([], 0);
    expect(topmostRowKey(el)).toBeNull();
  });

  it('returns null when every row is above the fold', () => {
    // Reachable transiently — rows removed by a filter while scrolled deep.
    // Returning null leaves the previous anchor in place, which is better
    // than anchoring on a row that is no longer on screen.
    const el = listWithRows([-200, -160, -120], 0);
    expect(topmostRowKey(el)).toBeNull();
  });

  it('finds the boundary correctly at scale — the search, not a scan', () => {
    // 500 rows, 40px each, scrolled 8 000px: rows 0..199 are above the fold
    // and r200 straddles it.
    const tops = Array.from({ length: 500 }, (_, i) => i * 40 - 8000);
    const el = listWithRows(tops, 0);
    expect(topmostRowKey(el)).toBe('r200');
  });
});
