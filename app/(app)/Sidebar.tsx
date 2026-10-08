'use client';

import {
  cn,
  Sidebar as DSSidebar,
  NavLink,
  SidebarHeader,
  SidebarSection,
} from '@expenseos/design-system';
import {
  can,
  permissions as P,
  type Permission,
  type RbacUser,
  RETIRED_ROLE_IDS,
  SYSTEM_ROLE_IDS,
} from '@expenseos/rbac';
import {
  IconAdjustments,
  IconAlertTriangle,
  IconArrowsExchange,
  IconBell,
  IconBriefcase,
  IconCar,
  IconChartBar,
  IconChartPie,
  IconClipboardCheck,
  IconClipboardList,
  IconCoin,
  IconCreditCard,
  IconFileDescription,
  IconFileText,
  IconKey,
  IconLayoutDashboard,
  IconListSearch,
  IconMail,
  IconPackages,
  IconPlane,
  IconPlugConnected,
  IconReceipt,
  IconReceipt2,
  IconRefresh,
  IconSettings,
  IconShieldCheck,
  IconTags,
  IconUpload,
  IconUsers,
  type Icon as TablerIcon,
} from '@tabler/icons-react';
import type { Session } from '@/server/trpc';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link, usePathname } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc/client';
import { type DispositionTable, dispositionFor, MOBILE_READINESS } from './mobileReadiness';
import { Wordmark } from '@/components/brand/wordmark';
import { ProfilePopover } from './ProfilePopover';
import { VELOEXPENSE_ITEMS, veloExpenseRoute } from './veloexpenseNav';

interface NavItem {
  /** Catalog key under nav.items.* */
  key: string;
  icon: TablerIcon;
  to: string;
  /**
   * Which live count to show beside this item, resolved at render.
   *
   * A KEY rather than a number because `SECTIONS` is a module-level constant — it has to
   * be, so `Sidebar.nav.test.ts` can assert every entry's route and catalog key without
   * mounting anything. A count is a hook's result and cannot live here.
   */
  badgeKey?: 'pendingApprovals';
  /**
   * Permission required to see this item. Omitted = visible to everyone.
   *
   * A LIST means any-of, and exists because a page whose own gate is a disjunction
   * had to pick one of its permissions here — so the menu and the page disagreed
   * about who the screen is for. /expenses/all admits
   * `report.read.all || report.reimburse`; naming only the second hid the entry
   * from a reader who could open the page by URL.
   */
  requires?: Permission | readonly Permission[];
  /**
   * Module that must be installed + active for this item to show. For items
   * that live in a core (always-shown) section but whose PAGE is module-gated
   * (e.g. policy admin under `expense-management`) — without this the link
   * would render but the page would 404.
   */
  moduleSlug?: string;
}

interface NavSectionDef {
  /** Catalog key under nav.sections.* — omitted for an unsectioned group. */
  sectionKey?: string;
  /**
   * Module that gates this whole section. Omitted = core (always shown).
   * The section is hidden unless this module is installed + active. For
   * integration-driven sections (e.g. NetSuite) the gate is still a module —
   * one the integration provides via `providesModules` and that declares
   * `requiresIntegrations`, so it can't activate without its integration.
   * See docs/use-cases/15-platform-extensibility.md.
   */
  moduleSlug?: string;
  items: NavItem[];
}

/**
 * Navigation tree — mirrors `NAV_SECTIONS` from the mockup
 * (ExpenseReport-App.html). Section + item labels resolve through the
 * @expenseos/i18n nav catalog. Visibility is gated by RBAC permissions
 * resolved server-side per request — no more role tuples.
 */
/**
 * Exported for one reason: `Sidebar.nav.test.ts` asserts every key here resolves to
 * a catalog entry in both locales. `assistantFeedback` shipped with its entry at the
 * nav ROOT while both readers ask for `nav.items.*`, so the sidebar and the page
 * title rendered the raw key — a thing no typecheck can see and no reviewer reads a
 * JSON file to catch.
 */
/**
 * Four items were removed rather than repointed: GL Reconciliation, Data Exports,
 * Analytics Permissions and Custom Fields. Each pointed at `/dashboard`, so clicking it
 * silently rendered the dashboard placeholder — a menu entry that lies about what exists
 * (GA readiness report F01). None of them has a page yet; when one is built, its item
 * comes back with it, and `Sidebar.nav.test.ts` now fails a `to:` that resolves to no
 * route, so it cannot come back pointing at nothing.
 */
