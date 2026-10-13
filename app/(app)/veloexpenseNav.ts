import { type Permission, permissions as P } from '@expenseos/rbac';
import {
  IconBook,
  IconBuildingBank,
  IconChartBar,
  IconChartPie,
  IconCreditCard,
  IconLanguage,
  IconListNumbers,
  IconPalette,
  IconSend,
  IconShieldCheck,
  IconUsers,
  type Icon as TablerIcon,
} from '@tabler/icons-react';

/**
 * VeloExpense: the bridge between ExpenseOS's navigation and the screens VeloExpense has
 * TODAY. Not in ExpenseOS.
 *
 * `Sidebar.tsx`'s `SECTIONS` is ExpenseOS's menu, unchanged, so a diff against ExpenseOS
 * stays readable and each screen's item is already in place when its port lands. Until it
 * does, two things are true at once, and this file says both:
 *
 *   · Most ExpenseOS destinations have no page here yet. `VELOEXPENSE_ROUTES` maps each of
 *     them to `null`, and a `null` item is not shown — a menu entry must not lead to a 404
 *     (ExpenseOS's own rule, GA readiness F01). A few have a VeloExpense equivalent at a
 *     different path, and map to it.
 *   · VeloExpense has screens ExpenseOS's menu has no entry for (branding, billing, the
 *     ledger queue, …). `VELOEXPENSE_ITEMS` adds them to the ExpenseOS section they belong
 *     in, so porting the shell takes nothing away from anybody.
 *
 * A screen ported to its ExpenseOS path DELETES its `null` here, and `Sidebar.nav.test.ts`
 * fails until it does (a `null` whose page exists), so the map only ever shrinks. When a
 * VeloExpense-only screen is replaced by its ExpenseOS port, its extra item goes too.
 */

/**
 * ExpenseOS route -> where that screen is in VeloExpense today, or `null` for "not here
 * yet". A route not listed is at the same path in both.
 */
export const VELOEXPENSE_ROUTES: Readonly<Record<string, string | null>> = {
  // Same screen, different path.
  '/dashboard': '/',
  '/delegations': '/approvals/delegations',

  // Not ported yet. Each leaves with the wave that ports its screen (parity doc).
  '/users': null,
  '/travel': null,
  '/admin/travel-categories': null,
  '/virtual-cards/requests': null,
  '/virtual-cards': null,
  '/virtual-cards/transactions': null,
  '/virtual-cards/statements': null,
  // ExpenseOS's analytics and budgets are open to employees for their own spend;
  // VeloExpense's are admin screens, so they are VeloExpense items below until ported.
  '/analytics': null,
  '/budgets': null,
  '/admin/audit-trail': null,
  '/admin/fraud-detection': null,
  '/admin/control-evaluation': null,
  '/admin/roles': null,
  '/admin/api-keys': null,
  '/admin/assistant-feedback': null,
  '/admin/authentication': null,
  '/admin/platform': null,
  '/ledger/sync': null,
  '/ledger/posting': null,
  '/ledger/people': null,
  '/ledger/settings': null,
  '/ledger/gl-accounts': null,
  '/ledger/vendors': null,
  '/ledger/expense-categories': null,
  '/ledger/classes': null,
  '/ledger/departments': null,
  '/ledger/business-units': null,
  '/ledger/subsidiaries': null,
  '/ledger/locations': null,
  '/ledger/tax-groups': null,
};

/** Where an ExpenseOS nav destination is in VeloExpense, or `null` when it is not here yet. */
export function veloExpenseRoute(to: string): string | null {
  return Object.hasOwn(VELOEXPENSE_ROUTES, to) ? (VELOEXPENSE_ROUTES[to] ?? null) : to;
}

/**
 * VeloExpense's admin screens gate on the `ADMIN` role (`asAdminPage`), which
 * `systemRoleFor` maps to ExpenseOS's System Administrator — the only role VeloExpense
 * hands out that holds this permission. So "requires this" reads as "is an admin" here.
 */
const VELOEXPENSE_ADMIN: Permission = P.admin.appSettings.update;

