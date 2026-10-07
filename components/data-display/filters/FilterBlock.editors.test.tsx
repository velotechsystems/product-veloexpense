import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AddFilterPill, FilterBlock } from './FilterBlock';
import type { FilterClause } from './types';

/**
 * The value EDITORS inside a filter pill — the date sub-editor, the add-another-value
 * flow, and the "+ Add filter" form. `FilterBlock.test.tsx` covers the pill's reading;
 * this covers the controls that write it.
 *
 * The rule that has already caused a real bug, and is invisible from the call site:
 * the datalist suggestions use `option.label`, NOT `option.value`. Facet options are
 * routinely id-keyed (`{ value: bu.id, label: 'Finance' }`), and a TEXT filter is
 * matched server-side against the human string — so suggesting `o.value` put a raw
 * UUID into the box and then into the pill. An enum filter is the opposite: it must
 * submit the id. Same component, two encodings, decided by `fieldKind`.
 */

type F = 'status' | 'name' | 'date';

const OPTIONS = [
  { value: 'bu-uuid-1', label: 'Finance', count: 3 },
  { value: 'bu-uuid-2', label: 'Operations', count: 1 },
];

function renderBlock(over: Record<string, unknown> = {}) {
  const fns = {
    onOpChange: vi.fn(),
    onValueChange: vi.fn<(id: string, v: string) => void>(),
    onRemoveValue: vi.fn(),
    onRemoveBlock: vi.fn(),
    onAddValue: vi.fn<(v: string) => void>(),
  };
  const utils = render(
    <FilterBlock<F>
      field="status"
      fieldKind="enum"
      op="equals"
      fieldLabel="Status"
      clauses={[{ id: 'c1', field: 'status', op: 'equals', value: 'bu-uuid-1' }]}
      options={OPTIONS}
      {...fns}
      {...(over as object)}
    />,
  );
  return { ...utils, ...fns };
}

const dateClause = (op: string, value: string): FilterClause<F>[] => [
  { id: 'd1', field: 'date', op, value } as FilterClause<F>,
];

describe('the relative-date editor', () => {
  const renderWithin = (value: string) =>
    renderBlock({
      field: 'date',
      fieldKind: 'date',
      op: 'within',
      fieldLabel: 'Date',
      clauses: dateClause('within', value),
      options: [],
    });

  it('offers every preset plus a custom escape hatch', () => {
    renderWithin('last7');
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toContain('today');
    expect(values).toContain('ytd');
    expect(values).toContain('lastYear');
    expect(values.at(-1)).toBe('__customDays__');
  });

  it('shows the selected preset', () => {
    renderWithin('mtd');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('mtd');
  });

  it('reports a chosen preset straight through', () => {
    const { onValueChange } = renderWithin('last7');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'qtd' } });
    expect(onValueChange).toHaveBeenCalledWith('d1', 'qtd');
  });

  it('seeds a sensible count when the custom option is picked', () => {
    // Picking "Last N days…" must produce a usable window immediately, not an
    // incomplete token the resolver would read as an empty filter.
    const { onValueChange } = renderWithin('last7');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__customDays__' } });
    expect(onValueChange).toHaveBeenCalledWith('d1', 'lastNdays:7');
  });

  it('shows the number box only in custom mode', () => {
    const preset = renderWithin('last30');
    expect(preset.container.querySelector('input[type="number"]')).toBeNull();
    preset.unmount();
    renderWithin('lastNdays:14');
    expect(screen.getByRole('spinbutton')).toHaveValue(14);
  });

  it('keeps the dropdown on the custom entry while a count is set', () => {
    renderWithin('lastNdays:14');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('__customDays__');
  });

  it('reports an edited count', () => {
    const { onValueChange } = renderWithin('lastNdays:14');
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '21' } });
    expect(onValueChange).toHaveBeenCalledWith('d1', 'lastNdays:21');
  });

  it('clamps a count of zero or blank up to one', () => {
    /**
     * A zero-day window matches nothing and reads as a broken table. The input has
     * `min={1}`, but a user can still clear it or type 0, and the browser reports the
     * raw string either way.
     */
    const { onValueChange } = renderWithin('lastNdays:14');
    for (const raw of ['0', '', '-5', 'abc']) {
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: raw } });
      expect(onValueChange).toHaveBeenLastCalledWith('d1', 'lastNdays:1');
    }
  });
});

