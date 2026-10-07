import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FilterClause } from '../filters/types';
import { FilterSheet } from './FilterSheet';

/**
 * The two things the sheet exists to get right, and one it must not do.
 *
 * 1. The literal `and`. On desktop the conjunction between two filters is
 *    never drawn — it is implied by two pills sitting side by side. Stacking
 *    them vertically destroys that implication, and a column of conditions
 *    reads as "any of these" just as easily as "all of these". So the word
 *    is drawn, N−1 times, and it is real content: not `aria-hidden`, not a
 *    `::before`, because a screen reader has even less of the horizontal
 *    layout to go on than an eye does.
 *
 * 2. The trigger counts GROUPS. "Status is Submitted or Approved" is one
 *    filter to whoever set it; a trigger reading `Filters · 2` describes a
 *    screen they cannot see behind the sheet.
 *
 * 3. It does NOT add a live region. Phase 3 put one with the card list on
 *    purpose — a region has to be mounted before its text changes to be
 *    announced, and this sheet unmounts around every interaction. A second
 *    one here would either double the announcement or replace a working one
 *    with a dead one.
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

/** Two groups, five clauses — the case where counting the wrong thing shows. */
const TWO_GROUPS: FilterClause<F>[] = [
  { id: 'c1', field: 'status', op: 'equals', value: 'DRAFT' },
  { id: 'c2', field: 'status', op: 'equals', value: 'SUBMITTED' },
  { id: 'c3', field: 'status', op: 'equals', value: 'APPROVED' },
  { id: 'c4', field: 'name', op: 'contains', value: 'ada' },
  { id: 'c5', field: 'name', op: 'contains', value: 'grace' },
];

function renderSheet(filters: FilterClause<F>[]) {
  const fns = {
    onUpdateOp: vi.fn(),
    onUpdateValue: vi.fn(),
    onRemoveClause: vi.fn(),
    onAddClause: vi.fn(),
    onClearAll: vi.fn(),
  };
  const utils = render(
    <FilterSheet<F>
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

const openSheet = async () => {
  await userEvent.click(screen.getByRole('button', { name: /^Filters/ }));
  return screen.getByRole('dialog');
};

describe('the trigger', () => {
  it('reads "Filters" with nothing set', () => {
    renderSheet([]);
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
  });

  it('counts GROUPS, not clauses — five clauses in two blocks is 2', () => {
    renderSheet(TWO_GROUPS);
    expect(screen.getByRole('button', { name: 'Filters · 2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filters · 5' })).not.toBeInTheDocument();
  });

  it('is a 44px target', () => {
    // The whole reason this control exists is that a thumb has to hit it.
    // jsdom has no layout engine, so the class IS the size here.
    renderSheet([]);
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveClass('h-11');
  });
});

describe('the `and` between blocks', () => {
  it('draws one fewer `and` than there are blocks', async () => {
    renderSheet(TWO_GROUPS);
    const sheet = await openSheet();
    expect(within(sheet).getAllByText('and')).toHaveLength(1);
  });

  it('draws none for a single block — there is nothing to join', async () => {
    renderSheet([{ id: 'c1', field: 'status', op: 'equals', value: 'DRAFT' }]);
    const sheet = await openSheet();
    expect(within(sheet).queryByText('and')).not.toBeInTheDocument();
  });

  it('draws it BETWEEN the blocks, not before the first', async () => {
    // Position is the whole point: a leading `and` would read as a filter
    // joined to something that is not there.
    renderSheet(TWO_GROUPS);
    const sheet = await openSheet();
    const and = within(sheet).getByText('and');
    const status = within(sheet).getByText('Status');
    const name = within(sheet).getByText('Name');
    // Node.DOCUMENT_POSITION_FOLLOWING === 4
    expect(status.compareDocumentPosition(and) & 4).toBeTruthy();
    expect(and.compareDocumentPosition(name) & 4).toBeTruthy();
  });

  it('is in the accessibility tree, not hidden decoration', async () => {
    renderSheet(TWO_GROUPS);
    const sheet = await openSheet();
    const and = within(sheet).getByText('and');
    expect(and).not.toHaveAttribute('aria-hidden');
    expect(and.closest('[aria-hidden="true"]')).toBeNull();
  });
});

describe('what the sheet hosts', () => {
  it('renders one FilterBlock per group, unchanged', async () => {
    renderSheet(TWO_GROUPS);
    const sheet = await openSheet();
    // The `or` inside a block survives untouched — FilterBlock draws it and
    // stacking does not touch it. Two `or`s: DRAFT/SUBMITTED/APPROVED gives
    // two, ada/grace gives one… three in total.
    expect(within(sheet).getAllByText('or')).toHaveLength(3);
    expect(within(sheet).getByText('Status')).toBeInTheDocument();
    expect(within(sheet).getByText('Name')).toBeInTheDocument();
  });

  it('offers Add filter at the bottom', async () => {
    renderSheet(TWO_GROUPS);
    const sheet = await openSheet();
    const add = within(sheet).getByText('Add filter');
    const name = within(sheet).getByText('Name');
    expect(name.compareDocumentPosition(add) & 4).toBeTruthy();
  });

  it('adds NO live region of its own', async () => {
    // See the note at the top. The card list owns the only one.
    renderSheet(TWO_GROUPS);
    const sheet = await openSheet();
    expect(sheet.querySelector('[aria-live]')).toBeNull();
    expect(sheet.querySelector('[role="status"]')).toBeNull();
  });
});

describe('the footer', () => {
  it('clears every clause and stays open', async () => {
    const { onClearAll } = renderSheet(TWO_GROUPS);
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Clear all' }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('offers nothing to clear when there is nothing set', async () => {
    renderSheet([]);
    const sheet = await openSheet();
    expect(within(sheet).getByRole('button', { name: 'Clear all' })).toBeDisabled();
    expect(within(sheet).getByText('No filters yet.')).toBeInTheDocument();
  });

  it('has 44px buttons', async () => {
    renderSheet(TWO_GROUPS);
    const sheet = await openSheet();
    expect(within(sheet).getByRole('button', { name: 'Clear all' })).toHaveClass('h-11');
    expect(within(sheet).getByRole('button', { name: 'Done' })).toHaveClass('h-11');
  });

  it('Done closes the sheet', async () => {
    renderSheet(TWO_GROUPS);
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('copy', () => {
  it('takes every string as a prop — the design system has no catalog', async () => {
    // Phase 6 threads next-intl through exactly this seam. If a string is
    // hardcoded, it cannot be translated, and a French reader gets an
    // English word in the middle of their filters (GA readiness F43).
    render(
      <FilterSheet<F>
        filters={TWO_GROUPS}
        fields={FIELDS}
        fieldLabels={FIELD_LABELS}
        fieldKinds={FIELD_KINDS}
        options={OPTIONS}
        onUpdateOp={vi.fn()}
        onUpdateValue={vi.fn()}
        onRemoveClause={vi.fn()}
        onAddClause={vi.fn()}
        onClearAll={vi.fn()}
        sheetLabels={{
          trigger: 'Filtres',
          triggerWithCount: (n) => `Filtres (${n})`,
          title: 'Filtres',
          and: 'et',
          empty: 'Aucun filtre.',
          clearAll: 'Tout effacer',
          done: 'Terminé',
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filtres (2)' }));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText('et')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Terminé' })).toBeInTheDocument();
  });
});
