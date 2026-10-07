/**
 * Which tree mounts — the table, or the compact card list.
 *
 * A separate file from `DataTable.test.tsx` on purpose. That suite is the
 * table's own contract and it is not modified by this work: the single-tree
 * design was chosen precisely so those 35 tests keep passing byte-for-byte,
 * without a `within(screen.getByRole('table'))` migration.
 *
 * Two rules govern what may be asserted here:
 *
 *   - Never assert on the cloak classes. `CARDS_ONLY` / `TABLE_ONLY` exist
 *     only to suppress a pre-hydration flash in a real browser; in jsdom
 *     one tree exists and the class on it is inert. A test that pinned
 *     `toHaveClass('md:hidden')` would re-couple the suite to the CSS
 *     mechanism the single-tree design removed.
 *   - Assert on ROLES. `table` vs `list` is the observable difference a
 *     screen reader and a user both get, and it survives any restyling of
 *     the card.
 */

import '@testing-library/jest-dom/vitest';
import { COMPACT_QUERY } from '@expenseos/design-system';
import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable } from './DataTable';
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
  { id: 'value', label: 'Value', cell: (r) => <span>{r.value}</span> },
];

const ROWS: Row[] = [
  { id: '1', name: 'Ada', value: '100' },
  { id: '2', name: 'Grace', value: '200' },
];

const MOBILE: DataTableMobileConfig<Row, Col> = { title: 'name', fields: ['value'] };

/**
 * Answer `matchMedia` as a phone (or not).
 *
 * Only `COMPACT_QUERY` is answered with `compact`; every other query still
 * gets `false`, so this does not accidentally flip some unrelated probe
 * inside the design-system primitives the table mounts.
 *
 * `useIsCompact` reads through `window.matchMedia` on every snapshot and
 * subscribes via `addEventListener('change')`, so both have to exist.
 */
function stubMatchMedia(compact: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === COMPACT_QUERY ? compact : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function Harness(props: {
  layout?: 'auto' | 'table' | 'cards';
  rows?: Row[];
  virtualizeRows?: boolean;
  initial?: Partial<DataTableState<Col>>;
}) {
  const [state, setState] = useState<DataTableState<Col>>(() =>
    createDataTableState(COLS as never, props.initial ?? {}),
  );
  return (
    <DataTable<Row, Col>
      columns={COLS}
      rows={props.rows ?? ROWS}
      rowKey={(r) => r.id}
      state={state}
      onStateChange={setState}
      labels={LABELS}
      layout={props.layout}
      mobile={MOBILE}
      virtualizeRows={props.virtualizeRows}
      disableInfiniteScroll
    />
  );
}

describe('<DataTable> layout branch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mounts the card list and NOT the table when layout="cards"', () => {
    render(<Harness layout="cards" />);
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // One item per row, and the title column's own cell inside it — the
    // card reuses `ColumnDef.cell`, it does not re-render the domain.
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Ada');
    expect(items[1]).toHaveTextContent('Grace');
  });

  it('mounts the table and NOT the card list when layout="table", even on a phone', () => {
    // The explicit opt-out has to beat the viewport, or a listing that
    // genuinely needs the grid (reconciliation, print) has no way to say so.
    stubMatchMedia(true);
    render(<Harness layout="table" />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('resolves layout="auto" to cards on a compact viewport', () => {
    stubMatchMedia(true);
    render(<Harness layout="auto" />);
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('resolves layout="auto" to the table on a regular viewport', () => {
    stubMatchMedia(false);
    render(<Harness layout="auto" />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('defaults to auto — the root matchMedia polyfill reports regular, so the table', () => {
    // No stub: `tests/setup.ts` answers `matches: false` to everything, which
    // under COMPACT_QUERY's polarity means "not compact". This is why the
    // existing 35-test suite keeps taking the table branch untouched.
    render(<Harness />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('ignores virtualizeRows in card mode — every row renders', () => {
    /**
     * Virtualization measures the table's scroll container. In card mode
     * that container does not exist, so windowing must be forced off rather
     * than left to fail quietly: a live `virtual` would slice the row set
     * against a viewport nothing ever measured, and the card list would
     * render whatever `{start: 0, end: total}` happened to be at the time.
     *
     * 300 rows is well past the window the table would keep (see
     * "renders only a WINDOW of the rows" in DataTable.test.tsx), so if any
     * windowing were active here the count would come back short.
     */
    const many: Row[] = Array.from({ length: 300 }, (_, i) => ({
      id: `r${i}`,
      name: `Row ${i}`,
      value: `${i}`,
    }));
    render(<Harness layout="cards" rows={many} virtualizeRows />);
    expect(screen.getAllByRole('listitem')).toHaveLength(300);
  });
});
