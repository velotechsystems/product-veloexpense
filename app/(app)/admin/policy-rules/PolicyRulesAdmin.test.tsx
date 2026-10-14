import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';

/**
 * /admin/policy-rules — the policy-engine v2 Rule Builder.
 *
 * Rules are authored as DATA, so every mistake this page allows ships without a deploy
 * and without a review. The suite is built around the four ways a rule goes wrong here:
 *
 *   · **Money is typed in MAJOR units and stored in MINOR.** Reverse it and the rule
 *     still saves, still validates, and fires at a hundredth of the intended figure —
 *     an admin typing 1000 for "a thousand dollars" would get a rule that trips at ten.
 *     Both directions of that conversion are pinned.
 *   · **A rule missing its threshold is INERT, not invalid.** It saves happily and then
 *     never fires, which is indistinguishable from a policy nobody breaks. Save is
 *     refused instead.
 *   · **Changing the kind changes the schema.** Params carried over from the previous
 *     kind post fields the new one rejects, and a condition left behind on an AGGREGATE
 *     kind is silently ignored. Both are dropped.
 *   · **A condition's value is TEXT in the editor and typed on the wire.** `in` splits
 *     on commas, comparisons coerce to number, and `eq` against digits means the number
 *     — get that wrong and the predicate never matches.
 */

const h = vi.hoisted(() => ({
  trpc: undefined as unknown,
  topBar: {} as Record<string, ReactNode>,
}));

/** One stable `t` per namespace — the column and label memos list it as a dep. */
const translators = new Map<string, (k: string, v?: Record<string, unknown>) => string>();

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => {
    const key = ns ?? '';
    let t = translators.get(key);
    if (!t) {
      const fn = (k: string, values?: Record<string, unknown>) => {
        const full = ns ? `${ns}.${k}` : k;
        return values ? `${full}:${Object.values(values).join(',')}` : full;
      };
      (fn as { has?: () => boolean }).has = () => false;
      t = fn;
      translators.set(key, t);
    }
    return t;
  },
}));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
// VeloExpense: the shell lives at app/(app) (no [locale] segment).
vi.mock('@/app/(app)/TopBar', () => ({
  setTopBarSlot: (slot: string, node: ReactNode) => {
    h.topBar[slot] = node;
  },
  useTopBarSlots: () => undefined,
}));
/**
 * The Combobox becomes a native select. Base UI's popup has its own suite in the design
 * system; driving it here would test that library instead of the conversion rules that
 * are the whole risk on this page.
 */
vi.mock('@expenseos/design-system', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@expenseos/design-system')>()),
  Combobox: ({
    id,
    items,
    value,
    onValueChange,
    placeholder,
  }: {
    id?: string;
    items: { value: string; label: string }[];
    value: string | null;
    onValueChange: (v: string | null) => void;
    placeholder?: string;
  }) => (
    <select
      id={id}
      aria-label={placeholder ?? id}
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
}));

import { PolicyRulesAdmin } from './PolicyRulesAdmin';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A LINE kind that takes a condition and no params. */
const AMOUNT = {
  code: 'AMOUNT_LIMIT',
  scope: 'LINE' as const,
  defaultSeverity: 'BLOCK',
  messageKey: 'policy.amountLimit',
  requiresCondition: true,
  paramsSpec: [],
  paramsAtLeastOneOf: [],
};
/** An AGGREGATE kind: its own built-in check, one required money param, no condition. */
const PER_DIEM = {
  code: 'PER_DIEM_CAP',
  scope: 'LINE' as const,
  defaultSeverity: 'WARNING',
  messageKey: 'policy.perDiem',
  requiresCondition: false,
  paramsSpec: [{ name: 'capMinor', kind: 'moneyMinor' as const, required: true }],
  paramsAtLeastOneOf: [],
};
/** A REPORT kind with an at-least-one-of group and a boolean defaulting ON. */
const AUDIT = {
  code: 'AUDIT_THRESHOLD',
  scope: 'REPORT' as const,
  defaultSeverity: 'INFO',
  messageKey: 'policy.audit',
  requiresCondition: false,
  paramsSpec: [
    { name: 'amountMinor', kind: 'moneyMinor' as const },
    { name: 'lineCount', kind: 'number' as const },
    { name: 'includeReceipts', kind: 'boolean' as const, default: true },
  ],
  paramsAtLeastOneOf: ['amountMinor', 'lineCount'],
};
/** A REPORT kind that DOES take a condition — proves the field list follows the scope. */
const REPORT_RULE = {
  code: 'REPORT_TOTAL',
  scope: 'REPORT' as const,
  defaultSeverity: 'WARNING',
  messageKey: 'policy.reportTotal',
  requiresCondition: true,
  paramsSpec: [],
  paramsAtLeastOneOf: [],
};

