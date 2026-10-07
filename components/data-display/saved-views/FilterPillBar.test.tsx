import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FilterClause } from '../filters/types';
import { FilterPillBar } from './FilterPillBar';

/**
 * The bar had no test, and its `field::op` grouping has just been lifted out
 * into `groupClauses.ts` so the mobile filter sheet can render the identical
 * partition. That lift is only safe if the behaviour it copies is pinned
 * from the OUTSIDE — from what the bar renders — rather than from the eight
 * lines that used to be inline. A test written against the extracted helper
 * would pass by construction and prove nothing about the bar.
 *
 * So everything below asserts on the rendered pills: how many blocks there
 * are, which values sit inside which, what order they come in, and where an
 * added value is routed. Those are the four things a grouping can get wrong,
 * and each of them is visible to a person reading the screen:
 *
 *   - wrong partition  → "Status is Submitted" and "Status is Approved" as
 *                        two pills, which reads as an impossible AND
 *   - wrong `or`       → values joined under the wrong operator
 *   - wrong order      → the bar reshuffles as you type
 *   - wrong routing    → a value added to one pill lands in another
 */

type F = 'status' | 'name';

const FIELDS: F[] = ['status', 'name'];
const FIELD_LABELS: Record<F, string> = { status: 'Status', name: 'Name' };
const FIELD_KINDS = { status: 'enum', name: 'text' } as const;
const OPTIONS = {
  status: [
    { value: 'DRAFT', label: 'Draft' },
    { value: 'SUBMITTED', label: 'Submitted' },
    { value: 'APPROVED', label: 'Approved' },
  ],
  name: [],
};

function renderBar(filters: FilterClause<F>[]) {
  const fns = {
    onUpdateOp: vi.fn(),
    onUpdateValue: vi.fn(),
    onRemoveClause: vi.fn(),
    onAddClause: vi.fn(),
    onClearAll: vi.fn(),
  };
  const utils = render(
    <FilterPillBar<F>
      filters={filters}
      fields={FIELDS}
      fieldLabels={FIELD_LABELS}
      fieldKinds={FIELD_KINDS}
      options={OPTIONS}
      {...fns}
    />,
  );
  return { ...utils, ...fns };
}

/** The blocks, in render order. A block is identified by its bold field name
 *  — the one element `<FilterBlock>` always draws exactly once. */
function blocks(): HTMLElement[] {
  return screen
    .getAllByText(/^(Status|Name)$/)
    .map((el) => el.parentElement)
    .filter((el): el is HTMLElement => el !== null);
}

describe('grouping — one block per field::op', () => {
  it('joins same-field same-op clauses into ONE block', () => {
    // Two `equals` on status is one sentence — "Status equals Draft or
    // Submitted" — and `<FilterBlock>` draws the `or` itself. Splitting it
    // into two pills would describe a filter that can never match.
    renderBar([
      { id: 'c1', field: 'status', op: 'equals', value: 'DRAFT' },
      { id: 'c2', field: 'status', op: 'equals', value: 'SUBMITTED' },
    ]);

    const all = blocks();
    expect(all).toHaveLength(1);
    expect(within(all[0] as HTMLElement).getByText('Draft')).toBeInTheDocument();
    expect(within(all[0] as HTMLElement).getByText('Submitted')).toBeInTheDocument();
    expect(within(all[0] as HTMLElement).getByText('or')).toBeInTheDocument();
  });

  it('splits same-field DIFFERENT-op clauses into two blocks', () => {
    // The op is half the key. "Status equals Draft" and "Status doesn't equal
    // Approved" are not alternatives to each other, so they cannot share a
    // pill — an `or` between them would be a different filter.
    renderBar([
      { id: 'c1', field: 'status', op: 'equals', value: 'DRAFT' },
      { id: 'c2', field: 'status', op: 'doesNotEqual', value: 'APPROVED' },
    ]);

    expect(blocks()).toHaveLength(2);
    expect(screen.getByText('equals')).toBeInTheDocument();
    expect(screen.getByText("doesn't equal")).toBeInTheDocument();
    expect(screen.queryByText('or')).not.toBeInTheDocument();
  });

  it('splits different fields, even on the same op', () => {
    renderBar([
      { id: 'c1', field: 'status', op: 'equals', value: 'DRAFT' },
      { id: 'c2', field: 'name', op: 'equals', value: 'ada' },
    ]);
    expect(blocks()).toHaveLength(2);
  });

  it('is the GROUP count, not the clause count', () => {
    // The number the mobile trigger reads (`Filters · 2`). Five clauses,
    // two blocks: a person who set "Status is any of three" and "Name is
    // either of two" has set two filters, not five.
    renderBar([
      { id: 'c1', field: 'status', op: 'equals', value: 'DRAFT' },
      { id: 'c2', field: 'status', op: 'equals', value: 'SUBMITTED' },
      { id: 'c3', field: 'status', op: 'equals', value: 'APPROVED' },
      { id: 'c4', field: 'name', op: 'contains', value: 'ada' },
      { id: 'c5', field: 'name', op: 'contains', value: 'grace' },
    ]);
    expect(blocks()).toHaveLength(2);
  });
});

