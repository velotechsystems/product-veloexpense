import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { pageTitle } from '@/lib/i18n/page-title';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { ApprovalWorkflowsAdmin } from './ApprovalWorkflowsAdmin';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.admin.approval.workflows');
}

/**
 * /admin/approval-workflows — manage approval workflows (metadata + publish).
 * Graph authoring lives in the per-workflow editor (Phase C2). Title resolves
 * via `ROUTE_TITLE_KEYS['/admin/approval-workflows']` ('approvalWorkflows').
 *
 * Ported from ExpenseOS (550b2945), w4-01. VeloExpense: the session and `RbacUser` come from
 * the request's shell context (server/shell.ts) rather than `auth()` plus
 * `resolveRbacUser(db, …)`, and a reader without the permission is REFUSED (`forbidden()`),
 * as every VeloExpense admin screen refuses, where ExpenseOS answers 404. An inactive
 * module is a 404, as for the other expense-management admin screens.
 */
export default async function ApprovalWorkflowsPage() {
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('expense-management');
  const { rbac } = shell;
  if (!rbac.permissions.includes(P.admin.approvalWorkflow.view)) forbidden();
  return (
    <ApprovalWorkflowsAdmin
      canManage={rbac.permissions.includes(P.admin.approvalWorkflow.manage)}
    />
  );
}
