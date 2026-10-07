import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DropdownView } from './types';
import { ViewsBar } from './ViewsBar';

/**
 * The whole list-page chrome: default-bookmark, view dropdown, scope chip, filter
 * blocks, "+ Add filter", Clear, and the rail toggle. It was at 0% branch coverage.
 *
 * Three rules here are the kind that only show up in production:
 *
 *   · **Clauses group by (field, op).** Two `status equals` clauses are ONE pill
 *     reading "Status is Draft or Submitted"; two pills for the same field/op reads
 *     as an AND and describes a filter that would return nothing. Grouping also
 *     means a group-level action has to fan out over every clause in it — removing
 *     the block must remove all of them, and changing the operator must change all
 *     of them, or the pill and the table disagree.
 *   · **A system view can never be the default.** The bookmark is inert for one, and
 *     inert has to mean `disabled` — a click that silently does nothing reads as a
 *     broken button.
 *   · **Every piece of chrome text is overridable.** These strings were hardcoded and
 *     this component ships on the People page, so "Show filters" and "Untitled view"
 *     appeared in English inside a French session.
 */

type F = 'status' | 'name';
type S = 'mine' | 'all';

const systemView = (id: string, name: string) =>
  ({ id, name, kind: 'system' }) as unknown as DropdownView<F, S>;
const userView = (id: string, name: string, pinned = false) =>
  ({ id, name, kind: 'user', pinned }) as unknown as DropdownView<F, S>;

const clause = (id: string, field: F, op: string, value: string) =>
  ({ id, field, op, value }) as never;

function setup(over: Record<string, unknown> = {}) {
  const fns = {
    onSelectView: vi.fn(),
    onSaveAsNew: vi.fn(),
    onRenameView: vi.fn(),
    onDeleteView: vi.fn(),
    onTogglePinned: vi.fn<(id: string) => void>(),
    onUpdateOp: vi.fn<(id: string, op: string) => void>(),
    onUpdateValue: vi.fn(),
    onRemoveClause: vi.fn<(id: string) => void>(),
    onAddClause: vi.fn<(f: F, op: string, v: string) => void>(),
    onClearAll: vi.fn(),
    onToggleRail: vi.fn(),
    onScopeChange: vi.fn(),
  };
  const utils = render(
    <ViewsBar<F, S>
      views={[systemView('all', 'All'), userView('u1', 'Mine')]}
      activeViewId="all"
      filters={[]}
      fields={['status', 'name']}
      fieldKinds={{ status: 'enum', name: 'text' }}
      facetLabels={{ status: 'Status', name: 'Name' }}
      facetOptions={{
        status: [
          { value: 'DRAFT', label: 'Draft' },
          { value: 'SUBMITTED', label: 'Submitted' },
        ],
        name: [],
      }}
      railOpen={false}
      availableScopes={['mine', 'all']}
      scope="mine"
      scopeLabel={(s) => (s === 'mine' ? 'My records' : 'All records')}
      {...fns}
      {...(over as object)}
    />,
  );
  return { ...utils, ...fns };
}

