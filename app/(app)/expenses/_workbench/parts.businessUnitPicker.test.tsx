import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// VeloExpense: ExpenseOS's combobox is an <input placeholder>; the kit's is a button.
import { getComboboxByPlaceholder } from '@/test-utils/kitCombobox';
// VeloExpense: ExpenseOS's catalogue locale — what next-intl reports on every ported screen
// (i18n/request.ts) — named rather than spelled, for check-i18n's IL-1 scan.
import { DEFAULT_LOCALE as CATALOG_LOCALE } from '@expenseos/i18n';

/**
 * The cost-allocation business unit picker under the NetSuite business unit source.
 *
 * VeloExpense: only the admin (EXPENSEOS) picker is pinned here; see the note above its
 * suite.
 *
 * What the server decides (the source, the options, the pre-select) arrives through the
 * mocked tRPC queries; what is pinned here is what the editor does with it: the path
 * labels and their order, a search on any segment of a path, the pre-select seeded from
 * `pickerNsBusinessUnitId`, and the change handler that clears the legacy admin id so that
 * clearing the picker really uncodes the line.
 *
 * The allocation controls sit inside a `hidden lg:contents` cloak; jsdom applies no CSS, so
 * they are reachable here at any width.
 */

const h = vi.hoisted(() => ({
  calls: {} as Record<string, unknown[]>,
  queries: {} as Record<string, unknown>,
}));

vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key;
    t.has = () => false;
    return t;
  },
  useLocale: () => 'en',
}));

vi.mock('@/lib/trpc/client', () => {
  const procedure = (name: string) => ({
    useQuery: () => ({ data: h.queries[name], isLoading: false, isFetching: false, error: null }),
    useMutation: () => ({
      isPending: false,
      mutate: (vars: unknown) => {
        h.calls[name] ??= [];
        h.calls[name].push(vars);
      },
      mutateAsync: vi.fn(),
    }),
  });
  const router = new Proxy({} as Record<string, unknown>, {
    get: (_t, key: string) => procedure(key),
  });
  return {
    trpc: {
      expenses: router,
      mileageRoute: {
        status: { useQuery: () => ({ data: { available: false }, isLoading: false }) },
        searchPlaces: {
          useQuery: () => ({ data: { items: [], error: null }, isFetching: false, error: null }),
        },
        computeRoutes: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      },
    },
  };
});

vi.mock('@/components/attachments/AttachmentViewer', () => ({
  AttachmentDocument: () => null,
  useViewerZoom: () => ({ zoom: 1, setZoom: vi.fn() }),
  ZoomControls: () => null,
}));

import { ExpenseEditor } from './parts';

const CAD = { id: 'cur-cad', code: 'CAD', symbol: '$', exponent: 2 };

const allocation = (over: Record<string, unknown> = {}) => ({
  id: 'alloc-1',
  percentBp: 10_000,
  businessUnitId: null,
  businessUnit: null,
  pickerNsBusinessUnitId: null,
  departmentId: 'dep-1',
  department: { id: 'dep-1', label: { en: 'Engineering' } },
  classId: 'cls-1',
  class: { id: 'cls-1', name: 'Internal' },
  ...over,
});

const expense = (allocations: unknown[]) =>
  ({
    id: 'exp-1',
    merchant: 'Corner Bistro',
    date: new Date('2026-08-01T00:00:00Z').toISOString(),
    amountMinor: '11500',
    currencyId: 'cur-cad',
    currency: CAD,
    placeText: 'Montréal',
    purpose: null,
    explanation: null,
    paymentMethod: 'OUT_OF_POCKET',
    lineItems: [],
    receipts: [],
    attendees: [],
    allocations,
    taxGstHstMinor: null,
    taxQstMinor: null,
    taxPstMinor: null,
    recoverableGstHstMinor: null,
    recoverableQstMinor: null,
    taxSource: 'CALCULATED',
    subtotalMinor: null,
    fxRate: null,
  }) as never;

// VeloExpense: EXPENSEOS only (no NETSUITE_UNITS).
const dimensions = (businessUnitSource: 'EXPENSEOS' = 'EXPENSEOS') => ({
  businessUnitSource,
  businessUnits: [{ id: 'bu-1', label: { en: 'Atlantic' } }],
  departments: [{ id: 'dep-1', label: { en: 'Engineering' } }],
  classes: [{ id: 'cls-1', name: 'Internal' }],
});