/**
 * A TRAVEL_REQUEST kind with the two param controls this UI gained: a closed enum and a
 * lookup-id SET.
 *
 * They exist because the alternative was `SPEC_EXEMPT` — the "API-authored only" hole
 * `REQUIRES_APPROVED_TRAVEL` sits in — which would have made "business class needs VP+"
 * a rule an admin can create and never configure.
 */
const CABIN = {
  code: 'TRAVEL_CABIN_CLASS',
  scope: 'TRAVEL_REQUEST' as const,
  defaultSeverity: 'BLOCK',
  messageKey: 'travelCabinClass',
  requiresCondition: false,
  paramsSpec: [
    {
      name: 'cabin',
      kind: 'enum' as const,
      options: ['PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'],
      required: true,
    },
    {
      name: 'allowedJobLevelIds',
      kind: 'lookupIds' as const,
      entity: 'jobLevel' as const,
      required: false,
    },
  ],
  paramsAtLeastOneOf: [],
};

const REGISTRY = {
  policyCurrency: 'CAD',
  kinds: [AMOUNT, PER_DIEM, AUDIT, REPORT_RULE, CABIN],
  lineFields: ['amount', 'categoryCode'],
  reportFields: ['total', 'lineCount'],
  ops: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin'],
};

const SCOPE_OPTIONS = {
  categories: [{ id: 'cat-1', label: { en: 'Meals' } }],
  jobLevels: [{ id: 'jl-1', code: 'L3', label: { en: 'Senior' } }],
  legalEntities: [{ id: 'le-1', label: { en: 'Carmigo Canada' } }],
  businessUnits: [{ id: 'bu-1', label: { en: 'Retail' } }],
  departments: [{ id: 'dept-1', label: { en: 'Finance' } }],
  roles: [{ id: 'role-1', label: { en: 'Approver' } }],
};

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  kindCode: 'AMOUNT_LIMIT',
  scope: 'LINE',
  severity: 'BLOCK',
  condition: { all: [{ field: 'amount', op: 'gt', value: 500 }] },
  params: {},
  messageKey: 'policy.amountLimit',
  enabled: true,
  categoryId: null,
  jobLevelId: null,
  legalEntityId: null,
  businessUnitId: null,
  departmentId: null,
  roleId: null,
  // Midday, so the local-time formatting in the validity column cannot shift the
  // date across a day boundary and make the assertions timezone-dependent.
  effectiveFrom: '2026-01-01T12:00:00.000Z',
  effectiveTo: null,
  ...over,
});

function setTrpc(rules: unknown[] = [rule()], over: TrpcMockConfig = {}) {
  h.trpc = createTrpcMock({
    ...over,
    queries: {
      'policies.policyRule.list': { data: rules },
      'policies.policyRule.kinds': { data: REGISTRY },
      'policies.policyRule.scopeOptions': { data: SCOPE_OPTIONS },
      ...over.queries,
    },
  });
}

const show = (canManage = true) => render(<PolicyRulesAdmin canManage={canManage} />);
/** The Add button lives in the app's top bar, which this page pushes a node into. */
const showTopBar = () => render(<div>{h.topBar.right}</div>);

const rowTexts = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '')
    .filter((s) => s.length > 0);

const sel = (label: RegExp | string) => screen.getByLabelText(label) as HTMLSelectElement;

/** Open the create drawer on a chosen kind, which is the start of nearly every flow. */
async function openNew(user: ReturnType<typeof userEvent.setup>, kindCode: string) {
  showTopBar();
  await user.click(screen.getByRole('button', { name: /policyRules\.add/ }));
  await user.selectOptions(await screen.findByLabelText(/policyRules\.field\.kind/), kindCode);
}

const saveButton = () => screen.getByRole('button', { name: 'policyRules.save' });

beforeEach(() => {
  h.topBar = {};
});
afterEach(() => {
  h.trpc = undefined;
  vi.restoreAllMocks();
});

// ── The table ─────────────────────────────────────────────────────────────────

