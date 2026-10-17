import '@testing-library/jest-dom/vitest';
import { type RbacUser, SYSTEM_ROLE_IDS, SYSTEM_ROLE_PERMISSIONS } from '@expenseos/rbac';
import { render, screen } from '@testing-library/react';
import type { Session } from '@/server/trpc';
import { describe, expect, it, vi } from 'vitest';

/**
 * VeloExpense: the ported sidebar with VeloExpense's route bridge ON (`veloexpenseNav.ts`).
 * Not in ExpenseOS. `Sidebar.test.tsx` tests ExpenseOS's sidebar mechanics with the bridge
 * off; this file tests what a VeloExpense reader actually gets:
 *
 *   · ExpenseOS entries at VeloExpense's paths, and none for a screen not ported yet;
 *   · VeloExpense's own screens in the section they belong to, behind their own gates —
 *     so porting the shell took nothing away from an admin, and gave an employee nothing
 *     they cannot open.
 *
 * The roles are the two VeloExpense hands out (0068, d73): ADMIN holds System
 * Administrator, MANAGER and EMPLOYEE hold Employee.
 */

vi.mock('@/lib/trpc/client', () => ({
  trpc: { expenseApprovals: { myTasks: { useQuery: () => ({ data: undefined }) } } },
}));
vi.mock('@/i18n/navigation', () => ({
  usePathname: () => '/',
  Link: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => {
    const t = (key: string) => (ns ? `${ns}.${key}` : key);
    t.has = () => false;
    return t;
  },
  useLocale: () => 'en',
}));
vi.mock('./ProfilePopover', () => ({ ProfilePopover: () => null }));

import { AppSidebar } from './Sidebar';

type Kind = 'admin' | 'employee' | 'expense-administrator';

const asRole = (kind: Kind) => ({
  user: {
    id: 'u-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    roleId: SYSTEM_ROLE_IDS[kind],
    roleLabel: kind,
    organizationId: 'o-1',
  } as Session['user'],
  rbac: {
    permissions: [...SYSTEM_ROLE_PERMISSIONS[kind]],
    roleId: SYSTEM_ROLE_IDS[kind],
    userId: 'u-1',
  } as unknown as RbacUser,
});

/** Every VeloExpense module on, as ExpenseOS slugs (`server/platform/modules.ts`). */
const ALL_ON = new Set(['expense-management', 'travel', 'ledger-gl', 'compliance-audit', 'finance-reporting', 'budgets']);

const show = (kind: Kind, activeModules: ReadonlySet<string> = ALL_ON) =>
  render(
    <AppSidebar
      {...asRole(kind)}
      canSeeOthers={kind === 'admin'}
      activeModules={activeModules}
      organizationName="Northwind Example"
    />,
  );

const hrefs = () =>
  screen
    .queryAllByRole('link')
    .map((a) => a.getAttribute('href'))
    .sort();

describe("an admin's menu", () => {
  it('is every VeloExpense screen an admin has, and nothing else', () => {
    show('admin');
    expect(hrefs()).toEqual(
      [
        // w4-09 (d72): ExpenseOS's dashboard, at its own path, in place of VeloExpense's `/`.
        '/dashboard',
        '/notifications',
        '/expenses',
        '/admin/reimbursements',
        // w4-05/w4-07 (d71): ExpenseOS's inbox, at its own path, in place of /approvals.
        '/expenses/approvals',
        '/approvals/delegations',
        '/admin/analytics',
        '/admin/budgets',
        '/admin/compliance',
        '/admin/chart-of-accounts',
        '/admin/ledger-queue',
        '/admin/branding',
        '/admin/locale',
        '/admin/notification-delivery',
        '/admin/billing',
        '/admin/notification-templates',
        '/admin/modules',
        '/admin/integrations',
        // w4-00c: the builder, at its own path, since the cutover retired the ladder.
        '/admin/approval-workflows',
        // Ported in Wave 0 — the first ExpenseOS screen at its own path.
        '/admin/expense-categories',
        // Ported in Wave 1.
        '/admin/business-units',
        '/admin/legal-entities',
        '/admin/departments',
        '/admin/job-levels',
        '/admin/fiscal-years',
        '/admin/fx-rates',
        '/admin/mileage-rates',
        '/admin/per-diem-rates',
        // Ported in Wave 4 (w4-02b, w4-02c, w4-02e).
        '/admin/policy-rules',
        '/admin/policies',
        '/admin/policy-violations',
        // w4-10c (d74).
        '/admin/roles',
        // Ported in Wave 2 (w2-06).
        '/expenses/all',
        // People 3: ExpenseOS's People directory.
        '/users',
      ].sort(),
    );
  });

  it('offers no ExpenseOS screen that is not ported yet', () => {
    show('admin');
    // `/expenses/all` left this list with w2-06, which ported it; `/admin/roles` with w4-10c;
    // `/users` with People 3.
    for (const unported of ['/travel']) {
      expect(hrefs()).not.toContain(unported);
    }
  });

  it("drops a VeloExpense screen when VeloExpense's module for it is off", () => {
    show('admin', new Set(['expense-management']));
    expect(hrefs()).not.toContain('/admin/budgets');
    expect(hrefs()).not.toContain('/admin/analytics');
    expect(hrefs()).not.toContain('/admin/compliance');
    // An ungated admin screen is unaffected.
    expect(hrefs()).toContain('/admin/branding');
  });

  it('gates budgets on its own module, not on the section it sits in', () => {
    // ExpenseOS gates FINANCE & REPORTING on finance-reporting; VeloExpense's budgets screen
    // has a module of its own, and must show when only that one is on.
    show('admin', new Set(['expense-management', 'budgets']));
    expect(hrefs()).toContain('/admin/budgets');
    expect(hrefs()).not.toContain('/admin/analytics');
  });
});

