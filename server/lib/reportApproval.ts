/**
 * Who may read an expense report, and which of its tasks the caller may decide —
 * one definition each, shared by every surface that hangs off a report: the
 * approvals drawer (`expenseApprovals.report`), the report page and its reads
 * (`expenses.report`, `explainTax`, `explainPerDiem`), and the report's comment
 * thread (`comments`).
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
import { permissions as P } from '@expenseos/rbac';

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
  return (await resolveDecidableTaskWithLabel(db, reportId, userId, mayOverride))?.id ?? null;
}

/**
 * `resolveDecidableTask`, with the task's `label` beside its id — the same task, found
 * the same way, under the same `mayOverride` rule (read the warning above).
 *
 * The label is the workflow node's type (`approve`, `acknowledge`, …), written by the
 * engine when it materialises the task, never text an admin typed. It is for choosing
 * which actions to offer; the engine still enforces what a task of that type may do.
 */
export async function resolveDecidableTaskWithLabel(
  db: Db,
  reportId: string,
  userId: string,
  mayOverride: boolean,
): Promise<{ id: string; label: string | null } | null> {
  const report = await db.expenseReport.findUnique({
    where: { id: reportId },
    select: { approvalInstanceId: true },
  });
  if (!report?.approvalInstanceId) return null;
  const tasks = await db.approvalTask.findMany({
    where: { instanceId: report.approvalInstanceId, status: 'PENDING' },
    select: { id: true, label: true },
  });
  for (const task of tasks) {
    if (await canDecide(db, task.id, userId, mayOverride)) {
      return { id: task.id, label: task.label };
    }
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

/** Is `userId` the direct manager of `subordinateId`? */
async function isDirectManagerOf(db: Db, userId: string, subordinateId: string): Promise<boolean> {
  const u = await db.user.findUnique({
    where: { id: subordinateId },
    select: { managerId: true },
  });
  return u?.managerId === userId;
}

/**
 * True when `userId` may READ `report`. THE read rule for an expense report: the drawer,
 * the report page, the reads that hang off the report and its comment thread all ask
 * this, so none of them can disagree with another — a disagreement would be one surface
 * showing what another hides.
 *
 * Deliberately wider than deciding, which only looks at PENDING tasks: reading and
 * deciding are different questions, and conflating them meant a report became invisible
 * to its own approver the moment they decided it (the "Decided by me" list rendered rows
 * that 403'd on open). Readers are:
 *   - an admin (`readAll`), an AP reimburser, or the submitter — the submitter needs no
 *     `readOwn` here; the report is theirs;
 *   - the submitter's DIRECT MANAGER, whoever the workflow routed to — tier routing,
 *     escalation and delegation move the decision, never the manager's line of sight.
 *     Status is not looked at, so this includes the subordinate's drafts;
 *   - anyone a task is/was assigned to, or who decided one;
 *   - anyone currently eligible to decide, asked without the override: holding
 *     `decide.any` does not by itself make a reader.
 *
 * Reading is not writing. Who may WRITE a line is the submitter or the expense's owner
 * (`assertExpenseWritable`), and `expenses.report` trims what it sends any other reader.
 *
 * VeloExpense (eos-573): ExpenseOS moved this here from `expenseApprovals.ts` (#573), and so
 * does VeloExpense. One difference, kept from VeloExpense's own copy (w2-02a, w4-00c): the
 * tasks looked at are those of EVERY approval of the report, not only `approvalInstanceId`'s,
 * which a resubmission repoints — so an approver who returned a report can still read it,
 * and follow its thread, once it is resubmitted.
 */
export async function canViewReport(
  db: Db,
  report: { id: string; submitterId: string; approvalInstanceId: string | null },
  userId: string,
  perms: readonly string[],
): Promise<boolean> {
  if (perms.includes(P.expense.report.readAll) || perms.includes(P.expense.report.reimburse)) {
    return true;
  }
  if (report.submitterId === userId) return true;
  if (await isDirectManagerOf(db, userId, report.submitterId)) return true;
  // VeloExpense: every approval of the report (see above), not `approvalInstanceId` alone.
  const involved = await db.approvalTask.findFirst({
    where: {
      instance: { subjectType: 'EXPENSE_REPORT', subjectId: report.id },
      OR: [{ assigneeUserId: userId }, { decidedById: userId }],
    },
    select: { id: true },
  });
  if (involved) return true;
  return callerCanDecideReport(db, report.id, userId, false);
}