export const SECTIONS: NavSectionDef[] = [
  {
    sectionKey: 'home',
    items: [
      {
        /**
         * FIRST, deliberately. `/dashboard` was a placeholder six items were parked on
         * (GA readiness F01); it is now the landing surface, so it leads the HOME section
         * and is the first thing in the whole navigation. No new catalog copy was needed:
         * `nav.items.dashboard` already existed in EN and FR-CA, and TopBar already maps
         * `/dashboard` to it for the title.
         */
        key: 'dashboard',
        icon: IconLayoutDashboard,
        to: '/dashboard',
      },
      /**
       * `myInfo` USED TO SIT HERE, SECOND, AND ITS PAGE IS NOW GONE — not hidden, not
       * redirected. `/my-info` was deleted outright, so this is not the F01 defect shape
       * the previous docstring here argued against: there is no working page left behind
       * the removed item to be orphaned by it.
       *
       * The two things that justified a second personal surface both moved before the
       * route went. The employment record and its employee-status badge are `/profile`'s
       * now, reached from the profile popover (`myProfile`, which SURVIVES in the nav
       * catalog and is read by `ProfilePopover` and `pageTitle`); the identity band and
       * the activity sections are `/dashboard`'s, immediately above. That satisfies
       * ADR-0002's own exit condition for the duplication — clause 1, "removed and the
       * page keeps only the employment record and its badge" — rather than reversing D7.
       *
       * A clean 404 was the ruling, with no redirect: no notification template and no
       * `packages/notifications` path emits a `/my-info` URL (`subjectLinks.ts` is the
       * single emitter and never did), and nothing in the product linked to it.
       *
       * `Sidebar.nav.test.ts` asserts BOTH directions of this now — no route and no nav
       * item — so restoring the item alone fails, and so does restoring it with a route.
       */
      // 'people' is gated by `canSeeOthers` (hasReadAll || hasReports),
      // computed in the (app)/layout and threaded through props — not by
      // a static permission. See the visibility filter below.
      { key: 'people', icon: IconUsers, to: '/users' },
      {
        /**
         * `/notifications` EXISTS and always did — this pointed at `/dashboard`, so the
         * one page a person could not reach from the navigation was a working one (GA
         * readiness report F01).
         */
        key: 'notifications',
        icon: IconBell,
        to: '/notifications',
        requires: P.notification.readOwn,
      },
    ],
  },
  {
    sectionKey: 'expenseManagement',
    moduleSlug: 'expense-management',
    items: [
      {
        /**
         * "My", explicitly, because this list is `submitterId = me` and nothing on it
         * said so. An approver looking for a report a colleague had submitted came here,
         * found their own reports, and concluded the submission had not arrived — it was
         * on the Approvals queue the whole time (UAT A6: "Kati could not see Naveed's
         * expense report in ExpenseOS status screen. I had to open the notification").
         * A list whose scope is invisible is read as the whole set.
         */
        key: 'expenseReports',
        icon: IconReceipt,
        to: '/expenses',
        requires: P.expense.report.readOwn,
      },
      {
        // AP's cross-report expense view. The same disjunction the page enforces —
        // read.all OR reimburse — because it exists to chase receipts AND to answer
        // "where is this charge", and a reader who holds only the first could reach
        // the page by URL while the menu pretended it wasn't there.
        key: 'allExpenses',
        icon: IconListSearch,
        to: '/expenses/all',
        requires: [P.expense.report.readAll, P.expense.report.reimburse],
      },
      {
        key: 'travelRequests',
        icon: IconPlane,
        to: '/travel',
        requires: P.travel.request.createOwn,
        // Travel is its own module, inside the expense-management section: a trip
        // is expense work, but an org can run expenses without pre-trip approval.
        moduleSlug: 'travel',
      },
      // Per-diem rates are config reference data — gated by the same
      // policy-read permission as the other reference-data items so the
      // section never shows an item to a user with no access to anything.
      {
        key: 'perDiemRates',
        icon: IconCoin,
        to: '/admin/per-diem-rates',
        requires: P.config.policyRead,
      },
      {
        key: 'fxRates',
        icon: IconArrowsExchange,
        to: '/admin/fx-rates',
        requires: P.config.policyRead,
      },
      {
        key: 'mileageRates',
        icon: IconCar,
        to: '/admin/mileage-rates',
        requires: P.config.policyRead,
      },
      // Expense-management config lookups. The whole section is already gated by
      // the expense-management module, so these don't need a per-item gate.
      {
        key: 'expenseCategories',
        icon: IconTags,
        to: '/admin/expense-categories',
        requires: P.admin.expenseCategory.list,
      },
      {
        // Travel's own taxonomy, gated on the TRAVEL module rather than expense
        // management: an org running pre-trip approval without expenses still curates
        // what a trip can be planned against.
        key: 'travelCategories',
        icon: IconPlane,
        to: '/admin/travel-categories',
        requires: P.admin.travelCategory.list,
        moduleSlug: 'travel',
      },
      {
        key: 'policyRules',
        icon: IconShieldCheck,
        to: '/admin/policy-rules',
        requires: P.config.policyRead,
      },
      {
        key: 'policyViolations',
        icon: IconAlertTriangle,
        to: '/admin/policy-violations',
        requires: P.config.policyRead,
      },
    ],
  },
  {
    sectionKey: 'vcc',
    moduleSlug: 'virtual-credit-cards',
    items: [
      {
        key: 'cardRequests',
        icon: IconClipboardList,
        to: '/virtual-cards/requests',
        requires: P.vcc.requestOwn,
      },
      {
        key: 'virtualCards',
        icon: IconCreditCard,
        to: '/virtual-cards',
        requires: P.vcc.requestOwn,
      },
      {
        key: 'cardTransactions',
        icon: IconReceipt2,
        to: '/virtual-cards/transactions',
        requires: P.vcc.requestOwn,
      },
      {
        key: 'cardStatements',
        icon: IconFileText,
        to: '/virtual-cards/statements',
        // AP-only: statements are an accounts-payable artifact (they span every
        // cardholder on an account), not a cardholder-facing surface.
        requires: P.vcc.transactionMatch,
      },
    ],
  },
  {
    sectionKey: 'approvals',
    // Approvals is part of Expense Management (it approves expense reports and
    // virtual cards) — it has no module of its own; it rides on the
    // expense-management module being active.
    moduleSlug: 'expense-management',
    items: [
      {
        /** Badged with what is waiting. The other half of A6: a manager had no reason to
         *  open this queue, because nothing anywhere said there was something in it. */
        key: 'approvalsQueue',
        icon: IconClipboardCheck,
        to: '/expenses/approvals',
        requires: P.expense.report.approve,
        badgeKey: 'pendingApprovals',
      },
      {
        key: 'delegations',
        icon: IconRefresh,
        to: '/delegations',
        requires: P.delegation.createOwn,
      },
    ],
  },
  {
    sectionKey: 'financeReporting',
    moduleSlug: 'finance-reporting',
    items: [
      {
        key: 'expenseAnalytics',
        icon: IconChartBar,
        to: '/analytics',
        // The gate on the SCREEN, not on whose rows appear once you are in it.
        requires: P.analytics.dashboardView,
      },
      { key: 'budgetTracking', icon: IconChartPie, to: '/budgets', requires: P.budget.read },
    ],
  },
  {
    sectionKey: 'complianceAudit',
    moduleSlug: 'compliance-audit',
    items: [
      {
        key: 'expensePolicies',
        icon: IconFileDescription,
        to: '/admin/policies',
        requires: P.config.policyRead,
      },
      { key: 'auditTrail', icon: IconFileText, to: '/admin/audit-trail', requires: P.audit.read },
      {
        key: 'fraudDetection',
        icon: IconAlertTriangle,
        to: '/admin/fraud-detection',
        requires: P.audit.fraudFlagReview,
      },
      {
        key: 'controlEvaluation',
        icon: IconShieldCheck,
        to: '/admin/control-evaluation',
        requires: P.audit.controlEvaluationRun,
      },
    ],
  },
  {
    sectionKey: 'administration',
    items: [
      {
        key: 'roleBuilder',
        icon: IconClipboardList,
        to: '/admin/roles',
        requires: P.admin.role.list,
      },
      {
        key: 'businessUnits',
        icon: IconBriefcase,
        to: '/admin/business-units',
        requires: P.admin.businessUnit.list,
      },
      {
        key: 'legalEntities',
        icon: IconBriefcase,
        to: '/admin/legal-entities',
        requires: P.admin.legalEntity.list,
      },
      {
        key: 'departments',
        icon: IconBriefcase,
        to: '/admin/departments',
        requires: P.admin.department.list,
      },
      // ── Extracted from the Platform Settings tab ──────────────────
      // Each lives at its own URL now; the in-card components
      // (`JobLevelsCard`, `FiscalYearsCard`, `ApprovalThresholdsCard`)
      // are re-exported from `admin/platform/PlatformAdmin.tsx` and
      // wrapped by these pages.
      {
        key: 'jobLevels',
        icon: IconBriefcase,
        to: '/admin/job-levels',
        requires: P.config.policyRead,
      },
      {
        key: 'fiscalYears',
        icon: IconBriefcase,
        to: '/admin/fiscal-years',
        requires: P.config.policyRead,
      },
      {
        /**
         * One entry for one destination, and it is no longer a log alone: `/admin/api-keys`
         * now mints platform keys as well as showing what they did, so `apiKeyLog` had
         * become a name for half the page. `apiManagement` — already translated in both
         * catalogs, orphaned since #334 — describes what is actually there.
         *
         * The disjunction matters as much as the label. The page admits
         * `admin.apiKey.create || admin.apiKey.list`, each half mounting its own section;
         * naming only `list` here would hide the menu entry from a `create`-only holder who
         * can open the page by URL and mint from it. That is the `/expenses/all` defect this
         * interface's `requires` doc describes, and it would be a fresh instance of it.
         */
        key: 'apiManagement',
        icon: IconBriefcase,
        to: '/admin/api-keys',
        requires: [P.admin.apiKey.create, P.admin.apiKey.list],
      },
      {
        // The assistant's review queue. Same permission as the rest of the help surface
        // (`admin.help.manage`), which existed and was seeded long before it had a screen.
        //
        // Module-gated as well as permission-gated: the page calls
        // `requireActiveModule('assistant')`, so on a workspace that has not installed
        // the chat this entry led straight to a 404 — which reads as a broken build
        // rather than as a module that isn't on. That is exactly what `moduleSlug` is
        // for; the permission alone was never enough.
        key: 'assistantFeedback',
        icon: IconBriefcase,
        to: '/admin/assistant-feedback',
        requires: P.admin.help.manage,
        // The literal, like every other entry here: this is a client component and
        // `@expenseos/assistant` carries the Anthropic SDK, which has no business in
        // the browser bundle just to name a slug.
        moduleSlug: 'assistant',
      },
      {
        // Covers email, Slack and the in-app bell — not email alone, which is
        // what the old "Email Notifications" placeholder implied.
        key: 'notificationTemplates',
        icon: IconMail,
        to: '/admin/notification-templates',
        requires: P.notification.templateUpdate,
      },
      /**
       * STILL no SECOND item for `/admin/api-keys`.
       *
       * `apiManagement` and `apiKeyLog` both pointed here once, with the same permission —
       * so Administration listed two entries going to the same place, one of them labelled
       * "API Management" for what was then a read-only request log. #334 removed four dead
       * links and left this duplicate (GA readiness report F01/F47).
       *
       * The page has since grown the platform-key mint form, so `apiManagement` is now the
       * accurate name and the entry above carries it. What has not changed is that there is
       * one destination, so there is one entry: `Sidebar.nav.test.ts` forbids two items
       * sharing a `to`, not just two sharing a key.
       */
      // ── Platform Admin (standalone pages, one per concern) ────────
      // Each landed on `/admin/platform?tab=…` until they were split
      // into dedicated pages so the navigation reads 1:1 with the URL.
      {
        key: 'modules',
        icon: IconPackages,
        to: '/admin/modules',
        requires: P.admin.module.view,
      },
      {
        key: 'integrations',
        icon: IconPlugConnected,
        to: '/admin/integrations',
        requires: P.admin.integration.view,
      },
      {
        key: 'authentication',
        icon: IconKey,
        to: '/admin/authentication',
        requires: P.admin.appSettings.update,
      },
      {
        key: 'approvalWorkflows',
        icon: IconClipboardList,
        to: '/admin/approval-workflows',
        requires: P.admin.approvalWorkflow.view,
      },
      {
        key: 'platformSettings',
        icon: IconSettings,
        to: '/admin/platform',
        requires: P.admin.appSettings.update,
      },
    ],
  },
  // ── NetSuite ──────────────────────────────────────────────────────
  // Integration-driven section. The `netsuite-gl` module gates it; that
  // module is provided by the NetSuite integration and declares
  // `requiresIntegrations: ['netsuite']`, so the section only appears once
  // the integration is installed + active and the module is activated.
  // Groups every NetSuite-specific surface: the sync dashboard, GL
  // Mappings (moved from Finance & Reporting), and the read-only
  // reference caches.
  {
    sectionKey: 'ledger',
    moduleSlug: 'ledger-gl',
    items: [
      {
        key: 'nsSyncDashboard',
        icon: IconRefresh,
        to: '/ledger/sync',
        requires: P.ledger.referenceView,
      },
      {
        key: 'nsPosting',
        icon: IconUpload,
        to: '/ledger/posting',
        // Deciding what reaches the ledger, not reading a cache.
        requires: P.ledger.syncPush,
      },
      {
        key: 'nsPeople',
        icon: IconUsers,
        to: '/ledger/people',
        // Ruling which system is right about a person, and writing the loser.
        requires: P.ledger.mappingManage,
      },
      {
        key: 'nsSettings',
        icon: IconSettings,
        to: '/ledger/settings',
        // The permission that lets you CHANGE something, not the one that lets you look.
        // These settings are the purchase-tax GL accounts: a reader can neither set them nor
        // act on knowing they are unset, so the entry was an invitation to a dead end — and it
        // read as the place to fix a posting failure that only an admin can fix.
        // The page keeps its own `referenceView` gate, so a direct link still opens read-only.
        requires: P.ledger.mappingManage,
      },
      {
        key: 'nsGlAccounts',
        icon: IconBriefcase,
        to: '/ledger/gl-accounts',
        requires: P.ledger.referenceView,
      },
      {
        key: 'nsVendors',
        icon: IconUsers,
        to: '/ledger/vendors',
        requires: P.ledger.referenceView,
      },
      {
        // The NetSuite side of the expense-category mapping. Same icon as the admin
        // Expense categories entry, so the two halves of one mapping read as a pair.
        key: 'nsExpenseCategories',
        icon: IconTags,
        to: '/ledger/expense-categories',
        requires: P.ledger.referenceView,
      },
      {
        key: 'nsClasses',
        icon: IconAdjustments,
        to: '/ledger/classes',
        requires: P.ledger.referenceView,
      },
      {
        key: 'nsDepartments',
        icon: IconBriefcase,
        to: '/ledger/departments',
        requires: P.ledger.referenceView,
      },
      {
        key: 'nsBusinessUnits',
        icon: IconBriefcase,
        to: '/ledger/business-units',
        requires: P.ledger.referenceView,
      },
      {
        key: 'nsSubsidiaries',
        icon: IconBriefcase,
        to: '/ledger/subsidiaries',
        requires: P.ledger.referenceView,
      },
      {
        key: 'nsLocations',
        icon: IconBriefcase,
        to: '/ledger/locations',
        requires: P.ledger.referenceView,
      },
      {
        key: 'nsTaxGroups',
        icon: IconBriefcase,
        to: '/ledger/tax-groups',
        requires: P.ledger.referenceView,
      },
    ],
  },
];