describe('the between-dates editor', () => {
  const renderBetween = (value: string) =>
    renderBlock({
      field: 'date',
      fieldKind: 'date',
      op: 'between',
      fieldLabel: 'Date',
      clauses: dateClause('between', value),
      options: [],
    });

  it('splits the stored token across two inputs', () => {
    const { container } = renderBetween('2026-08-01..2026-08-21');
    const inputs = [...container.querySelectorAll('input[type="date"]')] as HTMLInputElement[];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.value).toBe('2026-08-01');
    expect(inputs[1]?.value).toBe('2026-08-21');
  });

  it('preserves the other half when one end changes', () => {
    // Writing only the edited half would silently clear the range the user set first.
    const { container, onValueChange } = renderBetween('2026-08-01..2026-08-21');
    const inputs = [...container.querySelectorAll('input[type="date"]')] as HTMLInputElement[];
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: '2026-07-01' } });
    expect(onValueChange).toHaveBeenCalledWith('d1', '2026-07-01..2026-08-21');
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: '2026-09-30' } });
    expect(onValueChange).toHaveBeenLastCalledWith('d1', '2026-08-01..2026-09-30');
  });

  it('starts both halves blank for an empty clause', () => {
    const { container } = renderBetween('');
    const inputs = [...container.querySelectorAll('input[type="date"]')] as HTMLInputElement[];
    expect(inputs[0]?.value).toBe('');
    expect(inputs[1]?.value).toBe('');
  });

  it('handles a half-typed token without dropping an input', () => {
    const { container } = renderBetween('2026-08-01..');
    const inputs = [...container.querySelectorAll('input[type="date"]')] as HTMLInputElement[];
    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.value).toBe('');
  });
});

describe('the single-date editor', () => {
  it('renders one date input and reports its value', () => {
    const { container, onValueChange } = renderBlock({
      field: 'date',
      fieldKind: 'date',
      op: 'on',
      fieldLabel: 'Date',
      clauses: dateClause('on', '2026-08-21'),
      options: [],
    });
    const input = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(input.value).toBe('2026-08-21');
    fireEvent.change(input, { target: { value: '2026-08-22' } });
    expect(onValueChange).toHaveBeenCalledWith('d1', '2026-08-22');
  });
});

