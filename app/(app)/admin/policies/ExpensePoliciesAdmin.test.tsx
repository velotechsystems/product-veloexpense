import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrpcMock, type TrpcMockConfig } from '@/test-utils/trpc';
import {
  dollarsToMinorString,
  ExpensePoliciesAdmin,
  minorStringToDollars,
  policyToForm,
} from './ExpensePoliciesAdmin';

const h = vi.hoisted(() => ({ trpc: undefined as unknown }));
vi.mock('@/lib/trpc/client', () => ({
  get trpc() {
    return h.trpc;
  },
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals && 'currency' in vals ? `${key}:${vals.currency}` : key,
  useLocale: () => 'en',
}));

// ── Pure money-boundary helpers ───────────────────────────────────────
describe('minorStringToDollars', () => {
  it('returns null for null/empty', () => {
    expect(minorStringToDollars(null)).toBeNull();
    expect(minorStringToDollars('')).toBeNull();
  });
  it('converts integer-cents strings to dollars', () => {
    expect(minorStringToDollars('0')).toBe(0);
    expect(minorStringToDollars('100')).toBe(1);
    expect(minorStringToDollars('12345')).toBe(123.45);
    expect(minorStringToDollars('99')).toBe(0.99);
  });
});

describe('dollarsToMinorString', () => {
  it('returns null for null/undefined/NaN', () => {
    expect(dollarsToMinorString(null, 'en')).toBeNull();
    expect(dollarsToMinorString(undefined, 'en')).toBeNull();
    expect(dollarsToMinorString(Number.NaN, 'en')).toBeNull();
  });
  it('converts dollars to integer-cents strings, rounding', () => {
    expect(dollarsToMinorString(0, 'en')).toBe('0');
    expect(dollarsToMinorString(1, 'en')).toBe('100');
    expect(dollarsToMinorString(123.45, 'en')).toBe('12345');
    expect(dollarsToMinorString(1.999, 'en')).toBe('200'); // rounds to nearest cent
  });
  it('round-trips with minorStringToDollars', () => {
    for (const cents of ['0', '100', '12345', '99']) {
      expect(dollarsToMinorString(minorStringToDollars(cents), 'en')).toBe(cents);
    }
  });

  it('takes a NUMBER, so the reader locale cannot change the saved limit', () => {
    // The form field is numeric; the locale argument is threaded for consistency
    // with the string-parsing path and must be inert here. If a future change
    // starts routing this through the locale parser, these two diverge.
    expect(dollarsToMinorString(123.45, 'fr-CA')).toBe(dollarsToMinorString(123.45, 'en'));
  });
});

describe('policyToForm', () => {
  it('returns the empty form for a null policy', () => {
    expect(policyToForm(null)).toEqual({
      receiptRequired: true,
      approvalRequired: true,
      perTransactionLimit: null,
      dailyLimit: null,
      monthlyLimit: null,
      annualLimit: null,
      notes: null,
    });
  });
  it('maps a populated policy, converting minor→dollars', () => {
    expect(
      policyToForm({
        categoryId: 'c1',
        receiptRequired: false,
        approvalRequired: true,
        perTransactionLimitMinor: '5000',
        dailyLimitMinor: null,
        monthlyLimitMinor: '250000',
        annualLimitMinor: null,
        notes: 'memo',
      }),
    ).toEqual({
      receiptRequired: false,
      approvalRequired: true,
      perTransactionLimit: 50,
      dailyLimit: null,
      monthlyLimit: 2500,
      annualLimit: null,
      notes: 'memo',
    });
  });
});

// ── Component ─────────────────────────────────────────────────────────
function policyRow(over: Record<string, unknown> = {}) {
  return {
    category: { id: 'meals', label: { en: 'Meals' }, icon: '🍽', glAccount: null },
    policy: {
      categoryId: 'meals',
      receiptRequired: true,
      approvalRequired: false,
      perTransactionLimitMinor: '5000',
      dailyLimitMinor: null,
      monthlyLimitMinor: null,
      annualLimitMinor: null,
      notes: null,
    },
    ...over,
  };
}

const ROWS = [
  policyRow(),
  policyRow({
    category: { id: 'travel', label: { en: 'Travel' }, icon: '✈', glAccount: null },
    policy: null,
  }),
];

function setTrpc(config: TrpcMockConfig) {
  h.trpc = createTrpcMock(config);
}

afterEach(() => {
  h.trpc = undefined;
});

