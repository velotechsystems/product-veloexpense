// VeloExpense: the registry's default, not a bare tag (scripts/check-i18n.mjs, IL-1).
import { DEFAULT_LOCALE } from '@expenseos/i18n/locales';
import '@testing-library/jest-dom/vitest';
import type { Predicate } from '@expenseos/approvals';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConditionBar, CriteriaPills, PredicatePills, summarizePredicate } from './ConditionBar';
import { APPROVER_FILTER_FIELDS, type EditorOptions } from './options';

/**
 * The condition editor behind a workflow's trigger and its IF / Switch nodes.
 *
 * Everything here exists to stop an admin from authoring a condition that can never
 * match — a routing rule that silently does nothing is worse than one that is wrong,
 * because nothing about the graph says so:
 *
 *   · **The operator set follows the field's type.** A Department cannot be "greater
 *     than", and offering it would produce a comparison the engine never satisfies.
 *   · **The VALUE is re-shaped whenever the field or operator changes.** `in` wants an
 *     array and `=` wants a scalar; a stale shape survives a save and then never
 *     matches. Both directions are pinned here.
 *   · **Removing the last condition is a MODE change, not an empty list.** A trigger
 *     falls back to Always; an IF branch cannot, and keeps an empty `all`.
 *   · **AND vs OR is only offered once it means something** — with one condition the
 *     chip would be a control with no effect.
 */

const OPTIONS: EditorOptions = {
  jobLevels: [{ id: 'jl-1', code: 'L3', label: { en: 'Senior' }, sortOrder: 1 }],
  departments: [
    { id: 'dept-1', label: { en: 'Finance' } },
    { id: 'dept-2', label: { en: 'Retail' } },
  ],
  legalEntities: [{ id: 'le-1', label: { en: 'Carmigo Canada' } }],
  businessUnits: [{ id: 'bu-1', label: { en: 'Retail BU' } }],
  currencies: [{ id: 'cur-1', code: 'CAD', symbol: '$' }],
  vendors: [{ id: 'v-1', name: 'Acme' }],
  workflows: [{ key: 'wf-1', name: 'Standard' }],
  roles: [{ id: 'role-1', label: { en: 'Approver' } }],
  categories: [{ id: 'cat-1', label: { en: 'Meals' } }],
  users: [{ id: 'u-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@e.inc' }],
};

/**
 * The bar is controlled, so a harness that holds the predicate is the only way to see
 * a second edit land on the result of the first.
 */
function Harness({
  initial,
  onEmit,
  ...rest
}: {
  initial: Predicate;
  onEmit?: (p: Predicate) => void;
} & Omit<React.ComponentProps<typeof ConditionBar>, 'value' | 'onChange' | 'locale' | 'options'> & {
    options?: EditorOptions;
  }) {
  const [value, setValue] = useState<Predicate>(initial);
  return (
    <>
      <ConditionBar
        value={value}
        onChange={(p) => {
          setValue(p);
          onEmit?.(p);
        }}
        options={rest.options ?? OPTIONS}
        locale={DEFAULT_LOCALE}
        allowAlways={rest.allowAlways}
        fields={rest.fields}
        hideTitle={rest.hideTitle}
      />
      <pre data-testid="wire">{JSON.stringify(value)}</pre>
    </>
  );
}

const wire = () => JSON.parse(screen.getByTestId('wire').textContent ?? 'null');

/** Pick an option out of one of the inline menus, identified by its trigger's title. */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  menuTitle: string,
  optionLabel: string,
) {
  await user.click(screen.getByTitle(menuTitle));
  await user.click(await screen.findByRole('button', { name: optionLabel }));
}

const leaf = (over: Partial<{ field: string; op: string; value: unknown }> = {}) =>
  ({ field: 'amount', op: 'gte', value: 500, ...over }) as unknown as Predicate;

// ── summarizePredicate ────────────────────────────────────────────────────────