/** Map system-role id → i18n key under nav.profile.*. Custom roles fall
 *  back to the locale-resolved roleLabel on the session. The keys are
 *  the literal `SYSTEM_ROLE_IDS` values; we import them so a rotated id
 *  doesn't silently break the i18n lookup. */
const SYSTEM_ROLE_LABEL_KEYS: Record<string, string> = {
  [SYSTEM_ROLE_IDS.admin]: 'roleAdmin',
  [SYSTEM_ROLE_IDS['expense-administrator']]: 'roleExpenseAdmin',
  [SYSTEM_ROLE_IDS.employee]: 'roleEmployee',
  // Manager was folded into Employee. The RETIRED id is still mapped on purpose: a user
  // re-pointed by the migration reads as an Employee, but a deployment that has not yet
  // migrated — or an audit row naming the old role — would otherwise fall through to a raw
  // label. It resolves to the Employee wording, which is what the role now is.
  [RETIRED_ROLE_IDS.manager]: 'roleEmployee',
};

/**
 * Which of a set of nav destinations disappear below `lg`, and whether that empties the
 * section holding them.
 *
 * PURE, EXPORTED, AND TABLE-INJECTABLE — all three on purpose. The filter itself is two
 * lines; what is hard about it is the EMPTY-SECTION case, which is the one that ships
 * visibly broken: hide Administration's only phone-visible item and the section renders as a
 * labelled heading with nothing under it, on every phone, forever. That case needs a test,
 * and a test of it that depends on the SHIPPED registry is really a test of whatever
 * `MOBILE_READINESS` happens to hold this week — green today with one row, red the day a
 * page task rules a second. So `Sidebar.nav.test.ts` drives this with a table it builds,
 * in a node environment, with nothing rendered.
 */
