import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ColumnHeader } from './ColumnHeader';
import type { ColumnFilter, DataTableLabels, SortState } from './types';

/**
 * The header cell, which was 24.4% covered.
 *
 * Its hard part is that the label is BOTH the sort trigger and the drag handle, so every
 * column reorder ends with a pointerup on a sortable target. Without the arbitration
 * below, dragging a column to a new position also re-sorts the table — the rows move for
 * two reasons at once and the person cannot tell which.
 */

const LABELS = {
  menu: 'Column menu',
  sortAsc: 'Sort ascending',
  sortDesc: 'Sort descending',
  filter: 'Filter',
  hide: 'Hide column',
  resize: 'Resize',
} as unknown as DataTableLabels['colMenu'];

// VeloExpense: typechecked here (ExpenseOS excludes tests from tsc). `field: null` is how the
// test says "unsorted" and the component handles it; the type does not admit it, hence the cast.
const NO_SORT = { field: null, dir: 'asc' } as unknown as SortState<'name'>;

function renderHeader(over: Record<string, unknown> = {}) {
  const onSort = vi.fn();
  const onHide = vi.fn();
  const utils = render(
    <ColumnHeader<'name', 'name'>
      col="name"
      label="Name"
      sortField="name"
      sortState={NO_SORT}
      onSort={onSort}
      filterable={false}
      filterType="text"
      activeFilter={null}
      hideable
      draggable={false}
      onHide={onHide}
      labels={LABELS}
      {...(over as object)}
    />,
  );
  return { ...utils, onSort, onHide };
}

/** A click that involved no meaningful pointer movement. */
function clickLabel(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(el, { clientX: 10, clientY: 10 });
  fireEvent.click(el);
}

/** A click preceded by a drag past the 4px threshold. */
function dragLabel(el: HTMLElement) {
  fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(el, { clientX: 40, clientY: 10 });
  fireEvent.pointerUp(el, { clientX: 40, clientY: 10 });
  fireEvent.click(el);
}

describe('sorting by clicking the label', () => {
  it('sorts ascending on a first click', () => {
    const { onSort } = renderHeader();
    clickLabel(screen.getByText('Name'));
    expect(onSort).toHaveBeenCalledWith('name', 'asc');
  });

  it('flips direction when the column is already the sort field', () => {
    const { onSort } = renderHeader({ sortState: { field: 'name', dir: 'asc' } });
    clickLabel(screen.getByText('Name'));
    expect(onSort).toHaveBeenCalledWith('name', 'desc');
  });

  it('flips back to ascending from descending', () => {
    const { onSort } = renderHeader({ sortState: { field: 'name', dir: 'desc' } });
    clickLabel(screen.getByText('Name'));
    expect(onSort).toHaveBeenCalledWith('name', 'asc');
  });

  it('does not sort a column with no sort field', () => {
    // A display-only column: clicking its header must do nothing rather than sort by
    // something arbitrary.
    const { onSort } = renderHeader({ sortField: null });
    clickLabel(screen.getByText('Name'));
    expect(onSort).not.toHaveBeenCalled();
  });
});

