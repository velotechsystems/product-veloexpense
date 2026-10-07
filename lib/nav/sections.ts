/**
 * The app shell's navigation — ported from ExpenseOS's `Sidebar.tsx` `SECTIONS`.
 *
 * ── WHAT IS PORTED, AND WHAT CHANGES ────────────────────────────────────────
 *
 * Ported as-is, with ExpenseOS's reasons:
 *   · One module-level constant, pure data, so a test can assert every entry's
 *     route and catalogue key without rendering anything (their
 *     `Sidebar.nav.test.ts`; ours is `test/nav-sections.test.ts`).
 *   · Every `href` must resolve to a real page. ExpenseOS found four menu items
 *     parked on `/dashboard`, "a menu entry that lies about what exists" (their GA
 *     readiness F01); the test fails a dangling `href` so that cannot recur.
 *   · Visibility mirrors the PAGE's own gate, so the menu and the page never
 *     disagree about who a screen is for. A hidden item is not a security
 *     boundary — every page still enforces its own gate — it is the menu not
 *     offering what will be refused.
 *   · Module-gated items disappear when the module is off, rather than linking to
 *     a page that explains it is off ("without this the link would render but the
 *     page would 404" — theirs; ours would say "not enabled", which is the same
 *     dead end in politer words). The Modules screen is where it is turned on.
 *   · "My" on the expense list (their UAT A6: an approver read their own list as
 *     the whole set and concluded a colleague's report had not arrived).
 *   · A live count on Approvals (`badgeKey: 'pendingApprovals'`).
 *
 * Changed, and why:
 *   · Gates are VeloExpense's: one role column (EMPLOYEE | MANAGER | ADMIN) read
 *     from the database, not ExpenseOS's permission catalogue. Every admin page
 *     here gates on `asAdminPage`, so an admin item says `admin: true`.
 *   · No NetSuite, virtual-card or travel sections: VeloExpense has none of those
 *     screens (the 13 NetSuite pages became the one integrations screen).
 *   · Integrations and the chart of accounts are NOT module-hidden although they
 *     read the accounting module: their pages are deliberately ungated so an
 *     admin can see why nothing is listed (see their loaders). Hiding the link
 *     would undo that.
 */
import type { UiKey } from '@/lib/i18n/catalog/ui';

/** Lucide icon names this file may use; `components/app-shell/icons.ts` maps them. */
export type NavIcon =
  | 'home'
  | 'bell'
  | 'receipt'
  | 'check'
  | 'users-cog'
  | 'chart'
  | 'piggy-bank'
  | 'banknote'
  | 'book'
  | 'library'
  | 'scroll'
  | 'shield'
  | 'users'
  | 'ladder'
  | 'plug'
  | 'puzzle'
  | 'palette'
  | 'languages'
  | 'mail'
  | 'send'
  | 'card'
  | 'settings';

export interface NavItem {
  label: UiKey;
  href: string;
  icon: NavIcon;
  /** Only an active ADMIN sees it — the page gates on `asAdminPage`. */
  admin?: true;
  /** Hidden unless this module (`lib/modules/registry.ts` code) is enabled. */
  module?: string;
  /** Which live count to show beside it, resolved per request. */
  badge?: 'pendingApprovals';
  /**
   * Highlight only on this exact path, not on its sub-pages. For an item whose
   * section has a sibling under the same prefix (/approvals vs
   * /approvals/delegations), or the home page, which every path starts with.
   */
  exact?: true;
}

export interface NavSection {
  /** Omitted for the unlabelled top group. */
  label?: UiKey;
  items: NavItem[];
}

