import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterEditor } from './FilterEditor';
import type { ColumnFilter, DataTableLabels } from './types';

/**
 * The operator + value editor behind a column's Filter menu. It was 3.8% covered.
 *
 * Its output is a `ColumnFilter` that decides which rows a person is allowed to see, so
 * the failures are all quiet: an Apply that builds the wrong shape hides rows with no
 * error, and an Apply enabled with no value produces a filter matching nothing — which
 * reads as "there is no data" rather than "you filtered everything out".
 */

const LABELS = {
  filter: 'Filter',
  cancel: 'Cancel',
  clear: 'Clear',
  apply: 'Apply',
  value: 'Value',
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

function renderEditor(over: Partial<React.ComponentProps<typeof FilterEditor>> = {}): {
  onApply: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
} {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  render(
    <FilterEditor
      columnType="text"
      options={[]}
      current={null}
      onApply={onApply}
      onCancel={onCancel}
      labels={LABELS}
      {...over}
    />,
  );
  return { onApply, onCancel };
}

describe('a text column', () => {
  it('opens on contains with an empty value box', async () => {
    renderEditor();
    expect(screen.getByText('contains')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Value')).toHaveValue('');
  });

  it('will not apply an empty value', async () => {
    // An enabled Apply here builds `contains ""`, which matches every row or none
    // depending on the comparator — either way the person cannot tell why.
    renderEditor();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('will not apply whitespace either', async () => {
    renderEditor();
    await userEvent.type(screen.getByPlaceholderText('Value'), '   ');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('builds a single-value filter, trimmed', async () => {
    const { onApply } = renderEditor();
    await userEvent.type(screen.getByPlaceholderText('Value'), '  acme  ');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    // Trimmed, or a copy-pasted value with a trailing space silently matches nothing.
    expect(onApply).toHaveBeenCalledWith({ op: 'contains', value: 'acme' });
  });
});

describe('an enum column', () => {
  it('opens on isAnyOf and lists the options as checkboxes', () => {
    renderEditor({ columnType: 'enum', options: OPTIONS });
    expect(screen.getByText('is any of')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('will not apply with nothing ticked', () => {
    // `isAnyOf []` matches no rows — an empty table that looks like missing data.
    renderEditor({ columnType: 'enum', options: OPTIONS });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('builds a multi-value filter from the ticked options', async () => {
    const { onApply } = renderEditor({ columnType: 'enum', options: OPTIONS });
    await userEvent.click(screen.getAllByRole('checkbox')[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith({ op: 'isAnyOf', values: ['DRAFT'] });
  });

  it('un-ticking removes just that value', async () => {
    const { onApply } = renderEditor({ columnType: 'enum', options: OPTIONS });
    const [a, b] = screen.getAllByRole('checkbox');
    await userEvent.click(a);
    await userEvent.click(b);
    await userEvent.click(a);
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith({ op: 'isAnyOf', values: ['SUBMITTED'] });
  });
});

describe('editing an existing filter', () => {
  it('starts from the filter already applied', () => {
    // Reopening the menu must not silently discard the current filter — the person is
    // adjusting it, not starting over.
    renderEditor({ current: { op: 'equals', value: 'acme' } as ColumnFilter });
    expect(screen.getByPlaceholderText('Value')).toHaveValue('acme');
  });

  it('pre-ticks the values of a multi-value filter', () => {
    renderEditor({
      columnType: 'enum',
      options: OPTIONS,
      current: { op: 'isNoneOf', values: ['SUBMITTED'] } as ColumnFilter,
    });
    const [draft, submitted] = screen.getAllByRole('checkbox');
    expect(draft).not.toBeChecked();
    expect(submitted).toBeChecked();
  });

  it('offers Clear only when a filter exists to clear', () => {
    const { unmount } = render(
      <FilterEditor
        columnType="text"
        options={[]}
        current={null}
        onApply={vi.fn()}
        onCancel={vi.fn()}
        labels={LABELS}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    unmount();
    renderEditor({ current: { op: 'equals', value: 'x' } as ColumnFilter });
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('Clear applies null, which is how a column filter is removed', async () => {
    const { onApply } = renderEditor({ current: { op: 'equals', value: 'x' } as ColumnFilter });
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onApply).toHaveBeenCalledWith(null);
  });

  it('Cancel neither applies nor clears', async () => {
    // Distinct from Clear: backing out must leave the existing filter in place.
    const { onApply, onCancel } = renderEditor({
      current: { op: 'equals', value: 'x' } as ColumnFilter,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('operator availability', () => {
  /**
   * `availableOps` is asserted through what the editor RENDERS rather than by opening
   * the operator dropdown: the Select renders its list in a portal that jsdom does not
   * open on a synthetic click, so a `queryByRole('option')` assertion there passes
   * whether the option exists or not — which is worse than no test.
   */
  it('gives a text column with options a working multi-value editor', () => {
    // isAnyOf is only offered for a text column when there are options to enumerate,
    // and this is that branch reached through an existing filter.
    renderEditor({
      columnType: 'text',
      options: OPTIONS,
      current: { op: 'isAnyOf', values: ['DRAFT'] } as ColumnFilter,
    });
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('needs no value at all for isEmpty', async () => {
    // NO_VALUE_OPS: Apply must be enabled with neither text nor ticks, and the built
    // filter carries only the operator.
    const { onApply } = renderEditor({ current: { op: 'isEmpty' } as ColumnFilter });
    expect(screen.queryByPlaceholderText('Value')).not.toBeInTheDocument();
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeEnabled();
    await userEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({ op: 'isEmpty' });
  });
});