export function phoneHiddenRoutes(
  routes: readonly string[],
  table: DispositionTable = MOBILE_READINESS,
): { hidden: ReadonlySet<string>; allHidden: boolean } {
  const hidden = new Set(
    routes.filter((to) => dispositionFor(to, table).disposition === 'desktop'),
  );
  // `routes.length > 0` guards the vacuous case: an empty section is already dropped by the
  // module/RBAC gate below, and reporting `allHidden` for it would attach `max-lg:hidden` to
  // something that does not render at all.
  return { hidden, allHidden: routes.length > 0 && hidden.size === routes.length };
}

/**
 * The initial value of the disclosure state, hoisted to module scope.
 *
 * `ReadonlySet` rather than `Set` is load-bearing, not fastidious: it makes `.add` and
 * `.delete` on the held state a type error, so the classic set-mutation no-op — mutate in
 * place, hand the same reference back, watch React bail out of the re-render — cannot
 * compile. Every toggle below copies.
 */
const EMPTY_SECTIONS: ReadonlySet<string> = new Set();

/**
 * WHO THE READER IS, as far as nav visibility is concerned — the three inputs `(app)/layout.tsx`
 * already resolves per request and threads into the shell.
 *
 * It is an interface rather than three positional arguments because every caller has all three
 * or none of them: a caller holding two of them is asking the wrong question, and would get a
 * confidently wrong answer. `canSeeOthers` is the one that bites — it is the ONLY gate on the
 * HOME `people` item (`/users`), which is itself `desktop`-ruled, so for a reader with no
 * admin, audit, config or NetSuite permission it is the single fact that decides whether they
 * lose anything below `lg` at all.
 */