describe("an employee's menu", () => {
  it('has their own screens and no admin screen', () => {
    show('employee');
    expect(hrefs()).toEqual([
      '/approvals/delegations',
      '/dashboard',
      '/expenses',
      '/expenses/approvals',
      '/notifications',
    ]);
  });
});

describe("an expense administrator's menu", () => {
  /**
   * VeloExpense: ExpenseOS's Notification templates entry requires `notification.templateUpdate`,
   * which this role holds, but VeloExpense's page at that path admits System Administrators
   * only (`asAdminPage`). The role-matrix crawl found the menu offering it and the page
   * answering 403; `VELOEXPENSE_REQUIRES` makes the menu ask the page's question (16 Oct).
   */
  it('offers no screen whose page would refuse them', async () => {
    const { SYSTEM_ROLE_PERMISSIONS: perms, permissions: P } = await import('@expenseos/rbac');
    // The premise: they hold ExpenseOS's permission for the entry.
    expect(perms['expense-administrator']).toContain(P.notification.templateUpdate);
    show('expense-administrator');
    expect(hrefs()).not.toContain('/admin/notification-templates');
    // And the screens they CAN open are still offered.
    expect(hrefs()).toContain('/admin/policies');
    expect(hrefs()).toContain('/admin/expense-categories');
  });

  it('keeps the override to menu routes, and to the admin question', async () => {
    const { VELOEXPENSE_REQUIRES } = await import('./veloexpenseNav');
    const { SECTIONS } = await import('./Sidebar');
    const menu = new Set(SECTIONS.flatMap((section) => section.items.map((item) => item.to)));
    expect(Object.keys(VELOEXPENSE_REQUIRES).filter((to) => !menu.has(to))).toEqual([]);
  });
});

describe('the header', () => {
  it("carries VeloExpense's wordmark and the organization's name, untranslated", () => {
    show('employee');
    expect(screen.getAllByAltText('VeloExpense').length).toBeGreaterThan(0);
    expect(screen.queryByAltText('E Inc.')).not.toBeInTheDocument();
    const org = screen.getByTestId('shell-org-name');
    expect(org).toHaveTextContent('Northwind Example');
    expect(org).toHaveAttribute('translate', 'no');
  });
});

describe('isPortedScreen', () => {
  it('matches a ported route and what is under it, on a segment boundary', async () => {
    const { isPortedScreen } = await import('./veloexpenseNav');
    const ported = ['/admin/expense-categories'];
    expect(isPortedScreen('/admin/expense-categories', ported)).toBe(true);
    expect(isPortedScreen('/admin/expense-categories/new', ported)).toBe(true);
    expect(isPortedScreen('/admin/expense-categories-old', ported)).toBe(false);
    expect(isPortedScreen('/admin', ported)).toBe(false);
  });

  it('titles the screens ported so far, and only those', async () => {
    const { PORTED_SCREENS } = await import('./veloexpenseNav');
    expect(PORTED_SCREENS).toEqual([
      '/admin/expense-categories',
      '/admin/business-units',
      '/admin/legal-entities',
      '/admin/departments',
      '/admin/job-levels',
      '/admin/fiscal-years',
      '/admin/fx-rates',
      '/admin/mileage-rates',
      '/admin/per-diem-rates',
      '/admin/approval-workflows',
      '/admin/policy-rules',
      '/admin/policies',
      '/admin/policy-violations',
      '/expenses',
      '/expenses/approvals',
      '/dashboard',
      '/admin/roles',
      '/users',
    ]);
  });
});
