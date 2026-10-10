import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { AllExpensesList } from './AllExpensesList';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.expenses.all');
}

/**
 * /expenses/all — AP's cross-report expense view.
 *
 * Deliberately crosses submitters, so it's AP/admin only: `expense.report.
 * read.all` or `expense.report.reimburse`. The server re-checks on every query;
 * this gate only decides whether the page renders.
 *
 * Ported from ExpenseOS (550b2945). VeloExpense: the session and `RbacUser` come from the
 * request's shell context (server/shell.ts) rather than `auth()` plus `resolveRbacUser(db, …)`,
 * and a reader without either permission is REFUSED (`forbidden()`, a 403 that says why), as
 * every VeloExpense screen refuses, where ExpenseOS answers 404 — the same adaptation as
 * /expenses. An inactive module is still a 404, as in ExpenseOS.
 */
export default async function AllExpensesPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('expense-management');
  const { rbac } = shell;
  const canView =
    rbac.permissions.includes(P.expense.report.readAll) ||
    rbac.permissions.includes(P.expense.report.reimburse);
  if (!canView) forbidden();

  return <AllExpensesList />;
}