export interface NavAudience {
  rbac: RbacUser;
  /** Hide /users from the sidebar when false (employee with no reports). */
  canSeeOthers: boolean;
  /** Slugs of modules that are installed + active. */
  activeModules: ReadonlySet<string>;
}

/** One surviving section, with what this reader loses from it below `lg`. */
export interface VisibleNavSection {
  section: NavSectionDef;
  idx: number;
  visible: NavItem[];
  phone: ReturnType<typeof phoneHiddenRoutes>;
  sectionId: string;
}

/**
 * The three gates, resolved once — the list the sidebar renders and the list the dashboard's
 * notice is derived from.
 *
 * LIFTED OUT OF THE RENDER rather than copied, because two readers now need the same answer and
 * a second copy of the gate that decides what the product LOOKS like it can do is the defect,
 * not the duplication. It is pure and takes its whole world as an argument, so it is callable
 * from anywhere that holds the audience — including a component that renders no sidebar.
 */
export function visibleNavSections({
  rbac,
  canSeeOthers,
  activeModules,
}: NavAudience): VisibleNavSection[] {
  return SECTIONS.map((section, idx) => {
    // A section shows only when its gating module is active (or it's a
    // core section with no module) AND at least one item passes RBAC.
    const moduleOn = !section.moduleSlug || activeModules.has(section.moduleSlug);
    const expenseOsVisible = moduleOn
      ? section.items.filter((item) => {
          if (item.key === 'people' && !canSeeOthers) return false;
          if (item.moduleSlug && !activeModules.has(item.moduleSlug)) return false;
          if (!item.requires) return true;
          return Array.isArray(item.requires)
            ? item.requires.some((p) => can(rbac, p))
            : can(rbac, item.requires as Permission);
        })
      : [];
    /**
     * VeloExpense: ExpenseOS's items at VeloExpense's paths, minus the ones with no screen
     * here yet, then VeloExpense's own screens for this section, each behind its own module
     * and permission gate rather than the section's. See `veloexpenseNav.ts`.
     */
    const visible: NavItem[] = [
      ...expenseOsVisible.flatMap((item) => {
        const to = veloExpenseRoute(item.to);
        return to === null ? [] : [{ ...item, to }];
      }),
      ...(VELOEXPENSE_ITEMS[section.sectionKey ?? ''] ?? []).filter(
        (item) =>
          (!item.moduleSlug || activeModules.has(item.moduleSlug)) && can(rbac, item.requires),
      ),
    ];
    /**
     * The FOURTH gate, and the only one expressed in CSS rather than in JavaScript.
     *
     * It has to be. This component renders TWICE — the persistent `lg:block` copy and the
     * off-canvas overlay — and the overlay is also the desktop nav when the reader unpins it.
     * Filtering a `desktop`-ruled item out in JavaScript would therefore delete it from the
     * DESKTOP nav of an unpinned 1280px window, which is the one place it is most certainly
     * usable. `max-lg:hidden` hides it exactly where it cannot be used and nowhere else, from
     * one render, with no viewport read anywhere.
     *
     * The per-section disclosure added below does NOT move this gate into JavaScript, and the
     * distinction is the whole of why it is legal. JavaScript decides nothing about which
     * items exist; it decides only whether the suppression CLASS sits on an item that is
     * rendered, in its authored position, either way. The invariant, from the architecture
     * ruling that settled the mechanism:
     *
     *   "JavaScript in the sidebar may only ever toggle a suppression class whose entire
     *    effect is confined to widths below `lg` (the `max-lg:*` variants). It may never
     *    mount, unmount, reorder or re-render a nav item, and never alter its `href`, its
     *    label, its icon or its active state. Consequently, at 1024px and above the rendered
     *    box tree and the accessibility tree are identical in every state of every
     *    disclosure … while below `lg` the only permitted effect is to reveal more than was
     *    revealed before, never less."
     *
     * That holds because the toggled class's entire declaration compiles into a
     * width-upper-bound media block — measured through this repo's own Tailwind:
     * `@media (width < 64rem) { .max-lg\:hidden { display: none; } }` — so adding or
     * removing it can change nothing at or above the breakpoint.
     */
    const phone = phoneHiddenRoutes(visible.map((i) => i.to));
    /**
     * One identity for the section, written once.
     *
     * It is the React key, the key into `expanded`, and the argument the toggle passes —
     * three uses that must never disagree, so they are one expression rather than three
     * copies of one. `idx` is the position in `SECTIONS` and is taken BEFORE the `.filter`
     * on the last line, so it is stable: a post-filter ordinal would shift the day a module
     * is switched off, silently handing one unlabelled section's open state to another.
     */
    const sectionId = section.sectionKey ?? `__top-${idx}`;
    return { section, idx, visible, phone, sectionId };
  }).filter((s) => s.visible.length > 0);
}