describe('the rule list', () => {
  it('reads a rule out as kind, scope, severity and window', () => {
    setTrpc();
    show();
    expect(screen.getByText('AMOUNT_LIMIT')).toBeInTheDocument();
    expect(screen.getByText('policyRules.scope.LINE')).toBeInTheDocument();
    expect(screen.getByText('policyRules.severity.BLOCK')).toBeInTheDocument();
  });

  it('summarises an all-condition with a conjunction separator', () => {
    setTrpc([
      rule({
        condition: {
          all: [
            { field: 'amount', op: 'gt', value: 500 },
            { field: 'categoryCode', op: 'eq', value: 'MEALS' },
          ],
        },
      }),
    ]);
    show();
    expect(
      screen.getByText('amount policyRules.op.gt 500 · categoryCode policyRules.op.eq MEALS'),
    ).toBeInTheDocument();
  });

  it('summarises an any-condition with a disjunction separator', () => {
    // The separator IS the semantics — the same two clauses mean different things.
    setTrpc([
      rule({
        condition: {
          any: [
            { field: 'amount', op: 'gt', value: 500 },
            { field: 'categoryCode', op: 'eq', value: 'MEALS' },
          ],
        },
      }),
    ]);
    show();
    expect(
      screen.getByText('amount policyRules.op.gt 500 | categoryCode policyRules.op.eq MEALS'),
    ).toBeInTheDocument();
  });

  it('reads a bare leaf condition as a single clause', () => {
    setTrpc([rule({ condition: { field: 'amount', op: 'gte', value: 100 } })]);
    show();
    expect(screen.getByText('amount policyRules.op.gte 100')).toBeInTheDocument();
  });

  it('renders a list value back as the comma text it was typed as', () => {
    setTrpc([
      rule({ condition: { all: [{ field: 'categoryCode', op: 'in', value: ['A', 'B'] }] } }),
    ]);
    show();
    expect(screen.getByText('categoryCode policyRules.op.in A, B')).toBeInTheDocument();
  });

  it('dashes a condition-free kind rather than leaving the cell blank', () => {
    setTrpc([rule({ kindCode: 'PER_DIEM_CAP', condition: null })]);
    show();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('says a rule with no end date is ongoing', () => {
    setTrpc();
    show();
    expect(screen.getByText(/policyRules\.ongoing/)).toBeInTheDocument();
  });

  it('shows both ends of a closed window', () => {
    setTrpc([rule({ effectiveTo: '2026-12-31T12:00:00.000Z' })]);
    show();
    expect(screen.queryByText(/policyRules\.ongoing/)).not.toBeInTheDocument();
    expect(rowTexts()[0]).toContain('Jan 1, 2026 – Dec 31, 2026');
  });

  it('resolves a scoped category to its label, and an unscoped rule to “all”', () => {
    setTrpc([rule({ categoryId: 'cat-1' }), rule({ id: 'r2' })]);
    show();
    expect(screen.getByText('Meals')).toBeInTheDocument();
    expect(screen.getByText('policyRules.scope.all')).toBeInTheDocument();
  });

  it('marks a disabled rule', () => {
    setTrpc([rule({ enabled: false })]);
    show();
    expect(screen.getByText('policyRules.status.disabled')).toBeInTheDocument();
  });

  it('says so when there are no rules at all', () => {
    setTrpc([]);
    show();
    expect(screen.getByText('policyRules.emptyTitle')).toBeInTheDocument();
    expect(screen.getByText('policyRules.emptyBody')).toBeInTheDocument();
  });

  it('narrows by kind', async () => {
    const user = userEvent.setup();
    setTrpc([rule(), rule({ id: 'r2', kindCode: 'PER_DIEM_CAP', condition: null })]);
    show();
    const header = screen.getByText('policyRules.col.kind').closest('th') as HTMLElement;
    const buttons = within(header).getAllByRole('button', { name: 'table.colMenu.menu' });
    await user.click(buttons[buttons.length - 1]);
    await user.click(await screen.findByText('table.colMenu.filter'));
    await user.type(await screen.findByPlaceholderText('table.colMenu.value'), 'per_diem');
    await user.click(screen.getByText('table.colMenu.apply'));
    expect(rowTexts()).toHaveLength(1);
    expect(screen.getByText('PER_DIEM_CAP')).toBeInTheDocument();
  });
});

// ── Who may author ────────────────────────────────────────────────────────────

describe('authoring permission', () => {
  it('offers no Add button to a reader', () => {
    setTrpc();
    show(false);
    showTopBar();
    expect(screen.queryByRole('button', { name: /policyRules\.add/ })).not.toBeInTheDocument();
  });

  it('offers no row menu to a reader', () => {
    setTrpc();
    show(false);
    expect(screen.queryByRole('button', { name: 'policyRules.actions' })).not.toBeInTheDocument();
  });

  it('does not open the editor on a row click for a reader', async () => {
    const user = userEvent.setup();
    setTrpc();
    show(false);
    await user.click(screen.getByText('AMOUNT_LIMIT'));
    expect(screen.queryByText('policyRules.edit')).not.toBeInTheDocument();
  });

  it('opens the editor on a row click for an author', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await user.click(screen.getByText('AMOUNT_LIMIT'));
    expect(await screen.findByText('policyRules.edit')).toBeInTheDocument();
  });

  it('deletes from the row menu', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([rule()], { mutations: { 'policies.policyRule.delete': { onCall } } });
    show();
    await user.click(screen.getByRole('button', { name: 'policyRules.actions' }));
    await user.click(await screen.findByText('policyRules.delete'));
    expect(onCall).toHaveBeenCalledWith({ id: 'r1' });
  });
});

