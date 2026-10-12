/**
 * Shared eligibility resolution for expense-report approval — used by the
 * approver surfaces (the approvals inbox drawer and the workbench in approver
 * mode) and by `expenses.report` to admit an eligible approver as a reader.
 *
 * Authorization mirrors the VCC / `expenseApprovals` model: being an eligible
 * (assigned or claimable) approver of a PENDING task on the report's running
 * instance IS the authorization — there's no blanket "approve" permission.
 *
 * VeloExpense (w4-00c): ExpenseOS's module, replacing the adapter that asked VeloExpense's
 * approval ladder the same question until the cutover. It reads the report's
 * `approval_instance_id` (0059) and the engine's tasks, as ExpenseOS does.
 */
import { canDecide } from '@expenseos/approvals/engine';
import type { Prisma, PrismaClient } from '@expenseos/db';

/** VeloExpense: the caller's tenant transaction, or the scoped client. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The first PENDING task on `reportId`'s running approval instance that
 * `userId` may decide — or, with `mayOverride` (the `expense.report.decide.any`
 * grant), any of them but their own. Returns `null` when the report has no
 * running instance or the caller has no decidable task. The returned id is
 * exactly what `expenseApprovals.decide` expects.
 *
 * `mayOverride` MUST be the override permission, not a read permission: this is
 * what puts Approve / Reject / Return on the workbench, and the mutation behind
 * those buttons asks the same question with the same flag. Feed it `read.all`
 * and an AP clerk gets buttons that either 403 or, worse, work.
 */
export async function resolveDecidableTask(
  db: Db,
  reportId: string,
  userId: string,
  mayOverride: boolean,
): Promise<string | null> {
  const report = await db.expenseReport.findUnique({
    where: { id: reportId },
    select: { approvalInstanceId: true },
  });
  if (!report?.approvalInstanceId) return null;
  const tasks = await db.approvalTask.findMany({
    where: { instanceId: report.approvalInstanceId, status: 'PENDING' },
    select: { id: true },
  });
  for (const task of tasks) {
    if (await canDecide(db, task.id, userId, mayOverride)) return task.id;
  }
  return null;
}

/**
 * True when `userId` may decide on `reportId` — an eligible approver of a PENDING task
 * on the report's running instance, which an override holder is for anyone's report but
 * their own.
 *
 * The `isAdmin` short-circuit that used to stand here made this DISAGREE with the
 * mutation it guards: the page offered Approve on the strength of a role, while
 * `expenseApprovals.decide` asks the engine. Once the engine started refusing a
 * requester their own subject, that gap became a button that fails when pressed — so
 * the question is asked in one place, and both surfaces get the same answer.
 */
export async function callerCanDecideReport(
  db: Db,
  reportId: string,
  userId: string,
  mayOverride: boolean,
): Promise<boolean> {
  return (await resolveDecidableTask(db, reportId, userId, mayOverride)) != null;
}
