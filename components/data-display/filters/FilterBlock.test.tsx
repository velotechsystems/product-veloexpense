import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterBlock } from './FilterBlock';
import type { FilterClause } from './types';

/**
 * One field's pill in the filter bar — `Field op value ×` — which was 47.4% covered.
 *
 * It is the only place a person can see what is currently being hidden from them, and
 * every branch here changes that sentence: a valueless op that still renders its old
 * values describes a filter that is not running, and an editor that drops an edit leaves
 * the pill disagreeing with the table.
 */

type F = 'status';

const CLAUSES: FilterClause<F>[] = [
  { id: 'c1', field: 'status', op: 'equals', value: 'DRAFT' },
  { id: 'c2', field: 'status', op: 'equals', value: 'SUBMITTED' },
];

const OPTIONS = [
  { value: 'DRAFT', label: 'Draft', count: 3 },
  { value: 'SUBMITTED', label: 'Submitted', count: 1 },
  { value: 'APPROVED', label: 'Approved', count: 7 },
];

function renderBlock(over: Record<string, unknown> = {}) {
  const fns = {
    onOpChange: vi.fn(),
    onValueChange: vi.fn(),
    onRemoveValue: vi.fn(),
    onRemoveBlock: vi.fn(),
    onAddValue: vi.fn(),
  };
  const utils = render(
    <FilterBlock<F>
      field="status"
      fieldKind="enum"
      op="equals"
      fieldLabel="Status"
      clauses={CLAUSES}
      options={OPTIONS}
      {...fns}
      {...(over as object)}
    />,
  );
  return { ...utils, ...fns };
}

describe('what the pill says', () => {
  it('names the field and its current values by LABEL, not by stored value', () => {
    // The pill is read by somebody who never saw the enum's internal codes; showing
    // `SUBMITTED` where the table shows `Submitted` reads as a different filter.
    renderBlock();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
  });

  it('falls back to the raw value when no option matches', () => {
    // A stale saved view referencing a deleted option: better to show the code than
    // to render an empty pill that looks like no filter at all.
    renderBlock({
      clauses: [{ id: 'c1', field: 'status', op: 'equals', value: 'GONE' }],
      options: [],
    });
    expect(screen.getByText('GONE')).toBeInTheDocument();
  });

  it('shows no values at all for a valueless op', () => {
    /**
     * `isEmpty` has no operand. Rendering the previous values beside it would describe
     * a filter that is not what the table is doing — and the values are still in
     * `clauses` because the caller keeps them for when the op changes back.
     */
    renderBlock({ op: 'isEmpty' });
    expect(screen.queryByText('Draft')).not.toBeInTheDocument();
    expect(screen.queryByText('Submitted')).not.toBeInTheDocument();
  });
});

describe('removing', () => {
  it('removes the value that was clicked, by clause id', async () => {
    // By id, not by index: the same value can appear under more than one field, and an
    // index-based remove drops whichever the array happens to hold.
    const { onRemoveValue } = renderBlock();
    const removers = screen.getAllByLabelText('Remove value');
    expect(removers).toHaveLength(2);
    await userEvent.click(removers[1]);
    expect(onRemoveValue).toHaveBeenCalledWith('c2');
  });

  it('removes the whole condition from its own control', async () => {
    // Distinct from removing a value: dropping the last value and dropping the field
    // are different intents, and conflating them loses the op the person chose.
    const { onRemoveBlock, onRemoveValue } = renderBlock();
    await userEvent.click(screen.getByLabelText('Remove condition'));
    expect(onRemoveBlock).toHaveBeenCalled();
    expect(onRemoveValue).not.toHaveBeenCalled();
  });

  it('renders no value removers for a valueless op', () => {
    // Nothing to remove when the op takes no operand.
    renderBlock({ op: 'isEmpty' });
    expect(screen.queryAllByLabelText('Remove value')).toHaveLength(0);
  });
});

describe('editing a text value in place', () => {
  const TEXT = { fieldKind: 'text' as const, op: 'contains' as const };

  it('turns the value into an input when clicked', async () => {
    // Only for text ops — an enum value is chosen from a list, so a free-text box there
    // would invite a value the column can never match.
    renderBlock({
      ...TEXT,
      clauses: [{ id: 'c1', field: 'status', op: 'contains', value: 'acme' }],
      options: [],
    });
    await userEvent.click(screen.getByText('acme'));
    expect(screen.getByDisplayValue('acme')).toBeInTheDocument();
  });

  it('commits the edit on blur', async () => {
    const { onValueChange } = renderBlock({
      ...TEXT,
      clauses: [{ id: 'c1', field: 'status', op: 'contains', value: 'acme' }],
      options: [],
    });
    await userEvent.click(screen.getByText('acme'));
    const input = screen.getByDisplayValue('acme');
    fireEvent.change(input, { target: { value: 'globex' } });
    fireEvent.blur(input);
    expect(onValueChange).toHaveBeenCalledWith('c1', 'globex');
  });

  it('does not turn an enum value into a text box', async () => {
    renderBlock();
    await userEvent.click(screen.getByText('Draft'));
    expect(screen.queryByDisplayValue('Draft')).not.toBeInTheDocument();
  });
});

describe('adding a value', () => {
  it('offers only options not already used', async () => {
    /**
     * The dedupe that keeps a pill honest. `equals DRAFT or DRAFT` is not a filter
     * anybody means, and adding it makes the pill longer without changing the result —
     * so somebody re-reads it looking for the difference.
     *
     * Driven through the real Add control so the assertion cannot pass on a list that
     * was never rendered.
     */
    renderBlock();
    await userEvent.click(screen.getByLabelText('Add value'));
    // APPROVED is the only one left; DRAFT and SUBMITTED are already on the pill.
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    // Two nodes each for the used values would mean the list re-offered them.
    expect(screen.getAllByText('Draft')).toHaveLength(1);
    expect(screen.getAllByText('Submitted')).toHaveLength(1);
  });

  it('ignores a blank free-text addition', async () => {
    // Whitespace would add a clause matching everything or nothing, silently.
    const { onAddValue } = renderBlock({
      fieldKind: 'text',
      op: 'contains',
      clauses: [],
      options: [],
    });
    const boxes = screen.queryAllByRole('textbox');
    if (boxes.length > 0) {
      fireEvent.change(boxes[0], { target: { value: '   ' } });
      fireEvent.keyDown(boxes[0], { key: 'Enter' });
    }
    expect(onAddValue).not.toHaveBeenCalled();
  });
});

describe('date fields', () => {
  it('renders a date clause without needing enum options', () => {
    // A date field has no facet list; the value editor is driven by the op instead.
    renderBlock({
      fieldKind: 'date',
      op: 'within',
      clauses: [{ id: 'c1', field: 'status', op: 'within', value: 'last30' }],
      options: [],
    });
    expect(screen.getByText('Status')).toBeInTheDocument();
  });

  it('renders a between clause', () => {
    renderBlock({
      fieldKind: 'date',
      op: 'between',
      clauses: [{ id: 'c1', field: 'status', op: 'between', value: '2026-01-01..2026-02-01' }],
      options: [],
    });
    expect(screen.getByText('Status')).toBeInTheDocument();
  });
});