/**
 * Does THIS reader lose anything below `lg`?
 *
 * Split from `hasPhoneHiddenDestinations` below so the sidebar — which already holds the
 * filtered sections — answers the question from the list it built rather than building it a
 * second time, while a caller that holds only the audience gets the same answer from one
 * definition of the predicate. Two call sites, one `.some`.
 */
export function sectionsHidePhoneDestinations(sections: readonly VisibleNavSection[]): boolean {
  return sections.some((s) => s.phone.hidden.size > 0);
}

/**
 * THE PHASE-6 PREDICATE, and the reason it is exported rather than inlined at its one caller.
 *
 * `/dashboard` shows a small-screen notice, and it must be true for the reader being shown it:
 * ADR-0005 D7 — a signpost "must not announce a loss to a reader whose RBAC never entitled them
 * to the destination in the first place". The only honest source for that is the same
 * `SECTIONS` ∩ RBAC ∩ module ∩ registry pipeline the sidebar itself renders from, which is why
 * this composes `visibleNavSections` rather than reading `MOBILE_READINESS` directly.
 *
 * DERIVING IT FROM THE REGISTRY ALONE IS THE BUG THIS EXISTS TO PREVENT, and the architecture
 * ruling says so verbatim: "an enumeration must be derived from `SECTIONS` **intersected with**
 * the registry, **never from the registry alone**". `MOBILE_READINESS` carries no permission and
 * no module slug, so counting its `desktop` rows would fire this notice at every employee in the
 * company and tell each of them that a Role Builder exists which they cannot have.
 *
 * ONE MORE TRAP, SPECIFIC TO THE CALLER. This module is `'use client'`, so in the RSC graph every
 * export of it is a CLIENT REFERENCE: a server component that imports this function and calls it
 * gets "Attempted to call hasPhoneHiddenDestinations() from the server but ... it's on the
 * client" at request time (React's proxy, `react-server-dom-webpack-server.node.*.js`). Nothing
 * in this repo's test run catches that — Vitest applies no RSC transform, so `'use client'` is an
 * inert string literal there and a server-side call passes every unit test while failing on every
 * real page load. Hence the caller is `dashboard/SmallScreenNotice.tsx`, a CLIENT component that
 * the server page mounts with props, exactly as `(app)/layout.tsx` already hands these same three
 * values to `AppShell`.
 */
export function hasPhoneHiddenDestinations(audience: NavAudience): boolean {
  return sectionsHidePhoneDestinations(visibleNavSections(audience));
}

interface AppSidebarProps {
  user: Session['user'];
  rbac: RbacUser;
  /** Hide /users from the sidebar when false (employee with no reports). */
  canSeeOthers: boolean;
  /**
   * Slugs of modules that are installed + active. A section with a
   * `moduleSlug` is hidden unless its slug is in this set; core sections
   * (no `moduleSlug`) always pass the gate. Resolved server-side in
   * `(app)/layout.tsx` via `activeModuleSlugs`.
   */
  activeModules: ReadonlySet<string>;
  /** VeloExpense: the tenant's name, under the wordmark. Not in ExpenseOS (one tenant). */
  organizationName?: string;
}