describe('summarizePredicate', () => {
  it('says always for the catch-all', () => {
    expect(summarizePredicate({ always: true }, OPTIONS, 'en')).toBe('always');
  });

  it('joins an all with and, and an any with or', () => {
    expect(
      summarizePredicate(
        { all: [leaf(), leaf({ field: 'lineCount', op: 'gt', value: 3 })] },
        OPTIONS,
        'en',
      ),
    ).toBe('Amount ≥ 500 and Line-item count > 3');
    expect(summarizePredicate({ any: [leaf(), leaf()] }, OPTIONS, 'en')).toBe(
      'Amount ≥ 500 or Amount ≥ 500',
    );
  });

  it('resolves an id-valued fact to its label rather than printing the uuid', () => {
    // A summary reading "Department = dept-1" is unreadable to the person authoring it.
    expect(
      summarizePredicate(leaf({ field: 'departmentId', op: 'eq', value: 'dept-1' }), OPTIONS, 'en'),
    ).toBe('Department = Finance');
  });

  it('falls back to the raw value when nothing resolves it', () => {
    expect(
      summarizePredicate(leaf({ field: 'departmentId', op: 'eq', value: 'gone' }), OPTIONS, 'en'),
    ).toBe('Department = gone');
    expect(
      summarizePredicate(leaf({ field: 'userId', op: 'eq', value: 'u-1' }), undefined, 'en'),
    ).toBe('User = u-1');
  });

  it('lists every value of a set membership', () => {
    expect(
      summarizePredicate(
        leaf({ field: 'departmentId', op: 'in', value: ['dept-1', 'dept-2'] }),
        OPTIONS,
        'en',
      ),
    ).toBe('Department is any of Finance, Retail');
  });

  it('dashes an unset value instead of printing null', () => {
    expect(summarizePredicate(leaf({ value: null }), OPTIONS, 'en')).toBe('Amount ≥ —');
    expect(summarizePredicate(leaf({ field: 'userId', op: 'eq', value: '' }), OPTIONS, 'en')).toBe(
      'User = —',
    );
  });

  it('recurses into a nested composite', () => {
    expect(
      summarizePredicate({ all: [{ any: [leaf(), leaf({ value: 1 })] }] }, OPTIONS, 'en'),
    ).toBe('Amount ≥ 500 or Amount ≥ 1');
  });
});

// ── The bar itself ────────────────────────────────────────────────────────────