export interface VeloExpenseNavItem {
  /** Catalog key under nav.items.* */
  key: string;
  icon: TablerIcon;
  to: string;
  requires: Permission;
  /**
   * ExpenseOS module slug (`server/platform/modules.ts`) that must be active. These items
   * carry their OWN gate and do not inherit their host section's: a VeloExpense screen is
   * gated by VeloExpense's module, which is not always the one ExpenseOS gates the section
   * on (budgets has a module of its own here).
   */
  moduleSlug?: string;
}

/** VeloExpense screens with no ExpenseOS menu entry, by the ExpenseOS section they join. */
export const VELOEXPENSE_ITEMS: Readonly<Record<string, readonly VeloExpenseNavItem[]>> = {
  expenseManagement: [
    { key: 'reimbursements', icon: IconBuildingBank, to: '/admin/reimbursements', requires: VELOEXPENSE_ADMIN },
    // w4-02c: VeloExpense's own `expensePolicies` item (/admin/expense-policies) went when
    // ExpenseOS's screen of that name was ported (/admin/policies); the screen itself went
    // with VeloExpense's v1 engine at the cutover (w4-02d).
  ],
  financeReporting: [
    {
      key: 'expenseAnalytics',
      icon: IconChartBar,
      to: '/admin/analytics',
      requires: VELOEXPENSE_ADMIN,
      moduleSlug: 'finance-reporting',
    },
    {
      key: 'budgetTracking',
      icon: IconChartPie,
      to: '/admin/budgets',
      requires: VELOEXPENSE_ADMIN,
      moduleSlug: 'budgets',
    },
  ],
  complianceAudit: [
    {
      key: 'compliance',
      icon: IconShieldCheck,
      to: '/admin/compliance',
      requires: VELOEXPENSE_ADMIN,
      moduleSlug: 'compliance-audit',
    },
  ],
  administration: [
    { key: 'employees', icon: IconUsers, to: '/admin/employees', requires: VELOEXPENSE_ADMIN },
    { key: 'chartOfAccounts', icon: IconListNumbers, to: '/admin/chart-of-accounts', requires: VELOEXPENSE_ADMIN },
    { key: 'ledgerQueue', icon: IconBook, to: '/admin/ledger-queue', requires: VELOEXPENSE_ADMIN },
    { key: 'branding', icon: IconPalette, to: '/admin/branding', requires: VELOEXPENSE_ADMIN },
    { key: 'defaultLanguage', icon: IconLanguage, to: '/admin/locale', requires: VELOEXPENSE_ADMIN },
    { key: 'emailDelivery', icon: IconSend, to: '/admin/notification-delivery', requires: VELOEXPENSE_ADMIN },
    { key: 'billing', icon: IconCreditCard, to: '/admin/billing', requires: VELOEXPENSE_ADMIN },
  ],
};

/**
 * Screens PORTED from ExpenseOS, by route (and everything under it). The top bar titles
 * these, as ExpenseOS's does every screen (`pageTitle.ts`). Every other page VeloExpense
 * serves today is VeloExpense's own and already carries its own `<h1>`; a top-bar title over
 * it would put two headings with the same name on the page. Grows by one entry per ported
 * screen, and goes when every page is a port.
 */
export const PORTED_SCREENS: readonly string[] = [
  '/admin/expense-categories',
  '/admin/business-units',
  '/admin/legal-entities',
  '/admin/departments',
  '/admin/job-levels',
  '/admin/fiscal-years',
  '/admin/fx-rates',
  '/admin/mileage-rates',
  '/admin/per-diem-rates',
  // w4-01: the workflow builder (its editor, `/[id]`, by inheritance).
  '/admin/approval-workflows',
  // w4-02b: the Rule Builder.
  '/admin/policy-rules',
  // w4-02c: the per-category policies.
  '/admin/policies',
  // w4-02e: the policy-violation register.
  '/admin/policy-violations',
  // w4-05/w4-07 (d71): the approvals inbox, in place of VeloExpense's /approvals.
  '/expenses/approvals',
];

/** Whether the top bar should title this path: it is a ported ExpenseOS screen. */
export function isPortedScreen(pathname: string, ported: readonly string[] = PORTED_SCREENS): boolean {
  return ported.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}
