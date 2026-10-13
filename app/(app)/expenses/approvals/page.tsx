import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { ExpenseApprovalsInbox } from './ExpenseApprovalsInbox';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs), each with a
// key of its own; /approvals, which now redirects here (d71), keeps `title.approvals`.
export function generateMetadata() {
  return pageTitle('title.expenses.approvals');
}

/**
 * /expenses/approvals — the approver's expense-report inbox. Module-gated on
 * `expense-management`; visible to anyone who can approve, return, or reimburse
 * (AP). Per-task decide authority is eligibility-based and re-checked on the
 * server — this page gate only decides whether the inbox is shown at all.
 * Title rides on the TopBar (`ROUTE_TITLE_KEYS['/expenses/approvals']`).
 *
 * Ported from ExpenseOS (550b2945) in place of VeloExpense's /approvals (w4-05/w4-07, d71).
 * VeloExpense: the session and `RbacUser` come from the request's shell context
 * (server/shell.ts) rather than `auth()` plus `resolveRbacUser(db, …)`, and a reader with none
 * of the three permissions is REFUSED (`forbidden()`, a 403 that says why), as every
 * VeloExpense screen refuses, where ExpenseOS answers 404. An inactive module is still a 404.
 */
export default async function ExpenseApprovalsPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('expense-management');
  const { rbac } = shell;
  const canApprove = rbac.permissions.includes(P.expense.report.approve);
  const canReimburse = rbac.permissions.includes(P.expense.report.reimburse);
  const canReadAll = rbac.permissions.includes(P.expense.report.readAll);
  if (!canApprove && !canReimburse && !canReadAll) forbidden();
  return <ExpenseApprovalsInbox canReimburse={canReimburse} />;
}
