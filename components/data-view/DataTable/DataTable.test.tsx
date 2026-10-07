import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type MutableRefObject, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DataTable } from './DataTable';
import {
  type ColumnDef,
  createDataTableState,
  type DataTableLabels,
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
type Col = 'name' | 'value' | 'act';

const COLS: ColumnDef<Row, Col>[] = [
  { id: 'name', label: 'Name', hideable: false, cell: (r) => r.name },
  { id: 'value', label: 'Value', cell: (r) => <span>{r.value}</span> },
  {
    id: 'act',
    label: '',
    cell: (r) => (
      <button type="button" data-testid={`btn-${r.id}`}>
        act
      </button>
    ),
  },
];

const ROWS: Row[] = [
  { id: '1', name: 'Ada', value: '100' },
  { id: '2', name: 'Grace', value: '200' },
];

function Harness(props: {
  rows?: Row[];
  loading?: boolean;
  selectable?: boolean;
  onRowClick?: (r: Row) => void;
  initial?: Partial<DataTableState<Col>>;
  groupKeyFor?: (r: Row, g: Col) => string;
  stateRef?: MutableRefObject<DataTableState<Col> | undefined>;
  rowDnd?: { onReorder: (ids: string[]) => void; canDrag?: (r: Row) => boolean };
  renderExpanded?: (r: Row) => React.ReactNode;
  columns?: ColumnDef<Row, Col>[];
  virtualizeRows?: boolean;
  rowSelectable?: (r: Row) => boolean;
}) {
  const cols = props.columns ?? COLS;
  const [state, setState] = useState<DataTableState<Col>>(() =>
    createDataTableState(cols as never, props.initial ?? {}),
  );
  if (props.stateRef) props.stateRef.current = state;
  return (
    <DataTable<Row, Col>
      columns={cols}
      rows={props.rows ?? ROWS}
      rowKey={(r) => r.id}
      state={state}
      onStateChange={setState}
      labels={LABELS}
      loading={props.loading}
      selectable={props.selectable}
      rowSelectable={props.rowSelectable}
      onRowClick={props.onRowClick}
      groupKeyFor={props.groupKeyFor}
      groupLabelFor={props.groupKeyFor ? (k) => `group:${k}` : undefined}
      groupCountLabel={props.groupKeyFor ? (n) => `(${n})` : undefined}
      rowDnd={props.rowDnd}
      renderExpanded={props.renderExpanded}
      virtualizeRows={props.virtualizeRows}
      disableInfiniteScroll
      renderEmpty={() => <span>empty-state</span>}
    />
  );
}

describe('<DataTable>', () => {
  it('lets a long unbreakable token wrap inside its own column', () => {
    /**
     * Under `table-layout: fixed` a cell whose content is wider than its column overflows
     * VISIBLY into the next one, and no browser breaks on `/`. The fr-CA expense category
     * "Messagerie/Expédition/Affranchissement" therefore ran straight through the Status
     * column and read as "…AffranchissementOuverte" (GA readiness report F43).
     *
     * jsdom does not lay out, so the class is the only observable — but it is the whole
     * fix, and without it the two columns collide in every locale whose words are longer
     * than the widths were chosen for.
     */
    const { container } = render(<Harness />);
    const bodyCells = container.querySelectorAll('tbody td');
    expect(bodyCells.length).toBeGreaterThan(0);
    for (const td of bodyCells) {
      expect(td.className).toContain('break-words');
    }
  });

  it('renders a row per item across the visible columns', () => {
    render(<Harness />);
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('Value')).toBeInTheDocument();
  });

  it('renders the empty template when there are no rows', () => {
    render(<Harness rows={[]} />);
    expect(screen.getByText('empty-state')).toBeInTheDocument();
  });

  it('renders the loading label while loading with no rows', () => {
    render(<Harness rows={[]} loading />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('hides a column that is toggled off in columnVisibility', () => {
    render(<Harness initial={{ columnVisibility: { value: false } }} />);
    expect(screen.queryByText('Value')).not.toBeInTheDocument();
    expect(screen.queryByText('100')).not.toBeInTheDocument();
    // other columns still render
    expect(screen.getByText('Ada')).toBeInTheDocument();
  });

  it('selects all visible rows from the header checkbox, then clears', async () => {
    const user = userEvent.setup();
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(<Harness selectable stateRef={stateRef} />);

    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]); // header
    expect(stateRef.current?.selectedIds.size).toBe(2);

    await user.click(screen.getAllByRole('checkbox')[0]);
    expect(stateRef.current?.selectedIds.size).toBe(0);
  });

  it('selects a single row, leaving the header in a partial state', async () => {
    const user = userEvent.setup();
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(<Harness selectable stateRef={stateRef} />);

    // checkboxes: [header, row1, row2]
    await user.click(screen.getAllByRole('checkbox')[1]);
    expect(stateRef.current?.selectedIds.size).toBe(1);
    expect([...(stateRef.current?.selectedIds ?? [])]).toEqual(['1']);
  });

  it('fires onRowClick for a plain cell but not for nested interactive elements', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<Harness onRowClick={onRowClick} />);

    await user.click(screen.getByTestId('btn-1'));
    expect(onRowClick).not.toHaveBeenCalled();

    await user.click(screen.getByText('Ada'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
  });

  it('offers the pointer cursor only on a row that a click will actually do something to', () => {
    /**
     * The pointer is a promise. It sat on EVERY `<tr>` regardless of `onRowClick`, so ten
     * of the app's thirty-nine table mounts invited a click that does nothing.
     *
     * Two assertions cover all of them, because the class is emitted in exactly one place.
     * That is also why there is no per-listing test and no visual-regression sweep here.
     */
    const { container } = render(<Harness />);
    for (const tr of container.querySelectorAll('tbody tr')) {
      expect(tr.className).not.toContain('cursor-pointer');
    }
  });

  it('keeps the pointer cursor on rows that do open something', () => {
    const { container } = render(<Harness onRowClick={vi.fn()} />);
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows.length).toBeGreaterThan(0);
    for (const tr of rows) {
      expect(tr.className).toContain('cursor-pointer');
    }
  });

  it('does not open the row when its selection box is ticked', async () => {
    /**
     * Selecting rows for a bulk action is the one interaction where the row's own
     * click handler must stay out of the way. The guard used to list tag names only,
     * and the design system's Checkbox is a Base UI primitive that renders a
     * `<span role="checkbox">` — so every tick also opened the record drawer.
     */
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(<Harness selectable onRowClick={onRowClick} stateRef={stateRef} />);

    await user.click(screen.getAllByLabelText('Select row')[0]);
    expect(stateRef.current?.selectedIds.size).toBe(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('reorders rows by drag and reports the new order on drop', () => {
    const onReorder = vi.fn();
    const { container } = render(<Harness rowDnd={{ onReorder }} />);
    // A grip handle renders for each draggable row.
    expect(screen.getAllByLabelText('Drag to reorder')).toHaveLength(2);

    const row1 = container.querySelector('#data-row-1') as HTMLElement;
    const row2 = container.querySelector('#data-row-2') as HTMLElement;
    fireEvent.dragStart(row1);
    fireEvent.dragOver(row2);
    fireEvent.dragEnd(row1);
    expect(onReorder).toHaveBeenCalledWith(['2', '1']);
  });

  it('does not displace a non-draggable (fixed) row', () => {
    const onReorder = vi.fn();
    // Row 2 is fixed.
    const { container } = render(<Harness rowDnd={{ onReorder, canDrag: (r) => r.id !== '2' }} />);
    // Only the draggable row shows a grip.
    expect(screen.getAllByLabelText('Drag to reorder')).toHaveLength(1);

    fireEvent.dragStart(container.querySelector('#data-row-1') as HTMLElement);
    fireEvent.dragOver(container.querySelector('#data-row-2') as HTMLElement);
    fireEvent.dragEnd(container.querySelector('#data-row-1') as HTMLElement);
    // Drop over the fixed row is ignored → order unchanged.
    expect(onReorder).toHaveBeenCalledWith(['1', '2']);
  });

  it('partitions rows into group headers and collapses a group', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ groupBy: 'value' }} groupKeyFor={(r) => r.value} />);

    // Two distinct values → two group headers.
    expect(screen.getByText('group:100')).toBeInTheDocument();
    expect(screen.getByText('group:200')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();

    // Collapsing the first group hides its row.
    await user.click(screen.getByText('group:100'));
    expect(screen.queryByText('Ada')).not.toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
  });

  it('toggles an inline expansion panel via the leading chevron', async () => {
    const user = userEvent.setup();
    render(<Harness renderExpanded={(r) => <div>expanded-{r.id}</div>} />);

    // Collapsed by default.
    expect(screen.queryByText('expanded-1')).not.toBeInTheDocument();

    // Each row gets a chevron; clicking the first reveals its panel only.
    const chevrons = screen.getAllByRole('button', { name: 'Expand row' });
    expect(chevrons).toHaveLength(2);
    await user.click(chevrons[0]);
    expect(screen.getByText('expanded-1')).toBeInTheDocument();
    expect(screen.queryByText('expanded-2')).not.toBeInTheDocument();

    // Re-collapse via the now-expanded chevron.
    await user.click(screen.getByRole('button', { name: 'Collapse row' }));
    expect(screen.queryByText('expanded-1')).not.toBeInTheDocument();
  });

  it('renders only a WINDOW of the rows when virtualizeRows is enabled', () => {
    /**
     * This used to render the two-row default fixture and assert both were present — which
     * passes byte-for-byte with virtualization switched OFF, so it proved nothing about
     * windowing at all.
     *
     * jsdom reports `clientHeight` as 0 and `useRowWindow` falls back to a 600px viewport, so
     * with enough rows the window is genuinely smaller than the set and the difference is
     * observable in the DOM. That is what makes this assertion real.
     */
    const many = Array.from({ length: 300 }, (_, i) => ({
      id: `r${i}`,
      name: `Person ${i}`,
      value: String(i),
    }));
    render(<Harness rows={many} virtualizeRows />);

    // The top of the list is painted…
    expect(screen.getByText('Person 0')).toBeInTheDocument();
    // …and the far end is not, which is the entire point of windowing.
    expect(screen.queryByText('Person 299')).not.toBeInTheDocument();

    const painted = document.querySelectorAll('tbody tr').length;
    expect(painted).toBeGreaterThan(0);
    expect(painted).toBeLessThan(many.length);
  });

  it('paints every row when virtualizeRows is OFF', () => {
    // The other side of the same coin — otherwise the test above could pass because the table
    // renders nothing at all.
    const many = Array.from({ length: 300 }, (_, i) => ({
      id: `r${i}`,
      name: `Person ${i}`,
      value: String(i),
    }));
    render(<Harness rows={many} />);
    expect(screen.getByText('Person 299')).toBeInTheDocument();
  });

  it('swaps a cell for its inline editor on click, and back via close()', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const editCols: ColumnDef<Row, Col>[] = [
      { id: 'name', label: 'Name', hideable: false, cell: (r) => r.name },
      {
        id: 'value',
        label: 'Value',
        cell: (r) => <span>val-{r.value}</span>,
        editable: (r, { close }) => (
          <button type="button" onClick={close}>
            editor-{r.id}
          </button>
        ),
      },
    ];
    render(<Harness columns={editCols} onRowClick={onRowClick} />);

    // Read-only content shown initially.
    expect(screen.getByText('val-100')).toBeInTheDocument();
    expect(screen.queryByText('editor-1')).not.toBeInTheDocument();

    // Clicking the editable cell enters edit mode without firing row click.
    await user.click(screen.getByText('val-100'));
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.getByText('editor-1')).toBeInTheDocument();

    // The editor's close() exits edit mode back to the read-only cell.
    await user.click(screen.getByText('editor-1'));
    expect(screen.queryByText('editor-1')).not.toBeInTheDocument();
    expect(screen.getByText('val-100')).toBeInTheDocument();
  });

  describe('rowSelectable', () => {
    it("disables an ineligible row's checkbox and leaves the eligible one usable", () => {
      render(<Harness selectable rowSelectable={(r) => r.id === '1'} />);
      const boxes = screen.getAllByLabelText('Select row');
      expect(boxes).toHaveLength(2);
      // The DS checkbox is a base-ui `role="checkbox"` span, so disabled shows up as
      // aria-disabled rather than the native attribute `toBeDisabled` looks for.
      expect(boxes[0]).not.toHaveAttribute('aria-disabled');
      expect(boxes[1]).toHaveAttribute('aria-disabled', 'true');
    });

    it('select-all ticks only the eligible rows, so the header count is what an action would get', async () => {
      const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
      render(<Harness selectable rowSelectable={(r) => r.id === '1'} stateRef={stateRef} />);
      await userEvent.click(screen.getByLabelText('Select all'));
      expect([...(stateRef.current?.selectedIds ?? [])]).toEqual(['1']);
    });

    it('reports select-all as fully checked once every eligible row is ticked', () => {
      render(
        <Harness
          selectable
          rowSelectable={(r) => r.id === '1'}
          initial={{ selectedIds: new Set(['1']) }}
        />,
      );
      // Not indeterminate: row 2 can never be selected, so "all of them" is row 1 alone.
      expect(screen.getByLabelText('Select all')).toBeChecked();
    });

    it('disables select-all when no row is eligible', () => {
      render(<Harness selectable rowSelectable={() => false} />);
      expect(screen.getByLabelText('Select all')).toHaveAttribute('aria-disabled', 'true');
    });

    it('leaves every row selectable when the predicate is omitted', () => {
      render(<Harness selectable />);
      for (const box of screen.getAllByLabelText('Select row')) {
        expect(box).not.toHaveAttribute('aria-disabled');
      }
    });
  });
});

