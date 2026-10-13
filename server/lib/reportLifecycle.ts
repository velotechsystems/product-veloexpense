/**
 * VeloExpense: the report's transitions, for the ported procedures. Not in ExpenseOS.
 *
 * Submit and recall (d23) hand their transition to VeloExpense's `lib/expenses/lifecycle.ts`,
 * which re-runs the policy pass under a lock, writes the status, starts or cancels the approval
 * on ExpenseOS's engine (w4-00c), recomputes the budgets and writes the audit chain — the jobs
 * ExpenseOS's `expenses.submit` / `expenses.recall` do in the router.
 *
 * The approver's decide / return / reassign (d36) run here on ExpenseOS's engine (w4-00c), with
 * ExpenseOS's procedure bodies (`expenseApprovals.ts`, 550b2945) and VeloExpense's plumbing
 * around them, each marked:
 *   · the BILLING GATE first (VX5-11): a lapsed subscription is a different refusal from "not
 *     yours", and the person who can act on it is not the approver;
 *   · the REPORT ROW LOCKED before the task is read (`report-lock.db.test.ts`): submit, recall
 *     and every edit take the report row first, so a recall and a decision queue behind each
 *     other instead of both proceeding on stale reads;
 *   · an outcome goes through `recordReportOutcome` — budgets, history, the ledger post, the
 *     audit row — in this transaction, where ExpenseOS's routers call `postApprovedReport`
 *     after it;
 *   · notifications and workflow effects are awaited inside the transaction, each under its
 *     own savepoint (`reportNotify.ts`, `workflowEffects.ts`), where ExpenseOS fires and
 *     forgets.
 * One function per action, so the tRPC procedure, the /approvals form and the emailed
 * /approve link decide the same way. They throw `DomainError`s, which a procedure passes
 * through `toTrpcError` and a page renders as it renders any refusal.
 *
 * The lifecycle speaks `DomainError`; a procedure speaks `TRPCError`. `toTrpcError` is the
 * one translation: the refusal's catalogued sentence (en-CA) becomes the message — what
 * ExpenseOS's procedures put there — and its code becomes the nearest tRPC code. An error
 * that is not ours is rethrown untouched, so `safeMessage` still launders it.
 */