describe('order', () => {
  it('renders groups in FIRST-APPEARANCE order, not field order', () => {
    // `name` appears first in the clause array but second in `fields`. The
    // bar follows the array: a person watches their filters accumulate
    // left to right, and re-sorting the bar on every edit loses their place.
    renderBar([
      { id: 'c1', field: 'name', op: 'contains', value: 'ada' },
      { id: 'c2', field: 'status', op: 'equals', value: 'DRAFT' },
    ]);
    const [first, second] = blocks();
    expect(within(first as HTMLElement).getByText('Name')).toBeInTheDocument();
    expect(within(second as HTMLElement).getByText('Status')).toBeInTheDocument();
  });

  it('keeps a group in the position its FIRST clause claimed', () => {
    // A later `status` clause must not drag the status block to the end —
    // and, more importantly, must not reorder the clauses themselves. The
    // web app's `clausesToServerFilters` sends `list[0]` for a mixed-op
    // field, so a reshuffle here changes what the server is asked for.
    renderBar([
      { id: 'c1', field: 'status', op: 'equals', value: 'DRAFT' },
      { id: 'c2', field: 'name', op: 'contains', value: 'ada' },
      { id: 'c3', field: 'status', op: 'equals', value: 'SUBMITTED' },
    ]);
    const [first, second] = blocks();
    expect(within(first as HTMLElement).getByText('Status')).toBeInTheDocument();
    expect(within(first as HTMLElement).getByText('Draft')).toBeInTheDocument();
    expect(within(first as HTMLElement).getByText('Submitted')).toBeInTheDocument();
    expect(within(second as HTMLElement).getByText('Name')).toBeInTheDocument();
  });
});

describe('routing — an edit reaches the right clauses', () => {
  it('adds a value with the GROUP’s field and op, not the first field’s', async () => {
    const { onAddClause } = renderBar([
      { id: 'c1', field: 'status', op: 'equals', value: 'DRAFT' },
      { id: 'c2', field: 'name', op: 'contains', value: 'ada' },
    ]);

    // The SECOND block's add-value affordance — the one belonging to
    // `name contains`. Driving the first would pass against a bar that
    // routed everything to `fields[0]`.
    const adders = screen.getAllByLabelText('Add value');
    expect(adders).toHaveLength(2);
    await userEvent.click(adders[1] as HTMLElement);
    const input = screen.getByPlaceholderText('value…');
    fireEvent.change(input, { target: { value: 'grace' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onAddClause).toHaveBeenCalledWith('name', 'contains', 'grace');
  });

  it('an operator change rewrites EVERY clause in that block', async () => {
    // The op lives on the clause, not on the block, so switching the word on
    // a two-value pill has to write both — leaving one behind would silently
    // split the block in two on the next render.
    const { onUpdateOp } = renderBar([
      { id: 'c1', field: 'status', op: 'equals', value: 'DRAFT' },
      { id: 'c2', field: 'status', op: 'equals', value: 'SUBMITTED' },
    ]);

    await userEvent.click(screen.getByTitle('Change operator'));
    await userEvent.click(await screen.findByRole('button', { name: "doesn't equal" }));

    expect(onUpdateOp).toHaveBeenCalledTimes(2);
    expect(onUpdateOp).toHaveBeenCalledWith('c1', 'doesNotEqual');
    expect(onUpdateOp).toHaveBeenCalledWith('c2', 'doesNotEqual');
  });

  it('removing a block removes every clause in it', async () => {
    const { onRemoveClause } = renderBar([
      { id: 'c1', field: 'status', op: 'equals', value: 'DRAFT' },
      { id: 'c2', field: 'status', op: 'equals', value: 'SUBMITTED' },
    ]);
    await userEvent.click(screen.getByLabelText('Remove condition'));
    expect(onRemoveClause).toHaveBeenCalledTimes(2);
    expect(onRemoveClause).toHaveBeenCalledWith('c1');
    expect(onRemoveClause).toHaveBeenCalledWith('c2');
  });
});

describe('clear', () => {
  it('offers no clear-all with nothing to clear', () => {
    renderBar([]);
    expect(screen.queryByText('Clear filters')).not.toBeInTheDocument();
  });

  it('offers it as soon as one clause exists', async () => {
    const { onClearAll } = renderBar([{ id: 'c1', field: 'status', op: 'equals', value: 'DRAFT' }]);
    await userEvent.click(screen.getByText('Clear filters'));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});