export function AppSidebar({
  user,
  rbac,
  canSeeOthers,
  activeModules,
  organizationName,
}: AppSidebarProps) {
  const pathname = usePathname();
  const tSections = useTranslations('nav.sections');
  const tItems = useTranslations('nav.items');
  const tProfile = useTranslations('nav.profile');
  /** The nav namespace's own keys — the landmark's label and the small-screen footnote.
   *  Separate from the three bindings above, which are each scoped to a sub-block. */
  const tNav = useTranslations('nav');

  /**
   * How many approvals are waiting on this reader, beside the queue that holds them.
   *
   * An approver had no reason to open the Approvals queue, because nothing anywhere said
   * there was anything in it — so a submitted report was found only by opening its email
   * notification (UAT A6). `myTasks` is the same query the queue itself runs, so react-query
   * serves the page from this cache rather than fetching twice.
   *
   * Only asked for by somebody who can approve: an employee's nav would otherwise issue a
   * query whose answer is always zero, on every page load.
   */
  const canApprove = rbac.permissions.includes(P.expense.report.approve);
  const pendingTasks = trpc.expenseApprovals.myTasks.useQuery(undefined, {
    enabled: canApprove,
    // The count goes stale the moment somebody else decides one; a minute is close enough
    // for a signpost and cheap enough to run on every page.
    staleTime: 60_000,
  });
  const pendingApprovals = pendingTasks.data?.items.length || undefined;

  const roleLabelKey = SYSTEM_ROLE_LABEL_KEYS[user.roleId];
  const roleLabel = roleLabelKey ? tProfile(roleLabelKey) : user.roleLabel;
  // session.user.name is composed by the auth session callback from
  // firstName + lastName; fall through to email if it's empty.
  const displayName = user.name || user.email || 'User';

  /**
   * Which sections this reader has opened below `lg`, keyed by `sectionId`.
   *
   * Empty on every mount on purpose: the disclosure is a per-visit gesture, not a
   * preference, so nothing is persisted and nothing is read back. The off-canvas copy of
   * this component is mounted only while the drawer is open, so its state is created and
   * destroyed with the drawer; the persistent `lg:block` copy renders the same buttons but
   * they are `lg:hidden`, hence out of the box tree, the a11y tree and the tab order at
   * every width — so the two copies never need to agree.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(EMPTY_SECTIONS);

  /**
   * The three gates, resolved once, before anything renders — see `visibleNavSections`, which
   * is where this used to be inline and where its reasoning now lives. It was lifted when
   * `/dashboard` grew a notice that has to answer the same question from the same data.
   */
  const sections = visibleNavSections({ rbac, canSeeOthers, activeModules });

  /** Whether the footnote below would be telling the truth for THIS reader. An employee who
   *  cannot see `/admin/roles` in the first place must not be told something was hidden. */
  const anyPhoneHidden = sectionsHidePhoneDestinations(sections);

  return (
    <DSSidebar
      /**
       * The landmark's accessible name, from the catalog.
       *
       * The design-system `Sidebar` defaults it to the literal string 'Primary navigation',
       * which is a hardcoded user-facing string reaching a screen reader in both locales —
       * the repo rule covers `aria-label` explicitly. It is fixed HERE rather than in the
       * package because the package must stay locale-blind: `packages/design-system` has no
       * next-intl binding and should not grow one to name someone else's landmark.
       */
      ariaLabel={tNav('primaryNavigation')}
      header={
        <SidebarHeader
          logo={
            /* VeloExpense: VeloExpense's wordmark in place of ExpenseOS's E Inc. logo, with
               the organization's name under it (white-label: which tenant this window is).
               The name is tenant DATA, so `translate="no"`, and the pseudo-locale crawl
               skips it for the same reason. */
            <div className="flex flex-col items-center gap-2 pt-1">
              <Wordmark capHeight={14} />
              {organizationName ? (
                <p
                  className="max-w-full truncate text-xs font-medium"
                  style={{ color: 'var(--sidebar-section-color)' }}
                  data-testid="shell-org-name"
                  translate="no"
                >
                  {organizationName}
                </p>
              ) : null}
            </div>
          }
        />
      }
      footer={<ProfilePopover name={displayName} roleLabel={roleLabel} email={user.email} />}
    >
      {sections.map(({ section, visible, phone, sectionId }) => {
        const revealed = expanded.has(sectionId);
        return (
          <SidebarSection
            key={sectionId}
            label={section.sectionKey ? tSections(section.sectionKey) : undefined}
          >
            {visible.map((item) => (
              <Link
                key={item.key}
                href={item.to}
                className={cn(
                  'block no-underline',
                  phone.hidden.has(item.to) && !revealed && 'max-lg:hidden',
                )}
              >
                <NavLink
                  as="div"
                  label={tItems(item.key)}
                  icon={item.icon}
                  /**
                   * Plain route equality, and it has to stay plain.
                   *
                   * This carried a second clause — on `/dashboard`, highlight only
                   * `expenseReports` — from when `/dashboard` was a placeholder six items
                   * pointed at and a naive `to === pathname` lit two rows at once. Now that
                   * Dashboard is itself a nav item that clause is not merely obsolete, it is
                   * WRONG: on `/dashboard` it rejects the Dashboard row (its key is not
                   * `expenseReports`) and rejects `expenseReports` too (whose `to` is
                   * `/expenses`), so NOTHING highlights and the reader cannot tell where they
                   * are. It fails silently, which is why `Sidebar.test.tsx` now asserts
                   * exactly one active row rather than at most one.
                   */
                  active={item.to === pathname}
                  badge={item.badgeKey === 'pendingApprovals' ? pendingApprovals : undefined}
                />
              </Link>
            ))}
            {/*
             * The disclosure — and the reason the whole-section wrapper that used to live
             * here is gone.
             *
             * Until this change, a section whose every phone-visible item was hidden was
             * wrapped in `max-lg:hidden`, heading included, so ADMINISTRATION did not render
             * on a phone as a labelled heading with nothing under it (ADR-0005 D6). That
             * wrapper is deleted. What discharges the same obligation now is this button,
             * and it discharges it ONLY because it renders unconditionally wherever
             * `phone.hidden.size > 0`: an emptied section is never a bare heading, because
             * the control is always the thing under it.
             *
             * So the wrapper's deletion and this condition are ONE change, not two. Any
             * further gate here — a minimum count, `!phone.allHidden`, a flag — returns
             * ADMINISTRATION to a labelled heading with nothing under it on every phone,
             * which is the exact defect D6 exists to prevent. If you ever need to gate the
             * button, restore the wrapper in the same commit.
             *
             * `lg:hidden` here and `max-lg:hidden` on the `<Link>` above are literal strings
             * in the JSX and must stay literal, never template-assembled and never routed
             * through a variable: Tailwind v4 has no JS config and no safelist, it scans
             * source TEXT, so a class assembled at runtime emits no CSS at all — while the
             * element still carries the attribute, so `toHaveClass` passes, `lint` is silent
             * and `build` succeeds. Nothing in this repo enforces that; only this comment and
             * review do.
             */}
            {phone.hidden.size > 0 && (
              <button
                type="button"
                aria-expanded={revealed}
                onClick={() =>
                  setExpanded((prev) => {
                    // Updater form, so two taps batched into one React pass each resolve
                    // against the previous result rather than the snapshot this render
                    // closed over. Copy-on-write, because `prev` is a `ReadonlySet`.
                    const next = new Set(prev);
                    if (next.has(sectionId)) next.delete(sectionId);
                    else next.add(sectionId);
                    return next;
                  })
                }
                /* A REAL 44px BOX, NOT `einc-tap-slop`, and the difference is load-bearing here.
                   The slop recipe floors a `::after` at 44px centred on the control and
                   deliberately does NOT take `pointer-events: none` — receiving the pointer is
                   its whole mechanism (`globals.css`). On a ~28px control that ring overhangs
                   ~8px per side, and `globals.css` justifies the 44px floor by "a 6px slop
                   meet[ing] a 6px `gap-1.5` gutter at tangency". SIDEBAR ROWS HAVE NO GUTTER:
                   the preceding sibling is the section's last NavLink `<a>`, statically
                   positioned, while a slopped control is `position: relative` — so the ring
                   paints and hit-tests above it, and the bottom ~8px of "API Keys" or
                   "Delegations" would toggle this disclosure instead of navigating. P09 hit
                   the identical gutterless-stack case in `CityPicker` and took a real box for
                   the same reason: 44px of real box beats 44px of slop reaching over a
                   neighbour. Do not swap this back to `einc-tap-slop`. */
                className="pointer-coarse:min-h-11 w-full px-[18px] py-1.5 text-left text-[11px] lg:hidden"
                style={{ color: 'var(--sidebar-section-color)' }}
              >
                {/*
                 * The accessible name IS this text, and there is deliberately no `aria-label`
                 * beside it — one name that re-renders with the state cannot fall out of sync
                 * with `aria-expanded`, two names can. No `id` and no `aria-controls` either:
                 * the rows this reveals are interleaved siblings of rows that were always
                 * visible, so the only thing an idref could point at is the wrapper this same
                 * change deleted.
                 *
                 * `count` is what THIS reader lost in THIS section — post-RBAC, post-module,
                 * post-registry — never the product's global figure (ADR-0005 D7).
                 */}
                {tNav('sectionHiddenToggle', {
                  state: revealed ? 'expanded' : 'collapsed',
                  count: phone.hidden.size,
                })}
              </button>
            )}
          </SidebarSection>
        );
      })}
      {/*
       * The discoverability mitigation, and it is not decoration.
       *
       * Hiding nav entries is a real loss: a reader who knows the Role Builder exists, cannot
       * find it in the menu, and is told nothing will conclude the product lost it or that
       * their access was revoked. Naming the reason in words is the cheapest honest fix, and
       * leaving the loss silent is the dark pattern this line exists instead of.
       *
       * `lg:hidden`, so it is the small-screen nav's footnote and never the desktop nav's; and
       * conditional on something actually having been hidden FOR THIS READER, so it is never
       * a claim about a menu item they were never entitled to see.
       */}
      {anyPhoneHidden && (
        <p
          className="px-[18px] pt-3 pb-1 text-[11px] leading-snug lg:hidden"
          style={{ color: 'var(--sidebar-section-color)' }}
        >
          {tNav('moreOnLargerScreen')}
        </p>
      )}
    </DSSidebar>
  );
}