describe('click-vs-drag arbitration', () => {
  it('suppresses the sort when the pointer moved past the threshold', () => {
    /**
     * The whole reason the arbitration exists. Reordering a column ends in a click on a
     * sortable label, so without this every drag also re-sorts — and the rows move for
     * two reasons at once.
     */
    const { onSort } = renderHeader({ draggable: true, onDragPointerDown: vi.fn() });
    dragLabel(screen.getByText('Name'));
    expect(onSort).not.toHaveBeenCalled();
  });

  it('still sorts when the pointer barely moved', () => {
    // A 4px tolerance, because a real click almost never lands on the exact same pixel
    // and demanding that would make sorting feel broken on a trackpad.
    const { onSort } = renderHeader();
    const el = screen.getByText('Name');
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(el, { clientX: 12, clientY: 11 });
    fireEvent.pointerUp(el, { clientX: 12, clientY: 11 });
    fireEvent.click(el);
    expect(onSort).toHaveBeenCalledWith('name', 'asc');
  });

  it('ignores a non-primary button', () => {
    // A right-click opens the browser menu; it must not also sort.
    const { onSort } = renderHeader();
    const el = screen.getByText('Name');
    fireEvent.pointerDown(el, { button: 2, clientX: 10, clientY: 10 });
    fireEvent.click(el);
    expect(onSort).toHaveBeenCalledWith('name', 'asc');
  });

  it('starts a drag only when the column is draggable', () => {
    const onDragPointerDown = vi.fn();
    renderHeader({ draggable: false, onDragPointerDown });
    fireEvent.pointerDown(screen.getByText('Name'), { button: 0, clientX: 1, clientY: 1 });
    expect(onDragPointerDown).not.toHaveBeenCalled();
  });

  it('hands the pointer event to the parent when it is', () => {
    // The parent owns the live column swap, so it needs the original event.
    const onDragPointerDown = vi.fn();
    renderHeader({ draggable: true, onDragPointerDown });
    fireEvent.pointerDown(screen.getByText('Name'), { button: 0, clientX: 1, clientY: 1 });
    expect(onDragPointerDown).toHaveBeenCalled();
  });
});

describe('chrome', () => {
  it('renders the column menu by default', () => {
    renderHeader();
    expect(screen.getAllByLabelText('Column menu').length).toBeGreaterThan(0);
  });

  it('renders the label alone when chrome is off', () => {
    /**
     * The affordances reserve 3rem of right padding in every header, which on a
     * five-column pane costs more than they are worth — so a small fixed table opts
     * out entirely.
     */
    renderHeader({ chrome: false });
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.queryAllByLabelText('Column menu')).toHaveLength(0);
  });
});

describe('pinning', () => {
  /**
   * Every header is `sticky top-0` by class so it survives vertical scroll — that is not
   * what pinning means here. Horizontal pinning is the inline `left` / `right` OFFSET,
   * which is the only part that varies, so that is what these assert.
   */
  it('applies the left offset it is given', () => {
    const { container } = renderHeader({ stickyLeft: 48 });
    const th = container.querySelector('th') as HTMLElement;
    expect(th.style.left).toBe('48px');
    expect(th.style.right).toBe('');
  });

  it('applies the right offset it is given', () => {
    // Cumulative offsets are the caller's job; the header applies what it is told, and
    // setting both would put a column half off-screen.
    const { container } = renderHeader({ stickyRight: 120 });
    const th = container.querySelector('th') as HTMLElement;
    expect(th.style.right).toBe('120px');
    expect(th.style.left).toBe('');
  });

  it('sets no horizontal offset when neither is given', () => {
    const { container } = renderHeader();
    const th = container.querySelector('th') as HTMLElement;
    expect(th.style.left).toBe('');
    expect(th.style.right).toBe('');
  });

  it('accepts a zero offset as a real value, not as absent', () => {
    // The leftmost pinned column sits at 0, and `stickyLeft !== undefined` rather than
    // a truthiness check is what keeps it pinned.
    const { container } = renderHeader({ stickyLeft: 0 });
    const th = container.querySelector('th') as HTMLElement;
    expect(th.style.left).toBe('0px');
  });
});

describe('active filter', () => {
  it('shows the filter affordance when the column is filterable', () => {
    renderHeader({ filterable: true, onFilter: vi.fn() });
    expect(screen.getAllByLabelText('Column menu').length).toBeGreaterThan(0);
  });

  it('marks the header when a filter is applied', () => {
    // Somebody looking at a short table needs to see that rows are being hidden;
    // otherwise the count reads as the whole truth.
    const { container } = renderHeader({
      filterable: true,
      onFilter: vi.fn(),
      activeFilter: { op: 'contains', value: 'ac' } as ColumnFilter,
    });
    expect(container.innerHTML).toContain('svg');
  });
});
