// VeloExpense: the default locale from the registry (check:i18n), where ExpenseOS writes 'en'.
import { DEFAULT_LOCALE } from '@expenseos/i18n/locales';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { inferRouterOutputs } from '@trpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppRouter } from '@/server/routers/_app';
import { AllocationLinesReadOnly, type AllocationLineView } from './AllocationLinesReadOnly';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

afterEach(cleanup);

/**
 * Both routes that feed this component must be assignable to its narrow row type WITHOUT a
 * cast — the workbench (`expenses.report`) and the approver drawer
 * (`expenseApprovals.report`). `tsc` checks these two lines; a field the component starts
 * reading that either route does not send fails the typecheck here, not in the drawer.
 */
type Outputs = inferRouterOutputs<AppRouter>;
type WorkbenchAllocation = Outputs['expenses']['report']['expenses'][number]['allocations'];
type DrawerAllocation = Outputs['expenseApprovals']['report']['expenses'][number]['allocations'];
const _workbenchFits = (a: WorkbenchAllocation): readonly AllocationLineView[] => a;
const _drawerFits = (a: DrawerAllocation): readonly AllocationLineView[] => a;
void _workbenchFits;
void _drawerFits;

const CAD = { code: 'CAD', symbol: '$' };

const line = (id: string, percentBp: number): AllocationLineView => ({
  id,
  percentBp,
  nsBusinessUnitLabel: null,
  businessUnit: { label: { en: 'Atlantic', 'fr-CA': 'Atlantique' } },
  department: { label: { en: 'Engineering' } },
  class: { name: 'Internal' },
});

const rows = () => screen.getAllByRole('listitem').map((li) => li.textContent ?? '');

describe('AllocationLinesReadOnly', () => {
  it('splits a 60/40 allocation into its share of the expense', () => {
    render(
      <AllocationLinesReadOnly
        allocations={[line('a', 6000), line('b', 4000)]}
        amountMinor="11500"
        currency={CAD}
        locale={DEFAULT_LOCALE}
      />,
    );

    const [first, second] = rows();
    expect(first).toContain('60%');
    expect(first).toContain('$69.00 CAD');
    expect(first).toContain('Atlantic · Engineering · Internal');
    expect(second).toContain('40%');
    expect(second).toContain('$46.00 CAD');
  });

  it('splits 100.01 three ways so the rows add up to the cent', () => {
    /** Largest remainder: the leftover cent goes to the largest share, as NetSuite posts it. */
    render(
      <AllocationLinesReadOnly
        allocations={[line('a', 3333), line('b', 3333), line('c', 3334)]}
        amountMinor="10001"
        currency={CAD}
        locale={DEFAULT_LOCALE}
      />,
    );

    const [a, b, c] = rows();
    expect(a).toContain('$33.33 CAD');
    expect(b).toContain('$33.33 CAD');
    expect(c).toContain('$33.35 CAD');
  });

  it('says an uncoded expense is uncoded, rather than rendering nothing', () => {
    render(
      <AllocationLinesReadOnly allocations={[]} amountMinor="11500" currency={CAD} locale={DEFAULT_LOCALE} />,
    );

    const none = screen.getByText('allocation.none');
    expect(none).toHaveClass('text-warning');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('names the NetSuite business unit when the server sends one, else the admin label in the reader locale', () => {
    render(
      <AllocationLinesReadOnly
        allocations={[
          { ...line('ns', 5000), nsBusinessUnitLabel: 'Halifax' },
          { ...line('admin', 5000), department: null, class: null },
        ]}
        amountMinor="2000"
        currency={CAD}
        locale="fr-CA"
      />,
    );

    const [ns, admin] = rows();
    expect(ns).toContain('Halifax · Engineering · Internal');
    expect(admin).toContain('Atlantique');
    expect(admin).not.toContain('·');
  });
});