// ── Column management ─────────────────────────────────────────────────────────

/**
 * The column header's menu, which every list page in the product inherits.
 *
 * The state lives in the CONSUMER — `onStateChange` is the only way anything moves — so
 * each of these is really an assertion about the patch the table emits. A pin that forgot
 * to reorder, or a hide that replaced `columnVisibility` instead of merging it, would take
 * out thirty pages at once.
 */
describe('the column header menu', () => {
  /**
   * A column set where every menu item renders: the real COLS fixture has `name` with
   * `hideable: false` and neither column sortable or filterable, so most of the menu is
   * absent and a test would be asserting on a menu it never opened.
   */
  const MENU_COLS: ColumnDef<Row, Col>[] = [
    {
      id: 'name',
      label: 'Name',
      sortable: true,
      filterable: { kind: 'text' },
      cell: (r) => r.name,
    },
    {
      id: 'value',
      label: 'Value',
      sortable: true,
      filterable: { kind: 'text' },
      cell: (r) => r.value,
    },
  ];
  /**
   * The LAST button carrying the menu label, not the first.
   *
   * On a sortable column the quick-sort arrow reuses `labels.menu` as its aria-label, so
   * the first match is the arrow and clicking it sorts instead of opening anything — the
   * menu then never appears and every assertion below fails on a missing item.
   */
  const openMenu = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
    const header = screen.getByText(label).closest('th') as HTMLElement;
    const triggers = within(header).getAllByRole('button', { name: 'menu' });
    await user.click(triggers[triggers.length - 1]);
  };

  it('hides a column by MERGING into the visibility map', async () => {
    /** Replacing the map would un-hide every other column at the same time, which is how
     *  one click restores six columns somebody deliberately turned off. */
    const user = userEvent.setup();
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(
      <Harness
        columns={MENU_COLS}
        initial={{ columnVisibility: { act: false } }}
        stateRef={stateRef}
      />,
    );
    await openMenu(user, 'Value');
    await user.click(screen.getByText('hide'));
    expect(stateRef.current?.columnVisibility).toEqual({ act: false, value: false });
  });

  it('sorts ascending and descending from the menu', async () => {
    const user = userEvent.setup();
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(<Harness columns={MENU_COLS} stateRef={stateRef} />);
    await openMenu(user, 'Name');
    await user.click(screen.getByText('asc'));
    expect(stateRef.current?.sort).toEqual({ field: 'name', dir: 'asc' });
    await openMenu(user, 'Name');
    await user.click(screen.getByText('desc'));
    expect(stateRef.current?.sort).toEqual({ field: 'name', dir: 'desc' });
  });

  it('pins a column left and moves it to the front of the order', async () => {
    /** Pinning without reordering leaves the column stuck to the edge while its header
     *  sits in the middle — the two disagree and the table looks broken. */
    const user = userEvent.setup();
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(<Harness columns={MENU_COLS} stateRef={stateRef} />);
    await openMenu(user, 'Value');
    await user.click(screen.getByText('Pin to left'));
    expect(stateRef.current?.pinnedColumns.left).toEqual(['value']);
    expect(stateRef.current?.columnOrder[0]).toBe('value');
  });

  it('pins a column right and moves it to the end', async () => {
    const user = userEvent.setup();
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(<Harness columns={MENU_COLS} stateRef={stateRef} />);
    await openMenu(user, 'Name');
    await user.click(screen.getByText('Pin to right'));
    expect(stateRef.current?.pinnedColumns.right).toEqual(['name']);
    expect(stateRef.current?.columnOrder.at(-1)).toBe('name');
  });

  it('moves a column from one pinned side to the other rather than pinning it twice', async () => {
    /** A column in both lists is laid out twice, and the second copy sits under the first. */
    const user = userEvent.setup();
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(
      <Harness
        columns={MENU_COLS}
        initial={{ pinnedColumns: { left: ['value'], right: [] } }}
        stateRef={stateRef}
      />,
    );
    await openMenu(user, 'Value');
    await user.click(screen.getByText('Pin to right'));
    expect(stateRef.current?.pinnedColumns).toEqual({ left: [], right: ['value'] });
  });

  it('unpins from the menu', async () => {
    const user = userEvent.setup();
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(
      <Harness
        columns={MENU_COLS}
        initial={{ pinnedColumns: { left: ['value'], right: [] } }}
        stateRef={stateRef}
      />,
    );
    await openMenu(user, 'Value');
    await user.click(screen.getByText('Unpin'));
    expect(stateRef.current?.pinnedColumns).toEqual({ left: [], right: [] });
  });

  it('clears a column filter without touching the others', async () => {
    /** The header speaks one column; the state holds every page's clauses. Dropping the
     *  lot would clear filters the reader set elsewhere on the same table. */
    const user = userEvent.setup();
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(
      <Harness
        columns={MENU_COLS}
        initial={{
          filters: [
            { id: 'f1', field: 'name', op: 'contains', value: 'ada' },
            { id: 'f2', field: 'value', op: 'contains', value: '100' },
          ],
        }}
        stateRef={stateRef}
      />,
    );
    await openMenu(user, 'Value');
    await user.click(screen.getByText('filter'));
    // The editor's Clear is what removes this column's clause.
    await user.click(screen.getByRole('button', { name: 'clear' }));
    expect(stateRef.current?.filters).toEqual([
      { id: 'f1', field: 'name', op: 'contains', value: 'ada' },
    ]);
  });
});

