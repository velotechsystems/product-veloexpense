import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterChip } from './FilterChip';
import type { ColumnFilter, DataTableLabels } from './types';

/**
 * The display-only active-filter chip: `<Column> <operator> "value" ×`.
 *
 * Its whole job is telling somebody what is currently being hidden from them. A chip that
 * renders the wrong operator word — `is any of` where `is none of` applies — describes the
 * filter as the exact inverse of what the table is doing, and the user reads the resulting
 * row count as the answer to a question they did not ask. Every operator therefore gets an
 * assertion rather than a representative sample.
 */

/** Distinct strings per operator, so a mapping that reaches for the neighbouring key
 *  fails instead of coincidentally matching. */
const LABELS = {
  removeFilter: 'Remove filter',
  op_contains: 'contains',
  op_doesNotContain: 'does not contain',
  op_equals: 'is',
  op_doesNotEqual: 'is not',
  op_startsWith: 'starts with',
  op_endsWith: 'ends with',
  op_isEmpty: 'is empty',
  op_isNotEmpty: 'is not empty',
  op_isAnyOf: 'is any of',
  op_isNoneOf: 'is none of',
} as unknown as DataTableLabels['colMenu'];

const OPTIONS = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' },
];

function renderChip(filter: ColumnFilter, onRemove = vi.fn()) {
  render(
    <FilterChip
      colLabel="Status"
      filter={filter}
      options={OPTIONS}
      onRemove={onRemove}
      labels={LABELS}
    />,
  );
}

describe('FilterChip — operator words', () => {
  it('renders each text operator with its own word', () => {
    const cases: [ColumnFilter, string][] = [
      [{ op: 'contains', value: 'x' }, 'contains'],
      [{ op: 'doesNotContain', value: 'x' }, 'does not contain'],
      [{ op: 'equals', value: 'x' }, 'is'],
      [{ op: 'doesNotEqual', value: 'x' }, 'is not'],
      [{ op: 'startsWith', value: 'x' }, 'starts with'],
      [{ op: 'endsWith', value: 'x' }, 'ends with'],
    ];
    for (const [filter, word] of cases) {
      const { unmount } = render(
        <FilterChip
          colLabel="Status"
          filter={filter}
          options={OPTIONS}
          onRemove={vi.fn()}
          labels={LABELS}
        />,
      );
      expect(screen.getByText(word), filter.op).toBeInTheDocument();
      unmount();
    }
  });

  it('renders the emptiness operators with no value at all', () => {
    // `is empty ""` would read as "empty string", which is a different filter.
    renderChip({ op: 'isEmpty' });
    expect(screen.getByText('is empty')).toBeInTheDocument();
    expect(screen.queryByText('""')).not.toBeInTheDocument();
  });

  it('renders isNotEmpty', () => {
    renderChip({ op: 'isNotEmpty' });
    expect(screen.getByText('is not empty')).toBeInTheDocument();
  });

  it('says "is" rather than "is any of" for a single-value set', () => {
    /**
     * A nicety that is also a correctness point: a one-item `isAnyOf` behaves exactly like
     * equals, and "is any of Draft" reads as though more values are involved — so somebody
     * checking why a row is missing looks for a second condition that is not there.
     */
    renderChip({ op: 'isAnyOf', values: ['DRAFT'] });
    expect(screen.getByText('is')).toBeInTheDocument();
    expect(screen.queryByText('is any of')).not.toBeInTheDocument();
  });

  it('says "is any of" once there is more than one value', () => {
    renderChip({ op: 'isAnyOf', values: ['DRAFT', 'SUBMITTED'] });
    expect(screen.getByText('is any of')).toBeInTheDocument();
  });

  it('keeps "is none of" even for a single value', () => {
    // The inverse must NOT collapse to "is" — that would state the opposite of the filter.
    renderChip({ op: 'isNoneOf', values: ['DRAFT'] });
    expect(screen.getByText('is none of')).toBeInTheDocument();
    expect(screen.queryByText('is')).not.toBeInTheDocument();
  });
});

describe('FilterChip — values', () => {
  it('shows the option LABEL, not the stored value', () => {
    // `DRAFT` is a database enum; the chip is read by people.
    renderChip({ op: 'isAnyOf', values: ['DRAFT'] });
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.queryByText('DRAFT')).not.toBeInTheDocument();
  });

  it('joins several values', () => {
    renderChip({ op: 'isAnyOf', values: ['DRAFT', 'SUBMITTED'] });
    expect(screen.getByText('Draft, Submitted')).toBeInTheDocument();
  });

  it('falls back to the raw value when no option matches', () => {
    // Options can lag the data — a status added server-side, or a stale saved view. Showing
    // the raw value is worse than a label and far better than an empty chip that looks like
    // no filter is applied.
    renderChip({ op: 'isAnyOf', values: ['RECALLED'] });
    expect(screen.getByText('RECALLED')).toBeInTheDocument();
  });

  it('shows a text operator value verbatim', () => {
    // Free text is not an enum, so it is not looked up in options.
    renderChip({ op: 'contains', value: 'le diplomate' });
    expect(screen.getByText('le diplomate')).toBeInTheDocument();
  });

  it('renders no value pill for an empty text value', () => {
    renderChip({ op: 'contains', value: '' });
    expect(screen.getByText('contains')).toBeInTheDocument();
  });
});

describe('FilterChip — removal', () => {
  it('always offers a labelled remove control', async () => {
    // The chip is the only handle on a filter the user may not have set themselves, so an
    // unlabelled × is the difference between recoverable and stuck.
    const onRemove = vi.fn();
    renderChip({ op: 'isEmpty' }, onRemove);
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('names the column it applies to', () => {
    renderChip({ op: 'isEmpty' });
    expect(screen.getByText('Status')).toBeInTheDocument();
  });
});