// ── Choosing a kind ───────────────────────────────────────────────────────────

describe('choosing a kind', () => {
  it('adopts the kind’s default severity and message key', async () => {
    /**
     * Every kind has a severity the engine was designed around; making the admin pick
     * one from scratch is how a BLOCK rule ends up filed as INFO.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    expect(sel(/policyRules\.field\.severity/).value).toBe('BLOCK');
    expect(
      (screen.getByLabelText(/policyRules\.field\.messageKey/) as HTMLInputElement).value,
    ).toBe('policy.amountLimit');
  });

  it('keeps a message key the admin already typed', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    showTopBar();
    await user.click(screen.getByRole('button', { name: /policyRules\.add/ }));
    const msg = await screen.findByLabelText(/policyRules\.field\.messageKey/);
    await user.type(msg, 'policy.custom');
    await user.selectOptions(screen.getByLabelText(/policyRules\.field\.kind/), 'AMOUNT_LIMIT');
    expect((msg as HTMLInputElement).value).toBe('policy.custom');
  });

  it('offers a condition editor for a kind that takes one', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    expect(screen.getByText('policyRules.conditionTitle')).toBeInTheDocument();
    expect(screen.queryByText('policyRules.kindNoCondition')).not.toBeInTheDocument();
  });

  it('says an aggregate kind runs its own check instead', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'PER_DIEM_CAP');
    expect(screen.getByText('policyRules.kindNoCondition')).toBeInTheDocument();
    expect(screen.queryByText('policyRules.conditionTitle')).not.toBeInTheDocument();
  });

  it('offers LINE facts for a line kind and REPORT facts for a report kind', async () => {
    /**
     * A condition over a fact the scope does not carry never matches. The field list is
     * the only thing stopping an admin from writing one.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    await user.click(screen.getByRole('button', { name: /policyRules\.addClause/ }));
    expect(within(screen.getByRole('dialog')).getByText('amount')).toBeInTheDocument();

    cleanup();
    h.topBar = {};
    setTrpc();
    show();
    await openNew(user, 'REPORT_TOTAL');
    await user.click(screen.getByRole('button', { name: /policyRules\.addClause/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('total')).toBeInTheDocument();
    expect(within(dialog).queryByText('categoryCode')).not.toBeInTheDocument();
  });

  it('drops a condition when the new kind cannot use one', async () => {
    /**
     * A condition left behind on an aggregate kind is silently ignored by the engine,
     * so the rule reads as conditional in the table and is not.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    await user.click(screen.getByRole('button', { name: /policyRules\.addClause/ }));
    await user.type(screen.getByPlaceholderText('policyRules.valuePlaceholder'), '500');
    await user.selectOptions(sel(/policyRules\.field\.kind/), 'PER_DIEM_CAP');
    expect(screen.queryByPlaceholderText('policyRules.valuePlaceholder')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/policyRules\.params\.capMinor/), '75');
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { condition: unknown }).condition).toBeNull();
  });

  it('drops params belonging to the previous kind', async () => {
    // Carrying them over posts fields the new schema rejects.
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'PER_DIEM_CAP');
    await user.type(screen.getByLabelText(/policyRules\.params\.capMinor/), '75');
    await user.selectOptions(sel(/policyRules\.field\.kind/), 'AUDIT_THRESHOLD');
    expect(screen.queryByLabelText(/policyRules\.params\.capMinor/)).not.toBeInTheDocument();
    expect(
      (screen.getByLabelText(/policyRules\.params\.amountMinor/) as HTMLInputElement).value,
    ).toBe('');
  });
});

// ── Params, and the money trap ────────────────────────────────────────────────

describe('rule params', () => {
  it('names the currency on a money field', async () => {
    /**
     * The value is stored in minor units; an unlabelled box invites typing 1000 for a
     * thousand dollars and getting a rule that fires at ten.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'PER_DIEM_CAP');
    expect(screen.getByText(/policyRules\.params\.capMinor \(CAD\)/)).toBeInTheDocument();
  });

  it('stores a money param in minor units', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'PER_DIEM_CAP');
    await user.type(screen.getByLabelText(/policyRules\.params\.capMinor/), '1000');
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { params: Record<string, unknown> }).params).toEqual({
      capMinor: '100000',
    });
  });

  it('shows a stored money param back in major units', async () => {
    // The other half of the same conversion — an edit that re-saves must not shift it.
    const user = userEvent.setup();
    setTrpc([rule({ kindCode: 'PER_DIEM_CAP', condition: null, params: { capMinor: '250000' } })]);
    show();
    await user.click(screen.getByText('PER_DIEM_CAP'));
    const input = (await screen.findByLabelText(
      /policyRules\.params\.capMinor/,
    )) as HTMLInputElement;
    expect(Number(input.value)).toBe(2500);
  });

  it('refuses to save a rule missing its required threshold, and says so', async () => {
    /**
     * The refusal was already right; the SILENCE was the defect. Clearing a required
     * threshold left the button dead with no inline error, no toast, and a drawer that
     * never closed — which reads as a control that has stopped working rather than as a
     * form that is not finished (GA readiness report F25).
     *
     * It would otherwise save, validate, and then never fire.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'PER_DIEM_CAP');
    expect(saveButton()).toBeDisabled();
    // The reason is on screen, naming what is still needed.
    expect(screen.getByText(/policyRules\.blocked/)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/policyRules\.params\.capMinor/), '75');
    expect(saveButton()).toBeEnabled();
    // …and it goes away once there is nothing left to say.
    expect(screen.queryByText(/policyRules\.blocked/)).not.toBeInTheDocument();
  });

  it('refuses to save until an at-least-one-of group is satisfied', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'AUDIT_THRESHOLD');
    expect(screen.getByText('policyRules.params.atLeastOne')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    await user.type(screen.getByLabelText(/policyRules\.params\.lineCount/), '20');
    expect(saveButton()).toBeEnabled();
  });

  it('starts a boolean param at the kind’s documented default, not false', async () => {
    // AUDIT_THRESHOLD reads a missing switch as ON; showing it off would misreport it.
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'AUDIT_THRESHOLD');
    expect(screen.getByLabelText('policyRules.params.includeReceipts')).toBeChecked();
  });

  it('sends a cleared boolean as false, and a blank number as absent', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'AUDIT_THRESHOLD');
    await user.type(screen.getByLabelText(/policyRules\.params\.lineCount/), '20');
    await user.click(screen.getByLabelText('policyRules.params.includeReceipts'));
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { params: Record<string, unknown> }).params).toEqual({
      lineCount: 20,
      includeReceipts: false,
    });
  });
});

// ── The condition editor ──────────────────────────────────────────────────────

describe('the condition editor', () => {
  it('refuses to save a conditional kind with no clauses', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    expect(saveButton()).toBeDisabled();
  });

  it('refuses to save a clause with no value', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    await user.click(screen.getByRole('button', { name: /policyRules\.addClause/ }));
    expect(saveButton()).toBeDisabled();
    await user.type(screen.getByPlaceholderText('policyRules.valuePlaceholder'), '500');
    expect(saveButton()).toBeEnabled();
  });

  it('coerces a comparison value to a number', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    await user.click(screen.getByRole('button', { name: /policyRules\.addClause/ }));
    const row = screen.getByPlaceholderText('policyRules.valuePlaceholder').closest('div')
      ?.parentElement as HTMLElement;
    await user.selectOptions(within(row).getAllByRole('combobox')[1], 'gt');
    await user.type(screen.getByPlaceholderText('policyRules.valuePlaceholder'), '500');
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { condition: unknown }).condition).toEqual({
      all: [{ field: 'amount', op: 'gt', value: 500 }],
    });
  });

  it('splits a set operator’s value on commas', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    await user.click(screen.getByRole('button', { name: /policyRules\.addClause/ }));
    const row = screen.getByPlaceholderText('policyRules.valuePlaceholder').closest('div')
      ?.parentElement as HTMLElement;
    await user.selectOptions(within(row).getAllByRole('combobox')[0], 'categoryCode');
    await user.selectOptions(within(row).getAllByRole('combobox')[1], 'in');
    await user.type(
      screen.getByPlaceholderText('policyRules.valuePlaceholder'),
      'MEALS, TRAVEL , ',
    );
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { condition: unknown }).condition).toEqual({
      all: [{ field: 'categoryCode', op: 'in', value: ['MEALS', 'TRAVEL'] }],
    });
  });

  it('keeps a non-numeric equality value as text', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    await user.click(screen.getByRole('button', { name: /policyRules\.addClause/ }));
    await user.type(screen.getByPlaceholderText('policyRules.valuePlaceholder'), 'MEALS');
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { condition: unknown }).condition).toEqual({
      all: [{ field: 'amount', op: 'eq', value: 'MEALS' }],
    });
  });

  it('reads a digit string on an equality as the number', async () => {
    // Strict-equality semantics: '500' would never match the numeric fact 500.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    await user.click(screen.getByRole('button', { name: /policyRules\.addClause/ }));
    await user.type(screen.getByPlaceholderText('policyRules.valuePlaceholder'), '500');
    await user.click(saveButton());
    expect(
      (onCall.mock.calls[0]?.[0] as { condition: { all: unknown[] } }).condition.all[0],
    ).toEqual({ field: 'amount', op: 'eq', value: 500 });
  });

  it('saves the chosen match mode', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    await user.click(screen.getByRole('button', { name: /policyRules\.addClause/ }));
    await user.type(screen.getByPlaceholderText('policyRules.valuePlaceholder'), '500');
    await user.selectOptions(screen.getByRole('combobox', { name: 'pr-match' }), 'any');
    await user.click(saveButton());
    expect(
      (onCall.mock.calls[0]?.[0] as { condition: Record<string, unknown> }).condition,
    ).toHaveProperty('any');
  });

  it('adds and removes clauses', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    const add = screen.getByRole('button', { name: /policyRules\.addClause/ });
    await user.click(add);
    await user.click(add);
    expect(screen.getAllByPlaceholderText('policyRules.valuePlaceholder')).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: 'policyRules.removeClause' })[0]);
    expect(screen.getAllByPlaceholderText('policyRules.valuePlaceholder')).toHaveLength(1);
  });

  it('loads a stored condition back into the editor', async () => {
    const user = userEvent.setup();
    setTrpc([
      rule({
        condition: {
          any: [
            { field: 'amount', op: 'gt', value: 500 },
            { field: 'categoryCode', op: 'in', value: ['A', 'B'] },
          ],
        },
      }),
    ]);
    show();
    await user.click(screen.getByText('AMOUNT_LIMIT'));
    const values = (await screen.findAllByPlaceholderText(
      'policyRules.valuePlaceholder',
    )) as HTMLInputElement[];
    expect(values.map((v) => v.value)).toEqual(['500', 'A, B']);
    expect((screen.getByRole('combobox', { name: 'pr-match' }) as HTMLSelectElement).value).toBe(
      'any',
    );
  });
});

// ── Saving ────────────────────────────────────────────────────────────────────

describe('saving', () => {
  it('creates a rule with its window and scope', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'PER_DIEM_CAP');
    await user.type(screen.getByLabelText(/policyRules\.params\.capMinor/), '75');
    fireEvent.change(screen.getByLabelText(/policyRules\.field\.effectiveFrom/), {
      target: { value: '2026-03-01' },
    });
    fireEvent.change(screen.getByLabelText(/policyRules\.field\.effectiveTo/), {
      target: { value: '2026-06-30' },
    });
    await user.selectOptions(sel(/policyRules\.field\.category/), 'cat-1');
    await user.selectOptions(sel(/policyRules\.field\.jobLevel/), 'jl-1');
    await user.click(saveButton());
    const patch = onCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.kindCode).toBe('PER_DIEM_CAP');
    expect(patch.categoryId).toBe('cat-1');
    expect(patch.jobLevelId).toBe('jl-1');
    expect((patch.effectiveFrom as Date).toISOString()).toContain('2026-03-01');
    expect((patch.effectiveTo as Date).toISOString()).toContain('2026-06-30');
  });

  it('sends no end date as null rather than an invalid one', async () => {
    // `new Date('')` is Invalid Date, and an invalid timestamp reaching Prisma throws.
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'PER_DIEM_CAP');
    await user.type(screen.getByLabelText(/policyRules\.params\.capMinor/), '75');
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { effectiveTo: unknown }).effectiveTo).toBeNull();
  });

  it('trims the message key', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'PER_DIEM_CAP');
    await user.type(screen.getByLabelText(/policyRules\.params\.capMinor/), '75');
    const msg = screen.getByLabelText(/policyRules\.field\.messageKey/);
    await user.clear(msg);
    await user.type(msg, '  policy.perDiem  ');
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { messageKey: string }).messageKey).toBe('policy.perDiem');
  });

  it('updates an existing rule by id, not by creating a second one', async () => {
    const updated = vi.fn();
    const created = vi.fn();
    const user = userEvent.setup();
    setTrpc([rule()], {
      mutations: {
        'policies.policyRule.update': { onCall: updated },
        'policies.policyRule.create': { onCall: created },
      },
    });
    show();
    await user.click(screen.getByText('AMOUNT_LIMIT'));
    await user.click(await screen.findByRole('button', { name: 'policyRules.save' }));
    expect(created).not.toHaveBeenCalled();
    expect(updated.mock.calls[0]?.[0]).toMatchObject({ id: 'r1' });
  });

  it('carries the enabled flag', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'PER_DIEM_CAP');
    await user.type(screen.getByLabelText(/policyRules\.params\.capMinor/), '75');
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { enabled: boolean }).enabled).toBe(true);
  });

  it('reports itself busy while a save is in flight', async () => {
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { isPending: true } } });
    show();
    await openNew(user, 'PER_DIEM_CAP');
    await user.type(screen.getByLabelText(/policyRules\.params\.capMinor/), '75');
    expect(screen.getByRole('button', { name: 'policyRules.saving' })).toBeDisabled();
  });

  it('closes without saving on cancel', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'PER_DIEM_CAP');
    await user.click(screen.getByRole('button', { name: 'policyRules.cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onCall).not.toHaveBeenCalled();
  });
});

// ── Before the scope options arrive ───────────────────────────────────────────

describe('the moment before the scoping options load', () => {
  /**
   * The rules, the kind registry and the scope options are three queries, and the last
   * reads six lookup tables. So there is a real window where the editor is open and
   * nothing is known about the categories, entities, units, departments, levels or roles
   * a rule can be narrowed to — and every picker in the Scope section resolves through
   * that missing data.
   *
   * A rule is scoped-to-everything by default, which is the widest a rule can be. The
   * editor opening with empty pickers is therefore correct: an author can still write
   * the rule and narrow it a moment later. Refusing to open, or crashing, would leave
   * them unable to write it at all.
   */
  const withoutOptions = () => {
    h.trpc = createTrpcMock({
      queries: {
        'policies.policyRule.list': { data: [rule()] },
        'policies.policyRule.kinds': { data: REGISTRY },
        'policies.policyRule.scopeOptions': { isLoading: true, data: undefined },
      },
    });
  };

  it('still lists the rules', () => {
    withoutOptions();
    show();
    expect(rowTexts()).toHaveLength(1);
  });

  it('says a scoped rule applies to everyone rather than printing an id', () => {
    /** `cat-1` in the Scope column looks like data; "all" is at least true of the rule
     *  until the labels arrive. */
    h.trpc = createTrpcMock({
      queries: {
        'policies.policyRule.list': { data: [rule({ categoryId: 'cat-1' })] },
        'policies.policyRule.kinds': { data: REGISTRY },
        'policies.policyRule.scopeOptions': { isLoading: true, data: undefined },
      },
    });
    show();
    expect(screen.queryByText('cat-1')).not.toBeInTheDocument();
  });

  it('opens the editor with empty scope pickers instead of refusing to open', async () => {
    const user = userEvent.setup();
    withoutOptions();
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    expect(sel(/policyRules\.field\.kind/)).toBeInTheDocument();
    // Each scope picker exists and offers only its "any" placeholder.
    expect(sel(/policyRules\.field\.category/).options).toHaveLength(1);
  });
});

// ── Choosing a kind, at the edges ─────────────────────────────────────────────

describe('clearing the kind', () => {
  it('keeps the severity that was already chosen rather than blanking it', async () => {
    /**
     * The kind picker has an empty option, and `onKindChange` looks the code up in the
     * registry — a miss. Falling back to the CURRENT severity rather than to a default
     * keeps a deliberate choice on screen; resetting it would quietly downgrade a BLOCK
     * to a WARNING because somebody re-opened the dropdown.
     */
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    expect(sel(/policyRules\.field\.severity/).value).toBe('BLOCK');
    await user.selectOptions(sel(/policyRules\.field\.kind/), '');
    expect(sel(/policyRules\.field\.severity/).value).toBe('BLOCK');
  });

  it('will not save without one', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'AMOUNT_LIMIT');
    await user.selectOptions(sel(/policyRules\.field\.kind/), '');
    expect(saveButton()).toBeDisabled();
  });
});