import { decideTask, type DecideResult } from '@expenseos/approvals/engine';
import { auditActions, writeAudit } from '@expenseos/audit';
import { TRPCError } from '@trpc/server';
import { assertTenantMayWrite } from '@/lib/billing/gate';
import type { TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { DomainError, encodeUserMessage } from '@/lib/errors/domain';
import {
  LifecycleError,
  recallReport,
  recordReportOutcome,
  submitReport,
} from '@/lib/expenses/lifecycle';
import type { UserMessageCode } from '@/lib/i18n/catalog/errors';
import { renderUserMessage } from '@/lib/i18n/catalog/errors';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { resolveDecideAccess } from '@/server/lib/decideAccess';
import { callerCanDecideReport } from '@/server/lib/reportApproval';
import {
  notifyReportDecision,
  notifyReportReassigned,
  notifyReportReturned,
} from '@/server/lib/reportNotify';
import { executeWorkflowEffects } from '@/server/lib/workflowEffects';

type TrpcCode = ConstructorParameters<typeof TRPCError>[0]['code'];

const LIFECYCLE_CODES: Record<LifecycleError['code'], TrpcCode> = {
  NOT_FOUND: 'NOT_FOUND',
  WRONG_STATUS: 'BAD_REQUEST',
  EMPTY_REPORT: 'PRECONDITION_FAILED',
  UNDATED: 'PRECONDITION_FAILED',
  UNCODED: 'PRECONDITION_FAILED',
  BLOCKED_BY_POLICY: 'PRECONDITION_FAILED',
  UNJUSTIFIED_WARNING: 'PRECONDITION_FAILED',
  NO_WORKFLOW: 'PRECONDITION_FAILED',
  NO_APPROVER: 'PRECONDITION_FAILED',
  FORBIDDEN: 'FORBIDDEN',
};

/** Why an approver's action was refused. */
export type ReportDecisionErrorCode =
  | 'TASK_NOT_FOUND'
  | 'ALREADY_DECIDED'
  | 'NOT_SUBMITTED'
  | 'FORBIDDEN'
  | 'BAD_ASSIGNEE';

const DECISION_CODES: Record<ReportDecisionErrorCode, TrpcCode> = {
  TASK_NOT_FOUND: 'NOT_FOUND',
  ALREADY_DECIDED: 'BAD_REQUEST',
  NOT_SUBMITTED: 'BAD_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
  BAD_ASSIGNEE: 'BAD_REQUEST',
};

/** VeloExpense: an approver's action refused, with the sentence the reader sees. */
export class ReportDecisionError extends DomainError {
  constructor(
    message: string,
    readonly code: ReportDecisionErrorCode,
    userMessage: UserMessageCode,
  ) {
    super(message, userMessage);
    this.name = 'ReportDecisionError';
  }
}

/** A lifecycle, decision or billing refusal as the `TRPCError` a ported procedure throws. */
export function toTrpcError(err: unknown): unknown {
  if (!(err instanceof DomainError)) return err;
  const code: TrpcCode =
    err instanceof LifecycleError
      ? LIFECYCLE_CODES[err.code]
      : err instanceof ReportDecisionError
        ? DECISION_CODES[err.code]
        : err.name === 'BillingLapsedError'
          ? 'FORBIDDEN'
          : 'PRECONDITION_FAILED';
  const message = err.userMessage
    ? renderUserMessage(encodeUserMessage(err.userMessage), DEFAULT_LOCALE)
    : err.message;
  return new TRPCError({ code, message, cause: err });
}

/** DRAFT | RETURNED → SUBMITTED, on VeloExpense's lifecycle. */
export async function submitThroughLifecycle(
  db: TenantDb,
  reportId: string,
  actorId: string,
  /** w4-02d: the policy pass the lifecycle runs under its lock (`SubmitOptions`). */
  policyPass?: () => Promise<unknown>,
) {
  try {
    return await submitReport(queryRunnerOf(db), reportId, actorId, { policyPass });
  } catch (err) {
    throw toTrpcError(err);
  }
}

/** SUBMITTED | RETURNED → DRAFT, on VeloExpense's lifecycle. */
export async function recallThroughLifecycle(db: TenantDb, reportId: string, actorId: string) {
  try {
    return await recallReport(queryRunnerOf(db), reportId, actorId);
  } catch (err) {
    throw toTrpcError(err);
  }
}

/* ── the approver's actions ────────────────────────────────────────────────── */

/** The acting member, as the audit chain names them. */
async function auditActorOf(db: TenantDb, actorId: string) {
  const u = await db.user.findUnique({
    where: { id: actorId },
    select: { name: true, email: true, role: true },
  });
  return {
    kind: 'user' as const,
    id: actorId,
    name: u?.name || u?.email || actorId,
    roleLabel: u?.role ?? '',
  };
}

/**
 * VeloExpense: the report under a task, LOCKED until COMMIT, and the task's state read
 * after the lock — so a recall that got there first is seen, not raced. Refuses a task that
 * is gone or no longer PENDING, in the words the reader sees.
 */
async function lockTask(db: TenantDb, taskId: string) {
  const found = await db.approvalTask.findUnique({
    where: { id: taskId },
    select: { instance: { select: { subjectId: true } } },
  });
  if (!found) {
    throw new ReportDecisionError(`approval task ${taskId} not found`, 'TASK_NOT_FOUND', 'TASK_WITHDRAWN');
  }
  const reportId = found.instance.subjectId;
  await db.$queryRaw`SELECT id FROM expense_report WHERE id = ${reportId}::uuid FOR UPDATE`;
  const task = await db.approvalTask.findUnique({
    where: { id: taskId },
    select: { status: true, assigneeUserId: true, instance: { select: { status: true } } },
  });
  if (!task || task.status === 'SKIPPED' || task.instance.status === 'CANCELLED') {
    throw new ReportDecisionError(
      `approval task ${taskId} was withdrawn`,
      'TASK_NOT_FOUND',
      'TASK_WITHDRAWN',
    );
  }
  if (task.status !== 'PENDING') {
    throw new ReportDecisionError(
      `approval task ${taskId} is already decided`,
      'ALREADY_DECIDED',
      'TASK_ALREADY_DECIDED',
    );
  }
  return { reportId, assigneeUserId: task.assigneeUserId };
}

/** Refuse an actor who may not decide the task — the submitter in the words for that. */
async function refuseUndecidable(db: TenantDb, reportId: string, taskId: string, actorId: string) {
  const report = await db.expenseReport.findUnique({
    where: { id: reportId },
    select: { submitterId: true },
  });
  if (report?.submitterId === actorId) {
    throw new ReportDecisionError(
      `the submitter may not decide report ${reportId}`,
      'FORBIDDEN',
      'SELF_APPROVAL',
    );
  }
  throw new ReportDecisionError(
    `user ${actorId} may not decide approval task ${taskId}`,
    'FORBIDDEN',
    'TASK_NOT_YOURS',
  );
}

/**
 * Approve or reject one task — ExpenseOS's `expenseApprovals.decide` body after its fast
 * refusals: `resolveDecideAccess`, the audited `decideTask`, then the decision's fan-out
 * (`notifyReportDecision`), the workflow's effects and, on the terminal decision, the report's
 * outcome.
 *
 * VeloExpense, besides the plumbing in the header: the audit action is chosen from the
 * outcome. A decision that ends the approval is REPORT_APPROVED / REPORT_REJECTED (with the
 * budgets, history and ledger post, `recordReportOutcome`); one step of several is
 * APPROVAL_STEP_APPROVED / _REJECTED. ExpenseOS writes `report.approve` either way, so its log
 * cannot tell a report approved from a report one signature further along.
 *
 * `context` rides into the audit row — the emailed link says `via: 'email'`.
 */
export async function decideThroughEngine(
  db: TenantDb,
  input: {
    taskId: string;
    actorId: string;
    approve: boolean;
    note: string | null;
    mayOverride: boolean;
    context?: Record<string, unknown>;
  },
): Promise<DecideResult & { override: boolean }> {
  await assertTenantMayWrite(queryRunnerOf(db), 'decide an approval');
  const { reportId } = await lockTask(db, input.taskId);
  const access = await resolveDecideAccess(db, input.taskId, input.actorId, input.mayOverride);
  if (!access.allowed) await refuseUndecidable(db, reportId, input.taskId, input.actorId);

  const res = await decideTask(db, input.taskId, input.approve, input.actorId, input.note);
  const details = {
    taskId: input.taskId,
    note: input.note,
    override: access.override,
    ...(input.context ?? {}),
  };
  if (res.status === 'RUNNING') {
    await writeAudit(db, {
      action: input.approve ? auditActions.report.stepApprove : auditActions.report.stepReject,
      entityType: 'expense_report',
      entityId: res.subjectId,
      actor: await auditActorOf(db, input.actorId),
      details,
    });
  } else {
    await recordReportOutcome(queryRunnerOf(db), {
      reportId: res.subjectId,
      outcome: res.status,
      actor: { userId: input.actorId },
      note: input.note,
      context: details,
    });
  }
  await notifyReportDecision(db, res, input.actorId, input.note);
  await executeWorkflowEffects(db, {
    subjectType: 'EXPENSE_REPORT',
    subjectId: res.subjectId,
    effectNodeIds: res.firedEffects,
    actorId: input.actorId,
  });
  return { ...res, override: access.override };
}

/**
 * Return a submitted report to its submitter for edits — ExpenseOS's
 * `expenseApprovals.returnForEdit` body after its fast refusals: the eligibility check (with
 * the override recorded as one), the running instance CANCELLED and its pending tasks
 * SKIPPED, the report RETURNED, the submitter told.
 *
 * VeloExpense: the report is locked and must still be SUBMITTED under the lock; the outcome
 * goes through `recordReportOutcome` (budgets, history, REPORT_RETURNED); the submitter is
 * told with the approver's note.
 */
export async function returnThroughEngine(
  db: TenantDb,
  input: { reportId: string; actorId: string; note: string | null; mayOverride: boolean },
): Promise<{ id: string; status: 'RETURNED' }> {
  await assertTenantMayWrite(queryRunnerOf(db), 'decide an approval');
  await db.$queryRaw`SELECT id FROM expense_report WHERE id = ${input.reportId}::uuid FOR UPDATE`;
  const report = await db.expenseReport.findUnique({
    where: { id: input.reportId },
    select: { id: true, status: true, approvalInstanceId: true, submitterId: true },
  });
  if (!report || report.status !== 'SUBMITTED') {
    throw new ReportDecisionError(
      `report ${input.reportId} is not awaiting approval`,
      'NOT_SUBMITTED',
      'REPORT_NOT_AWAITING_APPROVAL',
    );
  }
  // Eligible on one of the report's pending tasks, or holding the override — and the
  // audit row says which. Asked without the override first so an eligible approver
  // who also happens to hold it is recorded as the approver they are.
  const eligible = await callerCanDecideReport(db, input.reportId, input.actorId, false);
  const override =
    !eligible &&
    input.mayOverride &&
    // VeloExpense: the override still never lets a submitter return their own report.
    report.submitterId !== input.actorId;
  if (!eligible && !override) {
    throw new ReportDecisionError(
      `user ${input.actorId} may not return report ${input.reportId}`,
      'FORBIDDEN',
      report.submitterId === input.actorId ? 'SELF_APPROVAL' : 'TASK_NOT_YOURS',
    );
  }
  if (report.approvalInstanceId) {
    await db.approvalTask.updateMany({
      where: { instanceId: report.approvalInstanceId, status: 'PENDING' },
      data: { status: 'SKIPPED' },
    });
    await db.approvalInstance.update({
      where: { id: report.approvalInstanceId },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
  }
  await db.expenseReport.update({
    where: { id: report.id },
    data: { status: 'RETURNED' },
    select: { id: true },
  });
  await recordReportOutcome(queryRunnerOf(db), {
    reportId: report.id,
    outcome: 'RETURNED',
    actor: { userId: input.actorId },
    note: input.note,
    context: { override },
  });
  await notifyReportReturned(db, report.id, input.actorId, input.note);
  return { id: report.id, status: 'RETURNED' };
}

/**
 * Hand a pending task to somebody else — ExpenseOS's `expenseApprovals.reassign` body after
 * its fast refusals: authorized like a decision (`resolveDecideAccess`), the target an active
 * employee, the task's assignee changed, audited, the new assignee told.
 *
 * VeloExpense's rules on top (d36, d37), as its ladder had them:
 *   · a REASON is required, and goes into the audit row and to the submitter (REASSIGNED);
 *   · the SUBMITTER is refused as a target — `canDecide` would never let them act on it, so
 *     the task would park on somebody who cannot decide it;
 *   · the person who already holds it is refused, rather than recorded as a hand-off.
 */
export async function reassignThroughEngine(
  db: TenantDb,
  input: { taskId: string; actorId: string; toUserId: string; note: string; mayOverride: boolean },
): Promise<{ reportId: string; fromUserId: string | null; toUserId: string }> {
  await assertTenantMayWrite(queryRunnerOf(db), 'decide an approval');
  const { reportId, assigneeUserId } = await lockTask(db, input.taskId);
  const access = await resolveDecideAccess(db, input.taskId, input.actorId, input.mayOverride);
  if (!access.allowed) await refuseUndecidable(db, reportId, input.taskId, input.actorId);

  const target = await db.user.findFirst({
    where: { id: input.toUserId, deletedAt: null, employeeStatus: 'ACTIVE' },
    select: { id: true, name: true, email: true },
  });
  if (!target) {
    throw new ReportDecisionError('unknown or inactive assignee', 'BAD_ASSIGNEE', 'REASSIGN_TARGET_UNKNOWN');
  }
  const report = await db.expenseReport.findUnique({
    where: { id: reportId },
    select: { submitterId: true },
  });
  if (report?.submitterId === input.toUserId) {
    throw new ReportDecisionError(
      'a report cannot be handed to its own submitter to approve',
      'BAD_ASSIGNEE',
      'REASSIGN_TARGET_SUBMITTER',
    );
  }
  if (assigneeUserId === input.toUserId) {
    throw new ReportDecisionError(
      'that person already holds this approval',
      'BAD_ASSIGNEE',
      'REASSIGN_TARGET_SAME',
    );
  }
  const reason = input.note.trim();
  if (!reason) {
    throw new ReportDecisionError(
      'a reassignment needs a reason',
      'BAD_ASSIGNEE',
      'REASSIGN_REASON_REQUIRED',
    );
  }

  await db.approvalTask.update({
    where: { id: input.taskId },
    data: { assigneeUserId: input.toUserId },
  });
  await writeAudit(db, {
    action: auditActions.report.reassign,
    entityType: 'expense_report',
    entityId: reportId,
    actor: await auditActorOf(db, input.actorId),
    details: {
      taskId: input.taskId,
      fromUserId: assigneeUserId,
      toUserId: input.toUserId,
      note: reason,
      override: access.override,
    },
  });
  await notifyReportReassigned(db, reportId, input.actorId, input.toUserId, {
    note: reason,
    assigneeName: target.name || target.email,
  });
  return { reportId, fromUserId: assigneeUserId, toUserId: input.toUserId };
}