describe('the condition bar', () => {
  it('says an empty condition always applies', () => {
    render(<Harness initial={{ always: true }} />);
    expect(screen.getByText('none — always applies')).toBeInTheDocument();
    expect(screen.getByText('Conditions:')).toBeInTheDocument();
  });

  it('drops its own label when a form field already provides one', () => {
    render(<Harness initial={{ always: true }} hideTitle />);
    expect(screen.queryByText('Conditions:')).not.toBeInTheDocument();
  });

  it('adds a numeric first condition at a comparison, not an equality', async () => {
    /**
     * `Amount = 0` is a condition that never fires; `Amount ≥ 0` is one that always
     * does. The second is an obviously-unfinished default, which is what a new row
     * should look like.
     */
    const user = userEvent.setup();
    render(<Harness initial={{ always: true }} />);
    await user.click(screen.getByRole('button', { name: /Add/ }));
    expect(wire()).toEqual({ all: [{ field: 'amount', op: 'gte', value: 0 }] });
  });

  it('adds a non-numeric first condition at an equality with no value', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ always: true }} fields={APPROVER_FILTER_FIELDS} />);
    await user.click(screen.getByRole('button', { name: /Add/ }));
    expect(wire()).toEqual({ all: [{ field: 'departmentId', op: 'eq', value: '' }] });
  });

  it('restricts the field menu to the fields it was given', async () => {
    // The approver filter matches the APPROVER's own attributes; offering Amount there
    // would build a filter that compares a person to a number.
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ all: [leaf({ field: 'departmentId', op: 'eq', value: 'dept-1' })] }}
        fields={APPROVER_FILTER_FIELDS}
      />,
    );
    await user.click(screen.getByTitle('Change field'));
    expect(await screen.findByRole('button', { name: 'Job level' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Amount' })).not.toBeInTheDocument();
  });

  it('offers comparisons for a numeric field and only membership for an id field', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf()] }} />);
    await user.click(screen.getByTitle(/(?:Change operator|filters\.changeOperator)/));
    expect(await screen.findByRole('button', { name: '≤' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'is any of' })).not.toBeInTheDocument();
  });

  it('only offers AND/OR once there is something to combine', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf()] }} />);
    expect(screen.queryByTitle('Combine conditions')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add/ }));
    expect(screen.getByTitle('Combine conditions')).toBeInTheDocument();
  });

  it('switches the whole group from AND to OR', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf(), leaf({ value: 1 })] }} />);
    await pick(user, 'Combine conditions', 'OR');
    expect(wire()).toEqual({
      any: [
        { field: 'amount', op: 'gte', value: 500 },
        { field: 'amount', op: 'gte', value: 1 },
      ],
    });
  });

  it('keeps the OR when a further condition is added', async () => {
    // Re-emitting `all` would silently widen an any-condition to require every clause.
    const user = userEvent.setup();
    render(<Harness initial={{ any: [leaf(), leaf({ value: 1 })] }} />);
    await user.click(screen.getByRole('button', { name: /Add/ }));
    expect(wire()).toHaveProperty('any');
    expect(wire().any).toHaveLength(3);
  });

  it('reads a bare leaf as a one-condition group', () => {
    render(<Harness initial={leaf()} />);
    expect(screen.getByTitle('Change field')).toHaveTextContent('Amount');
  });

  it('falls back to Always when the last condition is removed from a trigger', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf()] }} />);
    await user.click(
      screen.getByRole('button', { name: /(?:Remove condition|filters\.removeCondition)/ }),
    );
    expect(wire()).toEqual({ always: true });
  });

  it('keeps an empty group where Always is not allowed', async () => {
    /**
     * An IF branch that matched everything would route every subject down one side —
     * which is not the same as having no condition yet.
     */
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf()] }} allowAlways={false} />);
    await user.click(
      screen.getByRole('button', { name: /(?:Remove condition|filters\.removeCondition)/ }),
    );
    expect(wire()).toEqual({ all: [] });
  });

  it('removes the condition it was asked to, not the last one', async () => {
    const user = userEvent.setup();
    render(
      <Harness initial={{ all: [leaf({ value: 1 }), leaf({ value: 2 }), leaf({ value: 3 })] }} />,
    );
    await user.click(
      screen.getAllByRole('button', { name: /(?:Remove condition|filters\.removeCondition)/ })[1],
    );
    expect(wire().all.map((l: { value: number }) => l.value)).toEqual([1, 3]);
  });
});

// ── Re-shaping the value ──────────────────────────────────────────────────────

