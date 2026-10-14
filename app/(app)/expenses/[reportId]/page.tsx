import { permissions as P } from '@expenseos/rbac';
import { forbidden, notFound } from 'next/navigation';
import { z } from 'zod';
import { withTenantDb } from '@/lib/db/prisma';
import { pageTitle } from '@/lib/i18n/page-title';
import {
  callerCanDecideReport,
  canViewReport,
  resolveDecidableTaskWithLabel,
} from '@/server/lib/reportApproval';
import { requireActiveModule } from '@/server/platform/guard';
import { shellContext } from '@/server/shell';
import { ExpenseReportWorkbench } from './ExpenseReportWorkbench';

// VeloExpense: UD-16 — every route names itself (scripts/check-page-titles.mjs).
export function generateMetadata() {
  return pageTitle('title.expenses.report');
}

/** The route segment is a report id, and report ids are UUIDs (`@default(uuid(7))`). */
const reportIdSchema = z.string().uuid();

/**
 * /expenses/[reportId] — the three-pane expense-report workbench (Module 4).
 *
 * WHO GETS IN is `canViewReport`, the one read rule every surface that hangs off a report
 * asks — the approvals drawer, `expenses.report` and its explain reads, the comment thread.
 * The page asks the same question so it can never admit somebody whose data call then
 * 404s, nor turn away somebody the drawer would show the same report to. That includes a
 * direct manager opening a subordinate's draft by URL. Anyone else — and an id that names
 * no report — gets the same not-found, so the page cannot be used to learn which ids exist.
 *
 * WHAT THEY MAY DO is narrower than what they may read. Edit, delete and submit are offered
 * to the submitter only: the server's rule for writing a report is ownership, not the
 * permission alone, so a manager or AP clerk holding `updateOwn` must not be shown controls
 * every one of which would be refused. Cosmetic — each tRPC procedure re-checks.
 *
 * Ported from ExpenseOS (1e682dd6, #573). VeloExpense: the session and `RbacUser` come from
 * the request's shell context (server/shell.ts) rather than `auth()` plus
 * `resolveRbacUser(db, …)`, and the reads run in the caller's tenant transaction
 * (`withTenantDb`). With no session the page is refused (`forbidden()`), as every VeloExpense
 * screen is; a report the reader may not see is ExpenseOS's not-found, deliberately not
 * VeloExpense's 403, because a 403 would tell a stranger the id exists. An inactive module is
 * still a 404. The ledger link replaces ExpenseOS's NetSuite push (d38).
 */
export default async function ExpenseReportPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  // Before any read: Prisma throws on a non-UUID against a uuid column, which would be a
  // 500 rather than the 404 every other unknown id gets.
  if (!reportIdSchema.safeParse(reportId).success) notFound();
  const shell = await shellContext();
  if (!shell) forbidden();
  await requireActiveModule('expense-management');
  const { rbac, user } = shell;
  const userId = user.id;
  const has = (permission: (typeof rbac.permissions)[number]) =>
    rbac.permissions.includes(permission);

  const access = await withTenantDb(user.organizationId, async (db) => {
    const report = await db.expenseReport.findUnique({
      where: { id: reportId },
      select: { id: true, submitterId: true, approvalInstanceId: true },
    });
    if (!report || !(await canViewReport(db, report, userId, rbac.permissions))) return null;
    const isSubmitter = report.submitterId === userId;

    // Approver mode, resolved only for somebody already admitted: if the caller has a
    // decidable PENDING task on this report, the workbench swaps the submitter controls for
    // Approve / Reject / Return. The override is `decide.any` — the same flag
    // `expenseApprovals.decide` checks — never `read.all`, which shows the queue and must not
    // decide it.
    const mayOverride = has(P.expense.report.decideAny);
    const task = await resolveDecidableTaskWithLabel(db, reportId, userId, mayOverride);
    const taskId = task?.id ?? null;
    const canApprove = taskId != null;
    // The label is the workflow node's type, written by the engine (`nodeLabel`), and the
    // engine refuses anything but an approve on an `acknowledge` task — so this only picks
    // which single button to offer.
    const isAcknowledge = task?.label === 'acknowledge';

    // Who may press Mark reimbursed and Request receipts. Both cosmetic: `markReimbursed`
    // is `withPermission(reimburse)` and checks the status; `chaseReceipts` skips any report
    // the caller may not chase. The chase rule is that procedure's, mirrored:
    // `readAll || reimburse || a decidable task asked WITHOUT the override` — a task held
    // only through `decide.any` does not let the procedure chase, so it must not show the
    // button either. Never the submitter: chasing yourself for your own receipts is noise.
    const canReimburse = has(P.expense.report.reimburse);
    const canChase =
      !isSubmitter &&
      (has(P.expense.report.readAll) ||
        canReimburse ||
        (mayOverride ? await callerCanDecideReport(db, reportId, userId, false) : canApprove));
    return { isSubmitter, taskId, canApprove, isAcknowledge, canReimburse, canChase };
  });
  if (!access) notFound();
  const { isSubmitter, taskId, canApprove, isAcknowledge, canReimburse, canChase } = access;
  return (
    <ExpenseReportWorkbench
      reportId={reportId}
      isSubmitter={isSubmitter}
      canEdit={isSubmitter && has(P.expense.report.updateOwn)}
      canDelete={isSubmitter && has(P.expense.report.deleteDraft)}
      canSubmit={isSubmitter && has(P.expense.report.submitOwn)}
      canApprove={canApprove}
      isAcknowledge={isAcknowledge}
      canReimburse={canReimburse}
      canChase={canChase}
      // Restating a report's FX is its own grant, apart from paying it: the AP Clerk
      // pays and posts, and must not also decide the amounts. Cosmetic — the mutation
      // re-checks.
      canFxOverride={has(P.expense.report.fxOverride)}
      // VeloExpense (d38): the ledger post is queued by the approval itself, and retrying,
      // releasing or cancelling it is /admin/ledger-queue's (audited there). The workbench
      // shows the post's state and, to whoever may retry it, a link to that queue.
      // Cosmetic — the queue page re-checks.
      canOpenLedgerQueue={has(P.ledger.syncRetry)}
      taskId={taskId ?? undefined}
    />
  );
}