describe('<ExpensePoliciesAdmin>', () => {
  beforeEach(() => {
    setTrpc({ queries: { 'policies.expensePolicy.byCategory': { data: ROWS } } });
  });

  it('renders a row per category with flags and limits', () => {
    render(<ExpensePoliciesAdmin canWrite />);
    expect(screen.getByText('Meals')).toBeInTheDocument();
    expect(screen.getByText('Travel')).toBeInTheDocument();
    // Meals: receiptRequired true → success flag ; perTransaction 5000 → CAD 50.00
    expect(screen.getByText('CAD 50.00')).toBeInTheDocument();
    expect(screen.getAllByLabelText('flagYes').length).toBeGreaterThan(0);
  });

  it('opens the editor drawer on row click when the user can write', async () => {
    const user = userEvent.setup();
    render(<ExpensePoliciesAdmin canWrite />);
    await user.click(screen.getByText('Meals'));
    // Drawer title repeats the category label; description key appears.
    expect(await screen.findByText('drawerDescription')).toBeInTheDocument();
    expect(screen.getByText('save')).toBeInTheDocument();
  });

  it('does not open the drawer when the user cannot write', async () => {
    const user = userEvent.setup();
    render(<ExpensePoliciesAdmin canWrite={false} />);
    await user.click(screen.getByText('Meals'));
    expect(screen.queryByText('drawerDescription')).not.toBeInTheDocument();
  });

  it('shows the loading state', () => {
    setTrpc({ queries: { 'policies.expensePolicy.byCategory': { isLoading: true } } });
    render(<ExpensePoliciesAdmin canWrite />);
    expect(screen.queryByText('Meals')).not.toBeInTheDocument();
  });
});

/** Add one clause through the pill bar's own form. */
async function addFilter(
  user: ReturnType<typeof userEvent.setup>,
  field: string,
  op: string,
  value: string,
) {
  await user.click(screen.getByRole('button', { name: /(?:Add filter|filters\.addFilter)/ }));
  await user.selectOptions(await screen.findByLabelText(/(?:^Field$|filters\.field)/), field);
  await user.selectOptions(screen.getByLabelText(/(?:^Operator$|filters\.operator)/), op);
  await user.type(screen.getByLabelText(/(?:^Value$|filters\.value$)/), value);
  await user.click(screen.getByRole('button', { name: /(?:^Add$|filters\.add$)/ }));
}

/** Which categories survived the filter. */
const shown = () => ['Meals', 'Travel'].filter((n) => screen.queryByText(n) !== null);

describe('narrowing a dozen categories', () => {
  /**
   * The list is ~12 rows and filtered in the browser, so every operator is a branch
   * written by hand rather than a `where` the database checks. An operator that silently
   * matches nothing produces an empty table, and an empty table on this page reads as
   * "no categories are configured" — which is a statement about policy, not about a
   * filter.
   */
  beforeEach(() => {
    setTrpc({ queries: { 'policies.expensePolicy.byCategory': { data: ROWS } } });
  });

  it('narrows on a substring', async () => {
    const user = userEvent.setup();
    render(<ExpensePoliciesAdmin canWrite />);
    await addFilter(user, 'category', 'contains', 'eal');
    expect(shown()).toEqual(['Meals']);
  });

  it('excludes on a substring', async () => {
    const user = userEvent.setup();
    render(<ExpensePoliciesAdmin canWrite />);
    await addFilter(user, 'category', 'doesNotContain', 'eal');
    expect(shown()).toEqual(['Travel']);
  });

  it('matches a whole name, case-insensitively', async () => {
    /** The comparison lowercases both sides; typing "meals" for a row labelled "Meals"
     *  has to match, or `equals` is a filter nobody can satisfy from the keyboard. */
    const user = userEvent.setup();
    render(<ExpensePoliciesAdmin canWrite />);
    await addFilter(user, 'category', 'equals', 'meals');
    expect(shown()).toEqual(['Meals']);
  });

  it('excludes a whole name', async () => {
    const user = userEvent.setup();
    render(<ExpensePoliciesAdmin canWrite />);
    await addFilter(user, 'category', 'doesNotEqual', 'meals');
    expect(shown()).toEqual(['Travel']);
  });

  it('anchors at the start', async () => {
    const user = userEvent.setup();
    render(<ExpensePoliciesAdmin canWrite />);
    await addFilter(user, 'category', 'startsWith', 'tra');
    expect(shown()).toEqual(['Travel']);
  });

  it('anchors at the end', async () => {
    const user = userEvent.setup();
    render(<ExpensePoliciesAdmin canWrite />);
    await addFilter(user, 'category', 'endsWith', 'vel');
    expect(shown()).toEqual(['Travel']);
  });

  it('applies two clauses together rather than letting the last one win', async () => {
    const user = userEvent.setup();
    render(<ExpensePoliciesAdmin canWrite />);
    await addFilter(user, 'category', 'contains', 'a');
    await addFilter(user, 'category', 'startsWith', 'M');
    expect(shown()).toEqual(['Meals']);
  });
});

describe('a category with no policy row', () => {
  it('reads as unset rather than as zero', () => {
    /**
     * A category nobody has configured has no ExpensePolicy at all. Rendering its limits
     * as "CAD 0.00" would say every charge is over the limit; rendering the flags as
     * ticks would say a receipt is required when nothing decided that.
     */
    setTrpc({ queries: { 'policies.expensePolicy.byCategory': { data: ROWS } } });
    render(<ExpensePoliciesAdmin canWrite />);
    const travel = screen.getByText('Travel').closest('tr') as HTMLElement;
    expect(within(travel).queryByText('CAD 0.00')).not.toBeInTheDocument();
    expect(within(travel).getAllByLabelText('flagNo').length).toBe(2);
  });
});