describe('changing the field or the operator', () => {
  it('keeps an operator that is still valid for the new field', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf({ field: 'amount', op: 'gt', value: 500 })] }} />);
    await pick(user, 'Change field', 'Line-item count');
    expect(wire().all[0]).toMatchObject({ field: 'lineCount', op: 'gt' });
  });

  it('falls back to the first valid operator when the old one cannot apply', async () => {
    // "Department > x" is not a comparison the engine can make.
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf({ field: 'amount', op: 'gt', value: 500 })] }} />);
    await pick(user, 'Change field', 'Department');
    expect(wire().all[0]).toMatchObject({ field: 'departmentId', op: 'eq' });
  });

  it('zeroes a value that is not a number when the field becomes numeric', async () => {
    const user = userEvent.setup();
    render(
      <Harness initial={{ all: [leaf({ field: 'departmentId', op: 'eq', value: 'dept-1' })] }} />,
    );
    await pick(user, 'Change field', 'Amount');
    expect(wire().all[0]).toEqual({ field: 'amount', op: 'eq', value: 0 });
  });

  it('carries a numeric value across to a text field as its text', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf({ field: 'amount', op: 'eq', value: 500 })] }} />);
    await pick(user, 'Change field', 'Department');
    expect(wire().all[0]).toEqual({ field: 'departmentId', op: 'eq', value: '500' });
  });

  it('wraps a single value into a list when the operator becomes a membership', async () => {
    const user = userEvent.setup();
    render(
      <Harness initial={{ all: [leaf({ field: 'departmentId', op: 'eq', value: 'dept-1' })] }} />,
    );
    await pick(user, 'Change operator', 'is any of');
    expect(wire().all[0]).toEqual({ field: 'departmentId', op: 'in', value: ['dept-1'] });
  });

  it('wraps an unset value into an empty list, not a list holding nothing', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf({ field: 'departmentId', op: 'eq', value: '' })] }} />);
    await pick(user, 'Change operator', 'is none of');
    expect(wire().all[0]).toEqual({ field: 'departmentId', op: 'nin', value: [] });
  });

  it('takes the first value back out of a list when membership is dropped', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ all: [leaf({ field: 'departmentId', op: 'in', value: ['dept-1', 'dept-2'] })] }}
      />,
    );
    await pick(user, 'Change operator', '=');
    expect(wire().all[0]).toEqual({ field: 'departmentId', op: 'eq', value: 'dept-1' });
  });

  it('zeroes an empty list dropped onto a numeric field', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf({ field: 'departmentId', op: 'in', value: [] })] }} />);
    await pick(user, 'Change field', 'Amount');
    expect(wire().all[0]).toEqual({ field: 'amount', op: 'eq', value: 0 });
  });

  it('marks a negated operator apart from an affirmative one', async () => {
    // The difference between "is any of" and "is none of" inverts the routing.
    const user = userEvent.setup();
    render(
      <Harness initial={{ all: [leaf({ field: 'departmentId', op: 'eq', value: 'dept-1' })] }} />,
    );
    expect(
      screen.getByTitle(/(?:Change operator|filters\.changeOperator)/).className,
    ).not.toContain('text-destructive');
    await pick(user, 'Change operator', '≠');
    expect(screen.getByTitle(/(?:Change operator|filters\.changeOperator)/).className).toContain(
      'text-destructive',
    );
  });
});

// ── Editing the value ─────────────────────────────────────────────────────────

describe('editing a value', () => {
  it('picks an id value from the option list, showing labels not ids', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf({ field: 'departmentId', op: 'eq', value: '' })] }} />);
    expect(screen.getByText('pick…')).toBeInTheDocument();
    await user.click(screen.getByText('pick…'));
    await user.click(await screen.findByRole('button', { name: 'Retail' }));
    expect(wire().all[0].value).toBe('dept-2');
    expect(screen.getByText('Retail')).toBeInTheDocument();
  });

  it('types a numeric value and commits it as a number', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf({ value: 0 })] }} />);
    await user.click(screen.getByTitle('Click to edit'));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, '2500');
    fireEvent.blur(input);
    expect(wire().all[0].value).toBe(2500);
  });

  it('reads unparseable numeric text as zero rather than NaN', async () => {
    // NaN survives JSON as null and the comparison silently stops matching.
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf({ value: 0 })] }} />);
    await user.click(screen.getByTitle('Click to edit'));
    const input = screen.getByRole('textbox');
    await user.type(input, 'abc');
    fireEvent.blur(input);
    expect(wire().all[0].value).toBe(0);
  });

  it('commits a typed value on Enter', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf({ value: 0 })] }} />);
    await user.click(screen.getByTitle('Click to edit'));
    await user.type(screen.getByRole('textbox'), '99{Enter}');
    expect(wire().all[0].value).toBe(99);
  });

  it('takes a free-text value for a field with no option source', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf({ field: 'userId', op: 'eq', value: '' })] }} />);
    await user.click(screen.getByText('value…'));
    await user.type(screen.getByRole('textbox'), 'u-42');
    fireEvent.blur(screen.getByRole('textbox'));
    expect(wire().all[0].value).toBe('u-42');
  });

  it('says a membership with no values matches anything', async () => {
    render(<Harness initial={{ all: [leaf({ field: 'departmentId', op: 'in', value: [] })] }} />);
    expect(screen.getByText('any')).toBeInTheDocument();
  });

  it('adds and removes values one at a time', async () => {
    const user = userEvent.setup();
    render(
      <Harness initial={{ all: [leaf({ field: 'departmentId', op: 'in', value: ['dept-1'] })] }} />,
    );
    await pick(user, 'Add value', 'Retail');
    expect(wire().all[0].value).toEqual(['dept-1', 'dept-2']);
    expect(screen.getByText('or')).toBeInTheDocument();
    await user.click(
      screen.getAllByRole('button', { name: /(?:Remove value|filters\.removeValue)/ })[0],
    );
    expect(wire().all[0].value).toEqual(['dept-2']);
  });

  it('stops offering values once every option is chosen', async () => {
    render(
      <Harness
        initial={{ all: [leaf({ field: 'departmentId', op: 'in', value: ['dept-1', 'dept-2'] })] }}
      />,
    );
    expect(screen.queryByTitle('Add value')).not.toBeInTheDocument();
  });

  it('takes typed values for a membership over a field with no option source', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ all: [leaf({ field: 'userId', op: 'in', value: [] })] }} />);
    await user.type(screen.getByPlaceholderText('add…'), 'u-1{Enter}');
    expect(wire().all[0].value).toEqual(['u-1']);
  });

  it('ignores a blank typed value', async () => {
    const onEmit = vi.fn();
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ all: [leaf({ field: 'userId', op: 'in', value: [] })] }}
        onEmit={onEmit}
      />,
    );
    await user.type(screen.getByPlaceholderText('add…'), '   {Enter}');
    expect(onEmit).not.toHaveBeenCalled();
  });
});

