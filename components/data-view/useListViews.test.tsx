import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * The saved-views wiring every listing page repeats.
 *
 * Four pages had copied the same sixty lines and the copies had begun to differ — one
 * restored `groupBy`, another did not; one reset `sort` on a system view, another left it.
 * These pin the parts that were drifting, plus the two that are easy to get wrong:
 *
 *   · **The pinned view is applied ONCE.** It has to fire when the views first arrive
 *     (they are fetched) and never again — a later refetch re-running it would yank the
 *     reader back to their default mid-session, which reads as the page resetting itself
 *     while they work.
 *   · **A view switch drops the selection.** It is a different set of rows; carrying a
 *     selection across means a bulk action aimed at rows nobody can see any more.
 */

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));

const { createDataTableState } = await import('./DataTable');
const { useListViews } = await import('./useListViews');

type C = 'name' | 'status';
const COLUMN_IDS: C[] = ['name', 'status'];

const SYSTEM = [
  { kind: 'system' as const, id: 'sys:all', name: 'All' },
  {
    kind: 'system' as const,
    id: 'sys:active',
    name: 'Active',
    filters: [{ id: 'sv-1', field: 'status' as C, op: 'equals' as const, value: 'ACTIVE' }],
  },
];

const LABELS = {
  namePrompt: 'Name this view:',
  nameDefault: 'My view',
  renamePrompt: 'Rename view:',
  deleteConfirm: (name: string) => `Delete ${name}?`,
};

/** Renders the hook's prop bag as buttons, plus the table state as JSON. */
function Host() {
  const [tableState, setTableState] = useState(() =>
    createDataTableState(COLUMN_IDS.map((id) => ({ id })) as never, {
      selectedIds: new Set(['row-1']),
    }),
  );
  const bag = useListViews<C>({
    resource: 'people',
    systemViews: SYSTEM,
    columnIds: COLUMN_IDS,
    tableState: tableState as never,
    setTableState: setTableState as never,
    labels: LABELS,
  });
  return (
    <>
      <span data-testid="active">{bag.activeViewId}</span>
      <span data-testid="state">
        {JSON.stringify({
          filters: tableState.filters,
          sort: tableState.sort,
          density: tableState.density,
          selected: [...tableState.selectedIds],
          hidden: Object.entries(tableState.columnVisibility)
            .filter(([, v]) => v === false)
            .map(([k]) => k),
        })}
      </span>
      {bag.views.map((v) => (
        <button key={v.id} type="button" onClick={() => bag.onSelectView(v.id)}>
          {v.name}
        </button>
      ))}
      <button type="button" onClick={bag.onSaveAsNew}>
        save-as-new
      </button>
      <button type="button" onClick={() => bag.onRenameView('uv-1', 'Mine')}>
        rename
      </button>
      <button type="button" onClick={() => bag.onDeleteView('uv-1', 'Mine')}>
        delete
      </button>
      <button type="button" onClick={() => bag.onSelectView('sys:nope')}>
        unknown
      </button>
    </>
  );
}

const state = () => JSON.parse(screen.getByTestId('state').textContent ?? '{}');

function setTrpc(views: unknown[] = [], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: { 'savedViews.list': { data: views }, ...over.queries },
  });
}

const userView = (over: Record<string, unknown> = {}) => ({
  id: 'uv-1',
  name: 'Mine',
  pinned: false,
  state: {
    filters: [{ id: 'f1', field: 'name', op: 'contains', value: 'ada' }],
    visibleColumns: ['name'],
    sort: { field: 'name', dir: 'asc' },
    density: 'compact',
  },
  ...over,
});

afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