describe('saving a policy', () => {
  const openEditor = async (user: ReturnType<typeof userEvent.setup>) => {
    render(<ExpensePoliciesAdmin canWrite />);
    await user.click(screen.getByText('Meals'));
    await screen.findByText('drawerDescription');
  };

  it('converts dollars back to minor units at the boundary', async () => {
    /**
     * Admins type dollars; the policy engine compares minor units. The conversion lives
     * only here, so a limit saved as 50 instead of 5000 is a category whose ceiling is
     * fifty cents — and nothing downstream can tell that from a deliberate one.
     */
    const calls: unknown[] = [];
    setTrpc({
      queries: { 'policies.expensePolicy.byCategory': { data: ROWS } },
      mutations: { 'policies.expensePolicy.upsert': { onCall: (i: unknown) => calls.push(i) } },
    });
    const user = userEvent.setup();
    await openEditor(user);
    await user.click(screen.getByRole('button', { name: 'save' }));
    expect(calls).toEqual([
      {
        categoryId: 'meals',
        patch: {
          receiptRequired: true,
          approvalRequired: false,
          perTransactionLimitMinor: '5000',
          dailyLimitMinor: null,
          monthlyLimitMinor: null,
          annualLimitMinor: null,
          notes: null,
        },
      },
    ]);
  });

  it('closes the drawer once the save lands', async () => {
    setTrpc({
      queries: { 'policies.expensePolicy.byCategory': { data: ROWS } },
      mutations: { 'policies.expensePolicy.upsert': {} },
    });
    const user = userEvent.setup();
    await openEditor(user);
    await user.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(screen.queryByText('drawerDescription')).not.toBeInTheDocument());
  });

  it('cancels without writing anything', async () => {
    const calls: unknown[] = [];
    setTrpc({
      queries: { 'policies.expensePolicy.byCategory': { data: ROWS } },
      mutations: { 'policies.expensePolicy.upsert': { onCall: (i: unknown) => calls.push(i) } },
    });
    const user = userEvent.setup();
    await openEditor(user);
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(screen.queryByText('drawerDescription')).not.toBeInTheDocument());
    expect(calls).toEqual([]);
  });

  it('refuses a second press while the first save is in flight', async () => {
    /** Two upserts for one policy is two audit rows describing one decision. */
    setTrpc({
      queries: { 'policies.expensePolicy.byCategory': { data: ROWS } },
      mutations: { 'policies.expensePolicy.upsert': { isPending: true } },
    });
    const user = userEvent.setup();
    await openEditor(user);
    expect(screen.getByRole('button', { name: 'saving' })).toBeDisabled();
  });
});

// ── VeloExpense: the organization's policy currency ───────────────────
describe('a tenant whose policy currency is not CAD (VeloExpense)', () => {
  /**
   * ExpenseOS's screen assumed CAD. A tenant evaluating in USD would read "CAD 50.00" for a
   * USD limit, and a zero-decimal currency would be converted at the wrong exponent.
   */
  it('labels the limits in that currency', () => {
    setTrpc({
      queries: {
        'policies.expensePolicy.byCategory': { data: ROWS },
        'policies.expensePolicy.currency': { data: { code: 'USD' } },
      },
    });
    render(<ExpensePoliciesAdmin canWrite />);
    expect(screen.getByText('USD 50.00')).toBeInTheDocument();
    expect(screen.queryByText('CAD 50.00')).not.toBeInTheDocument();
  });

  it('converts at that currency’s exponent', () => {
    expect(minorStringToDollars('2500', 'JPY')).toBe(2500);
    expect(dollarsToMinorString(2500, 'en', 'JPY')).toBe('2500');
  });
});

// ── VeloExpense (d68): the control that sets the policy currency ──────────────
describe('the policy currency control (VeloExpense)', () => {
  /**
   * VeloExpense's v1 policy screen was the only place to change the policy currency; it
   * went at the cutover (w4-02d), so the control sits here, beside the limits stated in it.
   */
  const withCurrency = (calls: unknown[] = []) =>
    setTrpc({
      queries: {
        'policies.expensePolicy.byCategory': { data: ROWS },
        'policies.expensePolicy.currency': { data: { code: 'CAD', options: ['CAD', 'USD'] } },
      },
      mutations: { 'policies.expensePolicy.setCurrency': { onCall: (i: unknown) => calls.push(i) } },
    });

  it('shows the currency, read-only, to someone who cannot change it', () => {
    withCurrency();
    render(<ExpensePoliciesAdmin canWrite={false} />);
    expect(screen.getByText('currency.label')).toBeInTheDocument();
    expect(screen.getByText('CAD', { selector: '#policy-currency' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'currency.label' })).not.toBeInTheDocument();
  });

  it('offers the picker to someone who can, and says limits are not converted', () => {
    withCurrency();
    render(<ExpensePoliciesAdmin canWrite />);
    expect(screen.getByRole('combobox', { name: 'currency.label' })).toBeInTheDocument();
    expect(screen.getByText('currency.note')).toBeInTheDocument();
    // Nothing to save until a different currency is picked.
    expect(screen.queryByRole('button', { name: 'save' })).not.toBeInTheDocument();
  });
});