export const SECTIONS: NavSection[] = [
  {
    items: [
      { label: 'nav.sidebar.home', href: '/', icon: 'home', exact: true },
      { label: 'nav.notifications', href: '/notifications', icon: 'bell', exact: true },
    ],
  },
  {
    label: 'nav.sidebar.section.expenses',
    items: [{ label: 'nav.my.expenses', href: '/expenses', icon: 'receipt' }],
  },
  {
    label: 'nav.sidebar.section.approvals',
    items: [
      { label: 'nav.approvals', href: '/approvals', icon: 'check', badge: 'pendingApprovals', exact: true },
      { label: 'nav.delegations', href: '/approvals/delegations', icon: 'users-cog' },
    ],
  },
  {
    label: 'nav.sidebar.section.finance',
    items: [
      { label: 'nav.sidebar.analytics', href: '/admin/analytics', icon: 'chart', admin: true, module: 'analytics' },
      { label: 'nav.sidebar.budgets', href: '/admin/budgets', icon: 'piggy-bank', admin: true, module: 'budgets' },
      { label: 'nav.sidebar.reimbursements', href: '/admin/reimbursements', icon: 'banknote', admin: true },
      { label: 'nav.sidebar.ledger.queue', href: '/admin/ledger-queue', icon: 'book', admin: true },
    ],
  },
  {
    label: 'nav.sidebar.section.compliance',
    items: [
      { label: 'nav.sidebar.expense.policies', href: '/admin/expense-policies', icon: 'scroll', admin: true },
      { label: 'nav.sidebar.compliance', href: '/admin/compliance', icon: 'shield', admin: true, module: 'compliance' },
    ],
  },
  {
    label: 'nav.sidebar.section.administration',
    items: [
      { label: 'nav.sidebar.people', href: '/admin/employees', icon: 'users', admin: true },
      { label: 'nav.sidebar.approval.ladder', href: '/admin/approval-ladder', icon: 'ladder', admin: true },
      { label: 'nav.sidebar.chart.of.accounts', href: '/admin/chart-of-accounts', icon: 'library', admin: true },
      { label: 'nav.sidebar.integrations', href: '/admin/integrations', icon: 'plug', admin: true },
      { label: 'nav.sidebar.modules', href: '/admin/modules', icon: 'puzzle', admin: true },
      { label: 'nav.sidebar.branding', href: '/admin/branding', icon: 'palette', admin: true },
      { label: 'nav.sidebar.locale', href: '/admin/locale', icon: 'languages', admin: true },
      { label: 'nav.sidebar.notification.templates', href: '/admin/notification-templates', icon: 'mail', admin: true },
      { label: 'nav.sidebar.notification.delivery', href: '/admin/notification-delivery', icon: 'send', admin: true },
      { label: 'nav.sidebar.billing', href: '/admin/billing', icon: 'card', admin: true },
    ],
  },
  {
    label: 'nav.sidebar.section.you',
    items: [
      { label: 'nav.sidebar.preferences', href: '/preferences', icon: 'settings' },
      { label: 'nav.sidebar.notification.preferences', href: '/notifications/preferences', icon: 'bell' },
    ],
  },
];

export interface NavViewer {
  isAdmin: boolean;
  enabledModules: ReadonlySet<string>;
}

/** The sections this person sees: items filtered by their gates, empty sections dropped. */
export function visibleSections(viewer: NavViewer, sections: NavSection[] = SECTIONS): NavSection[] {
  return sections
    .map((s) => ({
      ...s,
      items: s.items.filter(
        (i) => (!i.admin || viewer.isAdmin) && (i.module === undefined || viewer.enabledModules.has(i.module)),
      ),
    }))
    .filter((s) => s.items.length > 0);
}

/** Whether `item` is the current page, by its `exact` rule. Used by the client link. */
export function isActive(href: string, exact: boolean, pathname: string): boolean {
  if (pathname === href) return true;
  if (exact) return false;
  return pathname.startsWith(href.endsWith('/') ? href : `${href}/`);
}

/** Paths where the shell is NOT drawn: no session, or a single-purpose flow. */
export const SHELL_FREE = [/^\/login(?:\/|$)/, /^\/signup(?:\/|$)/, /^\/approve(?:\/|$)/, /^\/invite(?:\/|$)/];
export const shellFree = (pathname: string) => SHELL_FREE.some((re) => re.test(pathname));