describe('the default-view bookmark', () => {
  it('is disabled while a system view is active', () => {
    // Inert must mean disabled; a click that silently does nothing reads as broken.
    setup({ activeViewId: 'all' });
    expect(screen.getByLabelText('Set as default view')).toBeDisabled();
  });

  it('explains why in its tooltip', () => {
    setup({ activeViewId: 'all' });
    expect(screen.getByLabelText('Set as default view')).toHaveAttribute(
      'title',
      'System views cannot be set as default',
    );
  });

  it('is enabled and toggles for a user view', async () => {
    const { onTogglePinned } = setup({ activeViewId: 'u1' });
    const bookmark = screen.getByLabelText('Set as default view');
    expect(bookmark).toBeEnabled();
    await userEvent.click(bookmark);
    expect(onTogglePinned).toHaveBeenCalledWith('u1');
  });

  it('reads as pressed when the active view is already the default', () => {
    setup({
      views: [systemView('all', 'All'), userView('u1', 'Mine', true)],
      activeViewId: 'u1',
    });
    const bookmark = screen.getByLabelText('Remove as default view');
    expect(bookmark).toHaveAttribute('aria-pressed', 'true');
  });

  it('reads as unpressed otherwise', () => {
    setup({ activeViewId: 'u1' });
    expect(screen.getByLabelText('Set as default view')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('the active view name', () => {
  it('shows the active view', () => {
    setup({ activeViewId: 'u1' });
    expect(screen.getByRole('button', { name: /Mine/ })).toBeInTheDocument();
  });

  it('falls back to a placeholder when the id matches nothing', () => {
    // A deleted view can still be the stored active id.
    setup({ activeViewId: 'ghost' });
    expect(screen.getByRole('button', { name: /Untitled view/ })).toBeInTheDocument();
  });

  it('uses a supplied placeholder so it can be translated', () => {
    setup({ activeViewId: 'ghost', labels: { untitledView: 'Vue sans titre' } });
    expect(screen.getByRole('button', { name: /Vue sans titre/ })).toBeInTheDocument();
  });
});

describe('grouping clauses into pills', () => {
  it('renders one pill per (field, op) pair', () => {
    /**
     * Two `status equals` clauses are ONE pill reading "Status is Draft or Submitted".
     * Rendering two pills reads as an AND and describes a filter returning nothing.
     */
    setup({
      filters: [
        clause('c1', 'status', 'equals', 'DRAFT'),
        clause('c2', 'status', 'equals', 'SUBMITTED'),
      ],
    });
    expect(screen.getAllByText('Status')).toHaveLength(1);
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
  });

  it('separates the same field under different operators', () => {
    // "Status is Draft" and "Status is not Approved" are two conditions, not one.
    setup({
      filters: [
        clause('c1', 'status', 'equals', 'DRAFT'),
        clause('c2', 'status', 'doesNotEqual', 'SUBMITTED'),
      ],
    });
    expect(screen.getAllByText('Status')).toHaveLength(2);
  });

  it('separates different fields', () => {
    setup({
      filters: [clause('c1', 'status', 'equals', 'DRAFT'), clause('c2', 'name', 'contains', 'ada')],
    });
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
  });

  it('fans a block removal out over every clause in the group', () => {
    // Removing one and leaving the other would leave a filter running with no pill.
    const { onRemoveClause } = setup({
      filters: [
        clause('c1', 'status', 'equals', 'DRAFT'),
        clause('c2', 'status', 'equals', 'SUBMITTED'),
      ],
    });
    return userEvent.click(screen.getByLabelText('Remove condition')).then(() => {
      expect(onRemoveClause).toHaveBeenCalledWith('c1');
      expect(onRemoveClause).toHaveBeenCalledWith('c2');
      expect(onRemoveClause).toHaveBeenCalledTimes(2);
    });
  });

  it('removes a single value by its own clause id', async () => {
    const { onRemoveClause } = setup({
      filters: [
        clause('c1', 'status', 'equals', 'DRAFT'),
        clause('c2', 'status', 'equals', 'SUBMITTED'),
      ],
    });
    const removers = screen.getAllByLabelText('Remove value');
    await userEvent.click(removers[1] as HTMLElement);
    // VeloExpense: vitest 2 has no toHaveBeenCalledExactlyOnceWith; the same two facts.
    expect(onRemoveClause).toHaveBeenCalledTimes(1);
    expect(onRemoveClause).toHaveBeenCalledWith('c2');
  });

  it('adds a value against the group’s own field and operator', async () => {
    const { onAddClause } = setup({ filters: [clause('c1', 'status', 'equals', 'DRAFT')] });
    await userEvent.click(screen.getByLabelText('Add value'));
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'SUBMITTED');
    expect(onAddClause).toHaveBeenCalledWith('status', 'equals', 'SUBMITTED');
  });

  it('passes the field’s facet options down to its pill', () => {
    setup({ filters: [clause('c1', 'status', 'equals', 'DRAFT')] });
    // The pill shows the LABEL, which only resolves if the options arrived.
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('tolerates a field with no facet options', () => {
    setup({ filters: [clause('c1', 'name', 'contains', 'ada')] });
    expect(screen.getByText('ada')).toBeInTheDocument();
  });
});

describe('clear filters', () => {
  it('is hidden when nothing is filtered', () => {
    setup({ filters: [] });
    expect(screen.queryByText('Clear filters')).not.toBeInTheDocument();
  });

  it('appears once something is', () => {
    setup({ filters: [clause('c1', 'status', 'equals', 'DRAFT')] });
    expect(screen.getByText('Clear filters')).toBeInTheDocument();
  });

  it('reports a clear', async () => {
    const { onClearAll } = setup({ filters: [clause('c1', 'status', 'equals', 'DRAFT')] });
    await userEvent.click(screen.getByText('Clear filters'));
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  it('uses a supplied label', () => {
    setup({
      filters: [clause('c1', 'status', 'equals', 'DRAFT')],
      labels: { clearFilters: 'Effacer les filtres' },
    });
    expect(screen.getByText('Effacer les filtres')).toBeInTheDocument();
  });
});

describe('the rail toggle', () => {
  it('offers to show the rail when closed', () => {
    setup({ railOpen: false });
    expect(screen.getByText('Show filters')).toBeInTheDocument();
  });

  it('offers to hide it when open', () => {
    setup({ railOpen: true });
    expect(screen.getByText('Hide filters')).toBeInTheDocument();
  });

  it('reports a toggle', async () => {
    const { onToggleRail } = setup();
    await userEvent.click(screen.getByText('Show filters'));
    expect(onToggleRail).toHaveBeenCalledOnce();
  });

  it('uses supplied labels for both states', () => {
    const closed = setup({ railOpen: false, labels: { showFilters: 'Afficher' } });
    expect(screen.getByText('Afficher')).toBeInTheDocument();
    closed.unmount();
    setup({ railOpen: true, labels: { hideFilters: 'Masquer' } });
    expect(screen.getByText('Masquer')).toBeInTheDocument();
  });
});

describe('the scope chip', () => {
  it('renders when there is a choice', () => {
    setup({ availableScopes: ['mine', 'all'], scope: 'mine' });
    expect(screen.getByRole('button', { name: /My records/ })).toBeInTheDocument();
  });

  it('suppresses itself when there is only one scope', () => {
    // A role that only ever sees its own records gets no stuck chip.
    setup({ availableScopes: ['mine'], scope: 'mine' });
    expect(screen.queryByRole('button', { name: /My records/ })).not.toBeInTheDocument();
  });

  it('reports a scope change', async () => {
    const { onScopeChange } = setup();
    await userEvent.click(screen.getByRole('button', { name: /My records/ }));
    await userEvent.click(screen.getByRole('button', { name: /All records/ }));
    expect(onScopeChange).toHaveBeenCalledWith('all');
  });
});

describe('composition', () => {
  it('always offers a way to add a filter', () => {
    setup({ filters: [] });
    expect(screen.getByText('Add filter')).toBeInTheDocument();
  });

  it('keeps a stable minimum height so the bar does not jump', () => {
    /**
     * The empty bar is a few pixels shorter than one holding a value pill, so the
     * whole page shifted the moment the first filter appeared. The floor is locked at
     * the with-filter height.
     */
    const { container } = setup({ filters: [] });
    expect(container.firstElementChild?.className).toContain('min-h-[46px]');
  });
});