describe('adding another value to an enum pill', () => {
  it('submits the option id, not its label', async () => {
    // An enum filter is matched against the stored id; sending "Operations" matches
    // nothing and the table silently empties.
    const { onAddValue } = renderBlock();
    await userEvent.click(screen.getByLabelText('Add value'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bu-uuid-2' } });
    expect(onAddValue).toHaveBeenCalledWith('bu-uuid-2');
  });

  it('excludes values already on the pill', async () => {
    renderBlock();
    await userEvent.click(screen.getByLabelText('Add value'));
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).not.toContain('bu-uuid-1');
    expect(values).toContain('bu-uuid-2');
  });

  it('closes the picker after a choice', async () => {
    const { container } = renderBlock();
    await userEvent.click(screen.getByLabelText('Add value'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bu-uuid-2' } });
    expect(container.querySelector('select')).toBeNull();
  });

  it('ignores the placeholder choice', async () => {
    const { onAddValue } = renderBlock();
    await userEvent.click(screen.getByLabelText('Add value'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onAddValue).not.toHaveBeenCalled();
  });

  it('abandons the picker on blur', async () => {
    const { container } = renderBlock();
    await userEvent.click(screen.getByLabelText('Add value'));
    fireEvent.blur(screen.getByRole('combobox'));
    expect(container.querySelector('select')).toBeNull();
  });
});

describe('adding another value to a text pill', () => {
  const renderText = () =>
    renderBlock({
      fieldKind: 'text',
      op: 'contains',
      field: 'name',
      fieldLabel: 'Name',
      clauses: [{ id: 'c1', field: 'name', op: 'contains', value: 'ada' }],
    });

  it('suggests the LABEL, never the id', async () => {
    /**
     * The documented bug this guards. A text filter is matched server-side against the
     * human string, and facet options are id-keyed — so suggesting `o.value` put a raw
     * UUID in the box and in the resulting pill.
     */
    const { container } = renderText();
    await userEvent.click(screen.getByLabelText('Add value'));
    const suggestions = [...(container.querySelectorAll('datalist option') ?? [])].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(suggestions).toEqual(['Finance', 'Operations']);
    expect(suggestions.join()).not.toContain('uuid');
  });

  it('commits on Enter', async () => {
    const { onAddValue } = renderText();
    await userEvent.click(screen.getByLabelText('Add value'));
    const input = screen.getByPlaceholderText('value…');
    await userEvent.type(input, 'grace{Enter}');
    expect(onAddValue).toHaveBeenCalledWith('grace');
  });

  it('commits on blur', async () => {
    const { onAddValue } = renderText();
    await userEvent.click(screen.getByLabelText('Add value'));
    const input = screen.getByPlaceholderText('value…');
    await userEvent.type(input, 'grace');
    fireEvent.blur(input);
    expect(onAddValue).toHaveBeenCalledWith('grace');
  });

  it('discards the draft on Escape', async () => {
    const { onAddValue, container } = renderText();
    await userEvent.click(screen.getByLabelText('Add value'));
    await userEvent.type(screen.getByPlaceholderText('value…'), 'grace{Escape}');
    expect(onAddValue).not.toHaveBeenCalled();
    expect(container.querySelector('input[placeholder="value…"]')).toBeNull();
  });

  it('trims before committing', async () => {
    const { onAddValue } = renderText();
    await userEvent.click(screen.getByLabelText('Add value'));
    await userEvent.type(screen.getByPlaceholderText('value…'), '  grace  {Enter}');
    expect(onAddValue).toHaveBeenCalledWith('grace');
  });

  it('ignores a whitespace-only entry', async () => {
    // An empty clause would render as a pill saying "Name contains" and filter nothing.
    const { onAddValue } = renderText();
    await userEvent.click(screen.getByLabelText('Add value'));
    await userEvent.type(screen.getByPlaceholderText('value…'), '   {Enter}');
    expect(onAddValue).not.toHaveBeenCalled();
  });

  it('uses a free-text box even on an enum field when the op is a text op', async () => {
    // "Status contains draf" is a substring match, so a picker of exact ids is wrong.
    // Asserted on the tag, not the role: an `<input list=…>` is itself exposed as a
    // combobox, so a role query cannot tell the two controls apart here.
    const { container } = renderBlock({ op: 'contains' });
    await userEvent.click(screen.getByLabelText('Add value'));
    expect(screen.getByPlaceholderText('value…')).toBeInTheDocument();
    expect(container.querySelector('select')).toBeNull();
  });
});

describe('a valueless operator', () => {
  it('offers no way to add a value', () => {
    // "is empty" takes no operand; an add button would build an unusable clause.
    renderBlock({ op: 'isEmpty' });
    expect(screen.queryByLabelText('Add value')).not.toBeInTheDocument();
  });

  it('still offers a way to remove the condition', () => {
    renderBlock({ op: 'isEmpty' });
    expect(screen.getByLabelText('Remove condition')).toBeInTheDocument();
  });
});

describe('AddFilterPill', () => {
  const FIELDS: F[] = ['status', 'name', 'date'];
  const KINDS = { status: 'enum', name: 'text', date: 'date' } as const;
  const LABELS = { status: 'Status', name: 'Name', date: 'Date' } as const;

  function renderPill() {
    const onAdd = vi.fn();
    const utils = render(
      <AddFilterPill<F>
        fields={FIELDS}
        fieldKinds={KINDS as never}
        facetLabels={LABELS as never}
        facetOptions={{ status: OPTIONS, name: OPTIONS, date: [] } as never}
        onAdd={onAdd}
      />,
    );
    return { ...utils, onAdd };
  }

  it('renders a trigger that is closed to begin with', () => {
    renderPill();
    expect(screen.getByText('Add filter')).toBeInTheDocument();
    // The form is portaled behind the popover and absent until opened.
    expect(screen.queryByText('Operator')).not.toBeInTheDocument();
  });

  it('opens the form on click', async () => {
    renderPill();
    await userEvent.click(screen.getByText('Add filter'));
    expect(screen.getByText('Field')).toBeInTheDocument();
    expect(screen.getByText('Operator')).toBeInTheDocument();
  });

  it('offers every filterable field', async () => {
    renderPill();
    await userEvent.click(screen.getByText('Add filter'));
    const fieldSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect([...fieldSelect.options].map((o) => o.value)).toEqual(['status', 'name', 'date']);
  });

  it('re-seeds the operator and value when the field changes kind', async () => {
    /**
     * Switching from a text field to a date field must reset both, or the form carries
     * an operator the new kind does not support and a value it cannot parse — which
     * commits a clause that filters nothing.
     */
    renderPill();
    await userEvent.click(screen.getByText('Add filter'));
    const [fieldSelect, opSelect] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(fieldSelect as HTMLSelectElement, { target: { value: 'date' } });
    const opsNow = [...(screen.getAllByRole('combobox')[1] as HTMLSelectElement).options].map(
      (o) => o.value,
    );
    expect(opsNow).toContain('within');
    expect(opsNow).not.toContain('contains');
    expect(opSelect).toBeDefined();
  });

  it('closes without reporting anything on Cancel', async () => {
    const { onAdd } = renderPill();
    await userEvent.click(screen.getByText('Add filter'));
    await userEvent.click(screen.getByText('Cancel'));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.queryByText('Operator')).not.toBeInTheDocument();
  });

  it('hides the value control for a valueless operator', async () => {
    renderPill();
    await userEvent.click(screen.getByText('Add filter'));
    const opSelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
    fireEvent.change(opSelect, { target: { value: 'isEmpty' } });
    expect(screen.queryByText('Value')).not.toBeInTheDocument();
  });

  it('suggests labels rather than ids for a text field', async () => {
    const { container } = renderPill();
    await userEvent.click(screen.getByText('Add filter'));
    fireEvent.change(screen.getAllByRole('combobox')[0] as HTMLSelectElement, {
      target: { value: 'name' },
    });
    const suggestions = [...container.ownerDocument.querySelectorAll('datalist option')].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(suggestions).toEqual(['Finance', 'Operations']);
  });
});