// ── The read-only siblings ────────────────────────────────────────────────────

describe('the read-only pills', () => {
  it('says Always for a node with no condition', () => {
    render(<PredicatePills value={{ always: true }} options={OPTIONS} locale={DEFAULT_LOCALE} />);
    expect(screen.getByText('Always')).toBeInTheDocument();
  });

  it('puts the conjunction between conditions, and names which one it is', () => {
    const { rerender } = render(
      <PredicatePills
        value={{ all: [leaf(), leaf({ value: 1 })] }}
        options={OPTIONS}
        locale={DEFAULT_LOCALE}
      />,
    );
    expect(screen.getByText('and')).toBeInTheDocument();
    rerender(
      <PredicatePills
        value={{ any: [leaf(), leaf({ value: 1 })] }}
        options={OPTIONS}
        locale={DEFAULT_LOCALE}
      />,
    );
    expect(screen.getByText('or')).toBeInTheDocument();
  });

  it('offers no way to edit from a node body', () => {
    render(
      <PredicatePills
        value={{ all: [leaf({ field: 'departmentId', op: 'eq', value: 'dept-1' })] }}
        options={OPTIONS}
        locale={DEFAULT_LOCALE}
      />,
    );
    expect(screen.queryByTitle('Change field')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Change operator')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /(?:Remove condition|filters\.removeCondition)/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Finance')).toBeInTheDocument();
  });

  it('dashes an unset value in a read-only pill', () => {
    render(
      <PredicatePills
        value={{ all: [leaf({ field: 'userId', op: 'eq', value: '' })] }}
        options={OPTIONS}
        locale={DEFAULT_LOCALE}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('lists membership values read-only, with no remove affordance', () => {
    render(
      <PredicatePills
        value={{ all: [leaf({ field: 'departmentId', op: 'in', value: ['dept-1', 'dept-2'] })] }}
        options={OPTIONS}
        locale={DEFAULT_LOCALE}
      />,
    );
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText('Retail')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /(?:Remove value|filters\.removeValue)/ }),
    ).not.toBeInTheDocument();
  });
});

describe('criteria pills', () => {
  it('renders nothing at all when there is nothing to say', () => {
    const { container } = render(<CriteriaPills items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('labels each criterion outside its value pill', () => {
    render(<CriteriaPills items={[{ label: 'Approver', value: 'Direct manager' }]} />);
    expect(screen.getByText('Approver')).toBeInTheDocument();
    expect(screen.getByText('Direct manager')).toBeInTheDocument();
  });

  it('warns on a criterion that is not configured yet', () => {
    // An unset required field reads as configured unless it is toned differently.
    render(<CriteriaPills items={[{ label: 'Role', value: 'not set', warn: true }]} />);
    const pill = screen.getByText('not set').parentElement as HTMLElement;
    expect(pill.className).toContain('bg-warning');
    expect(within(pill).getByText('not set')).toBeInTheDocument();
  });
});
