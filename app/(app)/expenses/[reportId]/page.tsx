import { permissions as P } from '@expenseos/rbac';
import { forbidden } from 'next/navigation';
import { withTenantDb } from '@/lib/db/prisma';
import { pageTitle } from '@/lib/i18n/page-title';
import { resolveDecidableTask } from '@/server/lib/reportApproval';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { ExpenseReportWorkbench } from './ExpenseReportWorkbench';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.expenses.report');
}

/**
 * /expenses/[reportId] — the three-pane expense-report workbench (Module 4).
 * Same gating as the list: module `expense-management` + read-own; the write
 * affordances (edit / delete / submit) are gated per-permission and passed to
 * the client, which mirrors them cosmetically — the tRPC procedures re-check.
 *
 * Ported from ExpenseOS (550b2945). VeloExpense: the session and `RbacUser` come from the
 * request's shell context (server/shell.ts) rather than `auth()` plus `resolveRbacUser(db, …)`,
 * the decidable-task lookup runs in the caller's tenant transaction (`withTenantDb`), and a
 * reader with neither read-own nor a decidable task is REFUSED (`forbidden()`, a 403 that
 * says why), as every VeloExpense screen refuses, where ExpenseOS answers 404 — the same
 * adaptation as /expenses and /expenses/all. An inactive module is still a 404.
 */
export default async function ExpenseReportPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('expense-management');
  const { rbac, user } = shell;
  // Approver mode: if the caller has a decidable PENDING task on this report,
  // the workbench swaps the submitter controls for Approve / Reject / Return
  // and admits them as a reader even when it isn't their own report. The
  // override is `decide.any` — the same flag `expenseApprovals.decide` checks —
  // never `read.all`, which shows the queue and must not decide it.
  const mayOverride = rbac.permissions.includes(P.expense.report.decideAny);
  const taskId = await withTenantDb(user.organizationId, (tx) =>
    resolveDecidableTask(tx, reportId, user.id, mayOverride),
  );
  const canApprove = taskId != null;
  if (!rbac.permissions.includes(P.expense.report.readOwn) && !canApprove) forbidden();
  return (
    <ExpenseReportWorkbench
      reportId={reportId}
      canEdit={rbac.permissions.includes(P.expense.report.updateOwn)}
      canDelete={rbac.permissions.includes(P.expense.report.deleteDraft)}
      canSubmit={rbac.permissions.includes(P.expense.report.submitOwn)}
      canApprove={canApprove}
      // Restating a report's FX is its own grant, apart from paying it: the AP Clerk
      // pays and posts, and must not also decide the amounts. Cosmetic — the mutation
      // re-checks.
      canFxOverride={rbac.permissions.includes(P.expense.report.fxOverride)}
      // VeloExpense (d38): the ledger post is queued by the approval itself, and retrying,
      // releasing or cancelling it is /admin/ledger-queue's (audited there). The workbench
      // shows the post's state and, to whoever may retry it, a link to that queue.
      // Cosmetic — the queue page re-checks.
      canOpenLedgerQueue={rbac.permissions.includes(P.ledger.syncRetry)}
      taskId={taskId ?? undefined}
    />
  );
}
