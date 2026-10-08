/**
 * Route → nav-catalog key for the title the top bar renders.
 *
 * Its own module, with no client imports, for one reason: the invariant that every
 * sidebar destination titles itself is asserted in `Sidebar.nav.test.ts`, which runs
 * in a node environment. `TopBar.tsx` cannot be imported there — it reaches
 * next-intl's client navigation, the notification bell and the assistant launcher —
 * so the data the test needs lives here instead of behind them.
 */

export const ROUTE_TITLE_KEYS: Record<string, string> = {
  '/travel': 'travelRequests',
  '/notifications': 'notifications',
  '/delegations': 'delegations',
  '/profile': 'myProfile',
  '/users': 'people',
  // Its own title, not Expense Reports'. `/dashboard` mapped to `expenseReports`, so the
  // dashboard announced itself as a different page entirely (GA readiness report F03).
  '/dashboard': 'dashboard',
  '/expenses': 'expenseReports',
  // Explicit, because `/expenses` would otherwise claim it by prefix and the two
  // screens would carry the same title.
  '/expenses/all': 'allExpenses',
  '/expenses/approvals': 'approvalsQueue',
  '/virtual-cards': 'virtualCards',
  '/virtual-cards/requests': 'cardRequests',
  '/virtual-cards/transactions': 'cardTransactions',
  '/virtual-cards/statements': 'cardStatements',
  '/virtual-cards/import': 'cardImport',
  '/virtual-cards/import-cards': 'cardProfileImport',
  '/admin/roles': 'roleBuilder',
  '/admin/business-units': 'businessUnits',
  '/admin/legal-entities': 'legalEntities',
  '/admin/departments': 'departments',
  // Title + the "Add category" top-bar action coexist (same as /users → People).
  '/admin/expense-categories': 'expenseCategories',
  '/admin/travel-categories': 'travelCategories',
  '/admin/job-levels': 'jobLevels',
  // Not 'apiKeyLog' any more: the page mints platform keys as well as showing what they
  // did, so a title reading "API Request Log" over a mint form named half the screen.
  '/admin/api-keys': 'apiManagement',
  '/admin/assistant-feedback': 'assistantFeedback',
  '/admin/fiscal-years': 'fiscalYears',
  '/admin/per-diem-rates': 'perDiemRates',
  '/budgets': 'budgetTracking',
  '/admin/fx-rates': 'fxRates',
  '/admin/mileage-rates': 'mileageRates',
  '/admin/modules': 'modules',
  '/admin/integrations': 'integrations',
  '/admin/authentication': 'authentication',
  '/admin/platform': 'platformSettings',
  '/admin/approval-workflows': 'approvalWorkflows',
  '/admin/notification-templates': 'notificationTemplates',
  '/admin/audit-trail': 'auditTrail',
  '/admin/fraud-detection': 'fraudDetection',
  '/admin/control-evaluation': 'controlEvaluation',
  '/admin/policies': 'expensePolicies',
  '/admin/policy-rules': 'policyRules',
  '/admin/policy-violations': 'policyViolations',
  '/ledger/sync': 'nsSyncDashboard',
  '/ledger/posting': 'nsPosting',
  '/ledger/people': 'nsPeople',
  '/ledger/settings': 'nsSettings',
  '/ledger/gl-accounts': 'nsGlAccounts',
  '/ledger/vendors': 'nsVendors',
  '/ledger/expense-categories': 'nsExpenseCategories',
  '/ledger/classes': 'nsClasses',
  '/ledger/business-units': 'nsBusinessUnits',
  '/ledger/departments': 'nsDepartments',
  '/ledger/subsidiaries': 'nsSubsidiaries',
  '/ledger/locations': 'nsLocations',
  '/ledger/tax-groups': 'nsTaxGroups',
};

/**
 * The catalog key naming `pathname`, or `null` when no route claims it.
 *
 * Longest match wins. `/expenses/approvals` and `/expenses` both match the second,
 * and a shortest-first match would title the approvals queue "Expense reports" — so
 * the order of the map is not allowed to matter. The corollary is the trap this
 * function exists to make visible: a route with NO entry silently inherits the title
 * of any entry it sits under, so `/expenses/all` read "My Expense Reports" until it
 * was listed in its own right.
 */
export function titleKeyForPath(pathname: string): string | null {
  const matched = Object.keys(ROUTE_TITLE_KEYS)
    .sort((a, b) => b.length - a.length)
    .find((route) => pathname === route || pathname.startsWith(`${route}/`));
  return matched ? ROUTE_TITLE_KEYS[matched] : null;
}