// ── The travel cabin rule's two controls ──────────────────────────────────────

/** The mocked `Combobox` renders a native `<select>` labelled by its id. */
const cabinSelect = () => screen.getByLabelText('pr-param-cabin') as HTMLSelectElement;
/** The multi-select is the REAL component; `id` lands on its popover trigger. */
const jobLevelTrigger = () => screen.getByLabelText('policyRules.params.allowedJobLevelIds');
const jobLevelTriggerAsync = () => screen.findByLabelText('policyRules.params.allowedJobLevelIds');
/**
 * The job level inside the multi-select's popover.
 *
 * Two elements carry `role="option"` with this name: the popover's item, and a native
 * `<option>` in the mocked scoping Combobox — which offers the SAME job levels, because
 * the multi-select deliberately reuses that one query rather than adding a second that
 * could disagree with it. Excluding `<option>` is what tells the two apart.
 */
const jobLevelItem = async () => {
  const all = await screen.findAllByRole('option', { name: /L3/ });
  const item = all.find((el) => el.tagName !== 'OPTION');
  if (!item) throw new Error('the multi-select popover offered no L3 item');
  return item;
};

describe('enum and lookup-id params', () => {
  it('offers the cabin as a labelled picker, never the raw enum', async () => {
    // An admin picks "Business", not "BUSINESS".
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'TRAVEL_CABIN_CLASS');
    expect(
      within(cabinSelect()).getByText('policyRules.params.option.cabin.BUSINESS'),
    ).toBeInTheDocument();
  });

  it('does not offer ECONOMY, because restricting it would forbid travel', async () => {
    const user = userEvent.setup();
    setTrpc();
    show();
    await openNew(user, 'TRAVEL_CABIN_CLASS');
    expect(
      within(cabinSelect()).queryByText('policyRules.params.option.cabin.ECONOMY'),
    ).not.toBeInTheDocument();
  });

  it('refuses to save without a cabin, and saves the literal once chosen', async () => {
    /**
     * The literal matters: the generic text path runs `Number(text)` on a param, which
     * would turn a cabin name into NaN and drop it — the rule would save and do nothing.
     */
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'TRAVEL_CABIN_CLASS');
    expect(saveButton()).toBeDisabled();
    await user.selectOptions(cabinSelect(), 'BUSINESS');
    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { params: Record<string, unknown> }).params).toEqual({
      cabin: 'BUSINESS',
      // SENT even though empty. "Nobody may book this cabin" is `[]`, a real
      // configuration — omitting it would mean the same thing only by coincidence.
      allowedJobLevelIds: [],
    });
  });

  it('offers the job levels as a multi-select, and saves the chosen ids', async () => {
    const onCall = vi.fn();
    const user = userEvent.setup();
    setTrpc([], { mutations: { 'policies.policyRule.create': { onCall } } });
    show();
    await openNew(user, 'TRAVEL_CABIN_CLASS');
    await user.selectOptions(cabinSelect(), 'FIRST');

    // The scoping combobox already loads job levels; the multi-select reuses that list
    // rather than a second query that could disagree with it — which is also why the
    // click has to be scoped to the popover: the SAME label is sitting in the scoping
    // select's option list, and an unscoped `/L3/` matches both.
    await user.click(jobLevelTrigger());
    await user.click(await jobLevelItem());
    await user.click(saveButton());
    expect((onCall.mock.calls[0]?.[0] as { params: Record<string, unknown> }).params).toEqual({
      cabin: 'FIRST',
      allowedJobLevelIds: ['jl-1'],
    });
  });

  it('shows a stored id list back as selected', async () => {
    // The other half of the round trip — an edit that re-saves must not blank the list,
    // which would silently widen the policy to everyone.
    const user = userEvent.setup();
    setTrpc([
      rule({
        kindCode: 'TRAVEL_CABIN_CLASS',
        scope: 'TRAVEL_REQUEST',
        condition: null,
        params: { cabin: 'BUSINESS', allowedJobLevelIds: ['jl-1'] },
      }),
    ]);
    show();
    await user.click(screen.getByText('TRAVEL_CABIN_CLASS'));
    // Shown on the closed trigger, which is where an admin reads back what is set.
    expect(await jobLevelTriggerAsync()).toHaveTextContent(/L3/);
  });
});
