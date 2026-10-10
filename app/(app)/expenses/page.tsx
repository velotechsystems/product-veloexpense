import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { ExpenseReportsList } from './ExpenseReportsList';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.expenses');
}

/**
 * /expenses — Expense Reports list (Module 4). Module-gated on
 * `expense-management`; requires read-own. The write affordances (create /
 * edit / delete / submit) are gated per-permission and passed to the client,
 * which mirrors them cosmetically — the server procedures re-check.
 * Title rides on the TopBar (`ROUTE_TITLE_KEYS['/expenses']` → expenseReports).
 *
 * Ported from ExpenseOS (550b2945), replacing VeloExpense's own list page (d25). VeloExpense:
 * the session and `RbacUser` come from the request's shell context (server/shell.ts) — the
 * same resolution the tRPC `tenant` middleware makes — rather than `auth()` plus
 * `resolveRbacUser(db, …)`; and a reader without the permission is REFUSED (`forbidden()`,
 * a 403 that says why), as every VeloExpense screen refuses, where ExpenseOS answers 404. An
 * inactive module is still a 404, as in ExpenseOS. The list is the caller's own reports, as
 * ExpenseOS's is; the org-wide view comes back as /expenses/all (w2-06, d32).
 */
export default async function ExpensesPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('expense-management');
  const { rbac } = shell;
  if (!rbac.permissions.includes(P.expense.report.readOwn)) forbidden();
  return (
    <ExpenseReportsList
      canCreate={rbac.permissions.includes(P.expense.report.createOwn)}
      canDelete={rbac.permissions.includes(P.expense.report.deleteDraft)}
    />
  );
}
