import '@testing-library/jest-dom/vitest';
import type { ApproverSpec, Predicate } from '@expenseos/approvals';
// VeloExpense: the registry's default, not a bare tag (scripts/check-i18n.mjs, IL-1).
import { DEFAULT_LOCALE } from '@expenseos/i18n/locales';
import type { FieldProps } from '@rjsf/utils';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NodeConfigProvider } from './node-config-context';
import type { EditorOptions } from './options';
import { NODE_CONFIG_FIELDS } from './schema-fields';

/**
 * The three custom node-config controls: the condition builder, the approver editor and
 * the Switch case list.
 *
 * They exist because none of the three can be expressed as a JSON-schema widget, and
 * each carries an invariant the schema cannot enforce:
 *
 *   · **A node's own field list is INTERSECTED with the subject's.** A workflow over
 *     expense reports must never offer a VCC-only fact — a condition on one is a
 *     condition that never matches, and nothing on the canvas would say so.
 *   · **Changing the approver kind REPLACES the spec**, rather than layering keys onto
 *     the old one. The spec is a discriminated union, and a `match` left behind on a
 *     `manager` approver fails validation on save.
 *   · **A case's routing id is stable and never reused.** The graph's edges point at it,
 *     so re-deriving ids from position would silently re-route every branch when a case
 *     is removed.
 */

vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (k: string) => `workflows.${k}`;
    t.has = () => false;
    return t;
  },
  useLocale: () => 'en',
}));
/** Combobox and Select become plain controls; Base UI's popups have their own suites. */
vi.mock('@expenseos/design-system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@expenseos/design-system')>();
  const React = await import('react');
  const Ctx = React.createContext<{ value: string; onValueChange: (v: string) => void }>({
    value: '',
    onValueChange: () => undefined,
  });
  return {
    ...actual,
    Combobox: ({
      items,
      value,
      onValueChange,
      placeholder,
    }: {
      items: { value: string; label: string }[];
      value: string | null;
      onValueChange: (v: string | null) => void;
      placeholder?: string;
    }) => (
      <select
        aria-label={placeholder ?? 'combobox'}
        value={value ?? ''}
        onChange={(e) => onValueChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">{placeholder ?? '—'}</option>
        {items.map((i) => (
          <option key={i.value} value={i.value}>
            {i.label}
          </option>
        ))}
      </select>
    ),
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (v: string) => void;
      children: ReactNode;
    }) => (
      <Ctx.Provider value={{ value, onValueChange }}>
        <div data-testid="select">{children}</div>
      </Ctx.Provider>
    ),
    SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectValue: ({ children }: { children: ReactNode | ((v: string | null) => ReactNode) }) => {
      const { value } = React.useContext(Ctx);
      return <span>{typeof children === 'function' ? children(value || null) : children}</span>;
    },
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const { onValueChange } = React.useContext(Ctx);
      return (
        <button type="button" data-option={value} onClick={() => onValueChange(value)}>
          {children}
        </button>
      );
    },
  };
});

const OPTIONS = {
  jobLevels: [
    { id: 'jl-1', code: 'L3', label: { en: 'Senior' }, sortOrder: 1 },
    { id: 'jl-2', code: 'L5', label: { en: 'Director' }, sortOrder: 2 },
  ],
  departments: [{ id: 'dept-1', label: { en: 'Finance' } }],
  legalEntities: [],
  businessUnits: [],
  currencies: [],
  vendors: [],
  workflows: [],
  roles: [{ id: 'role-1', label: { en: 'Finance' } }],
  categories: [],
  users: [{ id: 'u-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@e.inc' }],
} as unknown as EditorOptions;

const {
  predicate: PredicateField,
  approver: ApproverField,
  cases: CasesField,
} = NODE_CONFIG_FIELDS;

/** Render one custom field inside the context RJSF would give it. */
function show(
  Field: (props: FieldProps) => ReactNode,
  props: Partial<FieldProps>,
  fields: string[] = ['amount', 'departmentId', 'jobLevelId', 'userId'],
) {
  const onChange = vi.fn();
  const view = render(
    <NodeConfigProvider value={{ options: OPTIONS, fields: fields as never, locale: DEFAULT_LOCALE }}>
      <Field {...({ onChange, ...props } as FieldProps)} />
    </NodeConfigProvider>,
  );
  return { onChange, view };
}