function editor(allocations: unknown[]) {
  return (
    <ExpenseEditor
      expense={expense(allocations)}
      violations={[]}
      currencySymbol="$"
      editable
      categoryItems={[]}
      locale={CATALOG_LOCALE}
      onChange={vi.fn()}
      entityRecovers
    />
  );
}

function renderEditor(allocations: unknown[]) {
  return render(editor(allocations));
}

const picker = () => getComboboxByPlaceholder('allocation.businessUnit') as HTMLInputElement;

beforeEach(() => {
  h.calls = {};
  h.queries = { dimensionOptions: dimensions() };
});

// VeloExpense: ExpenseOS's "the NetSuite business unit picker" suite is not carried over.
// VeloExpense has no NetSuite business unit source — `dimensionOptions` always answers
// EXPENSEOS (w2-03) — so the editor's NETSUITE branch never runs, and
// `businessUnitOptions` (the NetSuite tree as path labels) is not ported.

describe('a tenant with no classes (VeloExpense)', () => {
  /**
   * VeloExpense has no Class dimension: `dimensionOptions` sends an empty list and
   * `allocationSet` takes none. So the picker is not drawn and a row is complete with a
   * business unit and a department — without this, every allocation would sit flagged as
   * incomplete and never save.
   */
  it('draws no class picker, and saves a row with a business unit and a department', async () => {
    h.queries = { dimensionOptions: { ...dimensions(), classes: [] } };
    const user = userEvent.setup();
    renderEditor([allocation({ classId: null, class: null })]);
    expect(screen.queryByText('allocation.class')).not.toBeInTheDocument();
    expect(
      screen.queryAllByRole('combobox').map((c) => c.getAttribute('data-placeholder')),
    ).not.toContain('allocation.class');
    await user.click(picker());
    await user.click(screen.getByRole('option', { name: 'Atlantic' }));
    expect(h.calls.allocationSet).toEqual([
      {
        expenseId: 'exp-1',
        allocations: [
          { percentBp: 10_000, businessUnitId: 'bu-1', departmentId: 'dep-1', classId: null },
        ],
      },
    ]);
    expect(screen.queryByText('allocation.required')).not.toBeInTheDocument();
  });
});

describe('the admin business unit picker (EXPENSEOS source)', () => {
  it('saves nothing, and offers no edit, until the options have loaded', () => {
    // VeloExpense: ExpenseOS's test of the same gate, on the EXPENSEOS source — the gate is
    // the editor's (`optionsLoaded`), whatever the source turns out to be.
    h.queries = { dimensionOptions: undefined };
    const rows = [
      allocation({
        businessUnitId: 'bu-1',
        businessUnit: { id: 'bu-1', label: { en: 'Atlantic' } },
      }),
    ];
    const { rerender } = renderEditor(rows);
    const percent = screen.getByLabelText('allocation.percent');
    expect(percent).toBeDisabled();
    expect(picker()).toBeDisabled();
    expect(getComboboxByPlaceholder('allocation.department')).toBeDisabled();
    // No class picker before the options load: whether the tenant has classes is not known
    // yet (see the no-class suite above).
    expect(screen.getByRole('button', { name: 'allocation.add' })).toBeDisabled();
    fireEvent.blur(percent);
    expect(h.calls.allocationSet).toBeUndefined();

    h.queries = { dimensionOptions: dimensions() };
    rerender(editor(rows));
    expect(screen.getByLabelText('allocation.percent')).toBeEnabled();
    fireEvent.blur(screen.getByLabelText('allocation.percent'));
    expect(h.calls.allocationSet).toEqual([
      {
        expenseId: 'exp-1',
        allocations: [
          { percentBp: 10_000, businessUnitId: 'bu-1', departmentId: 'dep-1', classId: 'cls-1' },
        ],
      },
    ]);
  });

  it('lists the admin business units and saves the admin id, as before', async () => {
    h.queries = { dimensionOptions: dimensions('EXPENSEOS') };
    const user = userEvent.setup();
    renderEditor([allocation()]);
    await user.click(picker());
    await user.click(screen.getByRole('option', { name: 'Atlantic' }));
    expect(h.calls.allocationSet).toEqual([
      {
        expenseId: 'exp-1',
        allocations: [
          {
            percentBp: 10_000,
            businessUnitId: 'bu-1',
            departmentId: 'dep-1',
            classId: 'cls-1',
          },
        ],
      },
    ]);
    // Not even as null: the EXPENSEOS payload is exactly today's.
    const [sent] = h.calls.allocationSet as Array<{ allocations: object[] }>;
    expect(sent.allocations[0]).not.toHaveProperty('nsBusinessUnitId');
  });
});