describe('resizing a column', () => {
  const handleFor = (label: string) =>
    (screen.getByText(label).closest('th') as HTMLElement).querySelector(
      '[title="resize"]',
    ) as HTMLElement;

  it('follows the pointer, and records the width on the consumer', async () => {
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(<Harness stateRef={stateRef} />);
    fireEvent.mouseDown(handleFor('Value'), { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 160 });
    const width = stateRef.current?.columnWidths.value;
    expect(width).toBeGreaterThan(0);
    fireEvent.mouseUp(window);
  });

  it('refuses to shrink a column into nothing', async () => {
    /** Past a floor the header is unreadable and the handle itself becomes unclickable —
     *  a column somebody cannot get back. */
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(<Harness stateRef={stateRef} />);
    fireEvent.mouseDown(handleFor('Value'), { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: -5_000 });
    expect(stateRef.current?.columnWidths.value).toBeGreaterThanOrEqual(60);
    fireEvent.mouseUp(window);
  });

  it('stops following once the button is released', async () => {
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(<Harness stateRef={stateRef} />);
    fireEvent.mouseDown(handleFor('Value'), { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 200 });
    const settled = stateRef.current?.columnWidths.value;
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 900 });
    expect(stateRef.current?.columnWidths.value).toBe(settled);
  });

  it('restores the cursor and text selection when it ends', async () => {
    /** Leaving `userSelect: none` on the body makes the whole page unselectable, which
     *  reads as the app having frozen. */
    render(<Harness />);
    fireEvent.mouseDown(handleFor('Value'), { clientX: 100 });
    expect(document.body.style.cursor).toBe('col-resize');
    fireEvent.mouseUp(window);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('auto-sizes to the widest cell, within bounds', async () => {
    const user = userEvent.setup();
    const stateRef: MutableRefObject<DataTableState<Col> | undefined> = { current: undefined };
    render(<Harness stateRef={stateRef} />);
    const header = screen.getByText('Value').closest('th') as HTMLElement;
    await user.click(within(header).getByRole('button', { name: 'menu' }));
    await user.click(screen.getByText('Auto-size column'));
    const width = stateRef.current?.columnWidths.value;
    // jsdom reports every scrollWidth as 0, so the floor is what this lands on — which is
    // the assertion that matters: the result is always a usable width, never 0.
    expect(width).toBeGreaterThanOrEqual(60);
    expect(width).toBeLessThanOrEqual(600);
  });
});