describe('picking a view', () => {
  it('applies a system view’s filters and clears the sort', async () => {
    const user = userEvent.setup();
    setTrpc();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Active' }));
    expect(state().filters).toMatchObject([{ field: 'status', op: 'equals', value: 'ACTIVE' }]);
    expect(state().sort).toBeNull();
    expect(screen.getByTestId('active')).toHaveTextContent('sys:active');
  });

  it('gives the clauses FRESH ids, so selecting a view twice is not two rows keyed alike', async () => {
    const user = userEvent.setup();
    setTrpc();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Active' }));
    const first = state().filters[0].id;
    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.click(screen.getByRole('button', { name: 'Active' }));
    expect(state().filters[0].id).not.toBe(first);
    // …and never the literal id the system view declares.
    expect(state().filters[0].id).not.toBe('sv-1');
  });

  it('restores a saved view’s filters, sort, density and visible columns', async () => {
    const user = userEvent.setup();
    setTrpc([userView()]);
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Mine' }));
    expect(state().filters).toMatchObject([{ field: 'name', value: 'ada' }]);
    expect(state().sort).toEqual({ field: 'name', dir: 'asc' });
    expect(state().density).toBe('compact');
    // `status` was not in the saved set, so it is hidden.
    expect(state().hidden).toEqual(['status']);
  });

  it('drops the selection, because the rows underneath it changed', async () => {
    /**
     * A bulk action carried across a view switch is aimed at rows nobody can see any
     * more — and on this page that is "approve these six reports".
     */
    const user = userEvent.setup();
    setTrpc([userView()]);
    render(<Host />);
    expect(state().selected).toEqual(['row-1']);
    await user.click(screen.getByRole('button', { name: 'Active' }));
    expect(state().selected).toEqual([]);
  });

  it('ignores an id that is not in the list', async () => {
    // A stale id from a view somebody deleted must not blank the page.
    const user = userEvent.setup();
    setTrpc();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Active' }));
    await user.click(screen.getByRole('button', { name: 'unknown' }));
    expect(screen.getByTestId('active')).toHaveTextContent('sys:active');
  });
});

describe('the reader’s pinned default', () => {
  it('is applied when the views first arrive', () => {
    setTrpc([userView({ pinned: true })]);
    render(<Host />);
    expect(state().filters).toMatchObject([{ field: 'name', value: 'ada' }]);
  });

  it('is NOT re-applied when the list is fetched again', async () => {
    /**
     * The one that reads as the page resetting itself while somebody works: a refetch
     * re-running the effect would throw away whatever they had just filtered by.
     */
    const user = userEvent.setup();
    setTrpc([userView({ pinned: true })]);
    const { rerender } = render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Active' }));
    expect(state().filters).toMatchObject([{ field: 'status' }]);

    // A refetch: same rows, new array identity.
    setTrpc([userView({ pinned: true })]);
    await act(async () => {
      rerender(<Host />);
    });
    expect(state().filters).toMatchObject([{ field: 'status' }]);
  });

  it('leaves the first system view active when nothing is pinned', () => {
    setTrpc([userView()]);
    render(<Host />);
    expect(screen.getByTestId('active')).toHaveTextContent('sys:all');
  });
});

describe('managing views', () => {
  it('saves the current state under the name that was typed', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, 'prompt').mockReturnValue('  Chase list  ');
    setTrpc([], { mutations: { 'savedViews.create': { onCall } } });
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Active' }));
    await user.click(screen.getByRole('button', { name: 'save-as-new' }));
    expect(onCall.mock.calls[0][0]).toMatchObject({
      resource: 'people',
      // Trimmed: a name with trailing space sorts oddly and reads as a different view.
      name: 'Chase list',
      state: { filters: [{ field: 'status', value: 'ACTIVE' }] },
    });
  });

  it('writes nothing when the name prompt is dismissed or left blank', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    setTrpc([], { mutations: { 'savedViews.create': { onCall } } });
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'save-as-new' }));
    prompt.mockReturnValue('   ');
    await user.click(screen.getByRole('button', { name: 'save-as-new' }));
    expect(onCall).not.toHaveBeenCalled();
  });

  it('renames only on a real change', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    setTrpc([userView()], { mutations: { 'savedViews.update': { onCall } } });
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'rename' }));
    prompt.mockReturnValue('Mine');
    await user.click(screen.getByRole('button', { name: 'rename' }));
    expect(onCall).not.toHaveBeenCalled();

    prompt.mockReturnValue('Theirs');
    await user.click(screen.getByRole('button', { name: 'rename' }));
    expect(onCall).toHaveBeenCalledWith({ id: 'uv-1', name: 'Theirs' });
  });

  it('deletes only once confirmed', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    setTrpc([userView()], { mutations: { 'savedViews.delete': { onCall } } });
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'delete' }));
    expect(onCall).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'delete' }));
    expect(onCall).toHaveBeenCalledWith({ id: 'uv-1' });
  });
});