const option = (value: string) => document.querySelector(`[data-option="${value}"]`) as HTMLElement;
const lastCall = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];

// ── The condition field ───────────────────────────────────────────────────────

describe('the condition field', () => {
  it('opens on Always when a node has no condition yet', () => {
    // `undefined` formData is a node the author has not touched, not an empty group.
    show(PredicateField, { formData: undefined });
    expect(screen.getByText('none — always applies')).toBeInTheDocument();
  });

  it('refuses Always by default, because a branch that always matches is not one', () => {
    const { onChange } = show(PredicateField, {
      formData: { all: [{ field: 'amount', op: 'gte', value: 1 }] } as Predicate,
    });
    // Removing the last clause keeps an empty group rather than falling back to Always.
    expect(
      screen.getByRole('button', { name: /(?:Remove condition|filters\.removeCondition)/ }),
    ).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('allows Always where the use site says so', async () => {
    const user = userEvent.setup();
    const { onChange } = show(PredicateField, {
      formData: { all: [{ field: 'amount', op: 'gte', value: 1 }] } as Predicate,
      uiSchema: { 'ui:options': { allowAlways: true } },
    });
    await user.click(
      screen.getByRole('button', { name: /(?:Remove condition|filters\.removeCondition)/ }),
    );
    expect(lastCall(onChange)).toEqual({ always: true });
  });

  it('intersects the node’s field list with the subject’s', async () => {
    /**
     * A workflow over expense reports has no vendor. Offering one would build a
     * condition that never matches, with nothing on the canvas saying why.
     */
    const user = userEvent.setup();
    show(
      PredicateField,
      {
        formData: { all: [{ field: 'amount', op: 'gte', value: 1 }] } as Predicate,
        uiSchema: { 'ui:options': { fields: ['amount', 'vendorId'] } },
      },
      ['amount', 'departmentId'],
    );
    await user.click(screen.getByTitle('Change field'));
    // "Amount" names the open menu's trigger as well as its option.
    expect((await screen.findAllByRole('button', { name: 'Amount' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Vendor' })).not.toBeInTheDocument();
  });

  it('falls back to the subject’s whole field set when the node narrows nothing', async () => {
    const user = userEvent.setup();
    show(
      PredicateField,
      { formData: { all: [{ field: 'amount', op: 'gte', value: 1 }] } as Predicate },
      ['amount', 'departmentId'],
    );
    await user.click(screen.getByTitle('Change field'));
    expect(await screen.findByRole('button', { name: 'Department' })).toBeInTheDocument();
  });

  it('reports an edited condition straight back to the form', async () => {
    const user = userEvent.setup();
    const { onChange } = show(PredicateField, {
      formData: { all: [{ field: 'amount', op: 'gte', value: 1 }] } as Predicate,
    });
    await user.click(screen.getByRole('button', { name: /Add/ }));
    expect((lastCall(onChange) as { all: unknown[] }).all).toHaveLength(2);
  });
});

// ── The approver field ────────────────────────────────────────────────────────

describe('the approver field', () => {
  it('opens on the direct manager when nothing is set', () => {
    // The one approver that always exists, whoever the requester is.
    show(ApproverField, { formData: undefined });
    // The label reads both on the closed trigger and on its own option.
    expect(screen.getAllByText('Direct manager').length).toBeGreaterThan(0);
  });

  it('offers the three approver shapes', () => {
    show(ApproverField, { formData: { kind: 'manager' } as ApproverSpec });
    for (const kind of ['manager', 'managerChain', 'filter']) {
      expect(option(kind)).not.toBeNull();
    }
  });

  it('REPLACES the spec when the kind changes, leaving no stale keys', async () => {
    /**
     * `ApproverSpec` is a discriminated union. A `match` left over from the filter shape
     * makes a `manager` approver match no branch of it, and the graph fails validation
     * on save — after the author has finished editing.
     */
    const user = userEvent.setup();
    const { onChange } = show(ApproverField, {
      formData: {
        kind: 'filter',
        minJobLevelId: 'jl-1',
        match: { all: [{ field: 'departmentId', op: 'eq', value: 'dept-1' }] },
      } as ApproverSpec,
    });
    await user.click(option('manager'));
    expect(lastCall(onChange)).toEqual({ kind: 'manager' });
  });

  it('starts a chain approver with no minimum level', async () => {
    // Empty means "the direct manager", which is the safe reading of "not chosen".
    const user = userEvent.setup();
    const { onChange } = show(ApproverField, { formData: { kind: 'manager' } as ApproverSpec });
    await user.click(option('managerChain'));
    expect(lastCall(onChange)).toEqual({ kind: 'managerChain', minJobLevelId: null });
  });

  it('starts a filter approver matching everybody, and says as much', async () => {
    const user = userEvent.setup();
    const { onChange } = show(ApproverField, { formData: { kind: 'manager' } as ApproverSpec });
    await user.click(option('filter'));
    expect(lastCall(onChange)).toEqual({
      kind: 'filter',
      minJobLevelId: null,
      match: { always: true },
    });
  });

  it('offers a minimum level for a chain approval, naming each level readably', async () => {
    /**
     * "jl-2" tells the author nothing. The code and the label together are how somebody
     * picks the right rung.
     */
    const user = userEvent.setup();
    const { onChange } = show(ApproverField, {
      formData: { kind: 'managerChain', minJobLevelId: null } as ApproverSpec,
    });
    const picker = screen.getByLabelText('workflows.directManager');
    expect(within(picker).getByText('L5 — Director')).toBeInTheDocument();
    await user.selectOptions(picker, 'jl-2');
    expect(lastCall(onChange)).toEqual({ kind: 'managerChain', minJobLevelId: 'jl-2' });
  });

  it('lets the author name who decides when there is no manager', async () => {
    /**
     * The editor could describe every routing rule EXCEPT the one for the person at the
     * top of the org chart. Their task parks unassigned, and an unassigned
     * relative-approver task is claimable by anyone holding the subject's approve
     * permission — every line manager in the company, for an expense report.
     */
    const user = userEvent.setup();
    // Choosing the SHAPE writes an id-less fallback, which the graph schema rejects — so
    // the node reads as "invalid node config" until a person is actually named, rather
    // than as a route that quietly goes nowhere.
    const chosen = show(ApproverField, { formData: { kind: 'manager' } as ApproverSpec });
    await user.click(option('user'));
    expect(lastCall(chosen.onChange)).toEqual({
      kind: 'manager',
      fallback: { kind: 'user', userId: '' },
    });

    // And naming the person completes it. Re-rendered from the emitted state because the
    // field is controlled by its `formData` prop, which this harness does not feed back.
    const named = show(ApproverField, {
      formData: { kind: 'manager', fallback: { kind: 'user', userId: '' } } as ApproverSpec,
    });
    await user.selectOptions(screen.getByLabelText('workflows.fallbackUserPlaceholder'), 'u-1');
    expect(lastCall(named.onChange)).toEqual({
      kind: 'manager',
      fallback: { kind: 'user', userId: 'u-1' },
    });
  });

  it('names a role as the fallback too', async () => {
    const user = userEvent.setup();
    const { onChange } = show(ApproverField, {
      formData: { kind: 'manager', fallback: { kind: 'role', roleId: '' } } as ApproverSpec,
    });
    await user.selectOptions(screen.getByLabelText('workflows.fallbackRolePlaceholder'), 'role-1');
    expect(lastCall(onChange)).toEqual({
      kind: 'manager',
      fallback: { kind: 'role', roleId: 'role-1' },
    });
  });

  it('CARRIES the fallback across manager ↔ manager-ancestor', async () => {
    /**
     * Both are relative approvers with the same blind spot, so re-picking the tier must
     * not silently drop who decides for the person at the top — which is precisely the
     * edit an author makes without thinking about it.
     */
    const user = userEvent.setup();
    const { onChange } = show(ApproverField, {
      formData: {
        kind: 'manager',
        fallback: { kind: 'user', userId: 'u-1' },
      } as ApproverSpec,
    });
    await user.click(option('managerChain'));
    expect(lastCall(onChange)).toEqual({
      kind: 'managerChain',
      minJobLevelId: null,
      fallback: { kind: 'user', userId: 'u-1' },
    });
  });

  it('drops the fallback on a filter approver, which is a pool already', async () => {
    // `approverSpecSchema` has no fallback on `filter`, so carrying one over would write
    // a key the graph parse strips — and the control would lie about what was saved.
    const user = userEvent.setup();
    const { onChange } = show(ApproverField, {
      formData: {
        kind: 'manager',
        fallback: { kind: 'user', userId: 'u-1' },
      } as ApproverSpec,
    });
    await user.click(option('filter'));
    expect(lastCall(onChange)).toEqual({
      kind: 'filter',
      minJobLevelId: null,
      match: { always: true },
    });
  });

  it('offers no fallback control on a filter approver', () => {
    show(ApproverField, {
      formData: { kind: 'filter', minJobLevelId: null, match: { always: true } } as ApproverSpec,
    });
    expect(screen.queryByText('workflows.fallbackLabel')).not.toBeInTheDocument();
  });

  it('offers no minimum level for a direct-manager approval', () => {
    // There is no chain to walk, so a rung would describe nothing.
    show(ApproverField, { formData: { kind: 'manager' } as ApproverSpec });
    expect(screen.queryByLabelText('workflows.directManager')).not.toBeInTheDocument();
  });

  it('gives a filter approver both a level floor and a who-can-approve condition', async () => {
    const user = userEvent.setup();
    const { onChange } = show(ApproverField, {
      formData: { kind: 'filter', minJobLevelId: null, match: { always: true } } as ApproverSpec,
    });
    expect(screen.getByText('Who can approve')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('workflows.anyLevel'), 'jl-1');
    expect(lastCall(onChange)).toEqual({
      kind: 'filter',
      minJobLevelId: 'jl-1',
      match: { always: true },
    });
  });

  it('keeps the condition when the level changes, and the level when the condition does', async () => {
    /**
     * They are two halves of one spec. Dropping either while editing the other quietly
     * widens who can approve.
     */
    const user = userEvent.setup();
    const { onChange } = show(ApproverField, {
      formData: {
        kind: 'filter',
        minJobLevelId: 'jl-1',
        match: { all: [{ field: 'departmentId', op: 'eq', value: 'dept-1' }] },
      } as ApproverSpec,
    });
    await user.selectOptions(screen.getByLabelText('workflows.anyLevel'), 'jl-2');
    expect(lastCall(onChange)).toMatchObject({
      minJobLevelId: 'jl-2',
      match: { all: [{ field: 'departmentId', op: 'eq', value: 'dept-1' }] },
    });
    await user.click(screen.getByRole('button', { name: /Add/ }));
    expect(lastCall(onChange)).toMatchObject({ minJobLevelId: 'jl-1' });
  });

  it('restricts the who-can-approve condition to the approver’s own attributes', async () => {
    // The filter matches a PERSON, so an amount would be comparing a person to money.
    const user = userEvent.setup();
    show(ApproverField, {
      formData: {
        kind: 'filter',
        minJobLevelId: null,
        match: { all: [{ field: 'departmentId', op: 'eq', value: 'dept-1' }] },
      } as ApproverSpec,
    });
    await user.click(screen.getByTitle('Change field'));
    expect(await screen.findByRole('button', { name: 'Job level' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Amount' })).not.toBeInTheDocument();
  });
});

// ── The switch cases field ────────────────────────────────────────────────────

describe('the switch cases field', () => {
  const twoCases = [
    { id: 'case-1', label: 'Small', predicate: { field: 'amount', op: 'lt', value: 100 } },
    { id: 'case-2', label: 'Large', predicate: { field: 'amount', op: 'gte', value: 100 } },
  ] as never;

  it('starts empty, with a way to add the first case', () => {
    show(CasesField, { formData: undefined });
    expect(screen.getByRole('button', { name: /Case/ })).toBeInTheDocument();
  });

  it('mints a stable routing id, continuing past the highest one used', async () => {
    /**
     * The graph's edges point at these ids. Numbering from the LENGTH would reuse
     * `case-2` after a removal and silently re-route the branch that pointed at the old
     * one.
     */
    const user = userEvent.setup();
    const { onChange } = show(CasesField, {
      formData: [{ id: 'case-7', predicate: { field: 'amount', op: 'gte', value: 0 } }] as never,
    });
    await user.click(screen.getByRole('button', { name: /^Case$/ }));
    expect((lastCall(onChange) as { id: string }[])[1].id).toBe('case-8');
  });

  it('ignores an id that is not one of ours when numbering', async () => {
    // A hand-authored graph may carry any id; the counter must not crash on it.
    const user = userEvent.setup();
    const { onChange } = show(CasesField, {
      formData: [{ id: 'legacy', predicate: { field: 'amount', op: 'gte', value: 0 } }] as never,
    });
    await user.click(screen.getByRole('button', { name: /^Case$/ }));
    expect((lastCall(onChange) as { id: string }[])[1].id).toBe('case-1');
  });

  it('gives a new case a real condition, not an empty one', async () => {
    // An empty predicate fails validation on save; this one is obviously unfinished.
    const user = userEvent.setup();
    const { onChange } = show(CasesField, { formData: [] as never });
    await user.click(screen.getByRole('button', { name: /^Case$/ }));
    expect((lastCall(onChange) as { predicate: unknown }[])[0].predicate).toEqual({
      field: 'amount',
      op: 'gte',
      value: 0,
    });
  });

  it('labels each case, falling back to its position while unnamed', () => {
    show(CasesField, {
      formData: [{ id: 'case-1', predicate: { field: 'amount', op: 'gte', value: 0 } }] as never,
    });
    expect(screen.getByPlaceholderText('Case 1')).toBeInTheDocument();
  });

  it('renames a case', async () => {
    const user = userEvent.setup();
    const { onChange } = show(CasesField, { formData: twoCases });
    await user.type(screen.getByDisplayValue('Small'), '!');
    expect((lastCall(onChange) as { label?: string }[])[0].label).toBe('Small!');
  });

  it('drops a cleared label rather than storing an empty string', async () => {
    // The node body falls back to "Case N" on `undefined`, not on ''.
    const user = userEvent.setup();
    const { onChange } = show(CasesField, { formData: twoCases });
    await user.clear(screen.getByDisplayValue('Small'));
    expect((lastCall(onChange) as { label?: string }[])[0].label).toBeUndefined();
  });

  it('removes the case that was asked for, leaving the others’ ids alone', async () => {
    const user = userEvent.setup();
    const { onChange } = show(CasesField, { formData: twoCases });
    await user.click(screen.getAllByRole('button', { name: 'Remove case' })[0]);
    expect(lastCall(onChange)).toEqual([
      { id: 'case-2', label: 'Large', predicate: { field: 'amount', op: 'gte', value: 100 } },
    ]);
  });

  it('edits one case’s condition without touching another’s', async () => {
    /**
     * Cases are evaluated in order and each routes somewhere different; bleeding one
     * condition into another re-routes traffic silently.
     */
    const user = userEvent.setup();
    const { onChange } = show(CasesField, { formData: twoCases });
    await user.click(screen.getAllByRole('button', { name: /Add/ })[0]);
    const next = lastCall(onChange) as { id: string; predicate: { all?: unknown[] } }[];
    expect(next[0].predicate.all).toHaveLength(2);
    expect(next[1].predicate).toEqual({ field: 'amount', op: 'gte', value: 100 });
  });

  it('refuses Always inside a case, because a case that always matches ends the switch', async () => {
    const user = userEvent.setup();
    const { onChange } = show(CasesField, { formData: twoCases });
    await user.click(
      screen.getAllByRole('button', { name: /(?:Remove condition|filters\.removeCondition)/ })[0],
    );
    expect((lastCall(onChange) as { predicate: unknown }[])[0].predicate).toEqual({ all: [] });
  });
});
