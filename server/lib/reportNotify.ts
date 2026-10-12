/**
 * Expense-report notification fan-out — the report counterpart to vccDecide's
 * notify path. The `expenseApprovals` router already records the audited
 * decision via the engine; these helpers layer the activity-stream + in-app /
 * email / Slack fan-out on top (best-effort, fire-and-forget):
 *   - a terminal decision (APPROVED/REJECTED) notifies the submitter,
 *   - newly-parked tasks notify the next approvers,
 *   - submit / return / reimburse notify the submitter or the first approvers.
 *
 * Unlike VCC, expense reports get NO one-click approve/reject in email/Slack:
 * an approver must open the report to review its receipts and line items, so
 * notifications are deep-link-only (see notification-dispatch.issueActions,
 * which already returns no actions for non-VCC subjects).
 *
 * VeloExpense: ExpenseOS's module (`server/lib/reportNotify.ts`, 550b2945), w4-00c. The
 * plumbing, each marked below:
 *   · AWAITED, inside the caller's tenant transaction, where ExpenseOS fires and forgets
 *     after the commit: VeloExpense records every notification on the transaction that
 *     caused it, and the outbox delivers (`lib/notifications/service.ts`). It stays
 *     best-effort — each fan-out runs under a savepoint, and a failure rolls back to it and
 *     is logged, so a downed notifier still never undoes the decision it follows;
 *   · VeloExpense's events: a submit tells the first approvers TASK_ASSIGNED (VeloExpense
 *     has no SUBMITTED event, by design — NT-15), and the activity carries the report's
 *     placeholders (`reportPayload`) and, on a decision or a return, the approver's note;
 *   · VeloExpense keeps one-click approve in email for TASK_ASSIGNED (d57: its /approve page
 *     stays), so the dispatcher, not this module, decides what a message offers;
 *   · a reassignment ALSO tells the submitter, with the reason (d37) — ExpenseOS tells only
 *     the new assignee.
 */
import type { TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import type { EventType } from '@/lib/notifications/catalog';
import {
  notifyRecipients as notifyServiceRecipients,
  recordActivity as recordServiceActivity,
  reportPayload,
} from '@/lib/notifications/service';
import { taskRecipientIds } from '@/server/approvals/notify';

/** VeloExpense: the caller's tenant transaction. */
type PrismaClient = TenantDb;

const SUBJECT = 'EXPENSE_REPORT' as const;

/** VeloExpense: the submitter, and the placeholders every report message reads. */
async function reportFacts(
  db: PrismaClient,
  reportId: string,
): Promise<{ submitterId: string; payload: Record<string, string> } | null> {
  const r = await db.expenseReport.findUnique({
    where: { id: reportId },
    select: { submitterId: true, title: true, number: true, totalMinor: true, currencyId: true },
  });
  if (!r) return null;
  return {
    submitterId: r.submitterId,
    payload: reportPayload({
      title: r.title,
      number: r.number,
      totalMinor: r.totalMinor,
      currencyCode: r.currencyId,
    }),
  };
}

/** VeloExpense: ExpenseOS's `recordActivity` — the activity, with the report's placeholders,
 *  on the caller's transaction. Returns its id. */
async function recordActivity(
  db: PrismaClient,
  entry: { subjectId: string; type: EventType; actorId: string; extra?: Record<string, string> },
): Promise<{ id: string }> {
  const facts = await reportFacts(db, entry.subjectId);
  const id = await recordServiceActivity(queryRunnerOf(db), {
    subjectType: SUBJECT,
    subjectId: entry.subjectId,
    eventType: entry.type,
    actorId: entry.actorId,
    payload: { ...(facts?.payload ?? {}), ...(entry.extra ?? {}) },
  });
  return { id };
}

/** VeloExpense: ExpenseOS's `notifyRecipients`, on the caller's transaction. */
async function notifyRecipients(db: PrismaClient, activityId: string, recipients: string[]) {
  await notifyServiceRecipients(queryRunnerOf(db), activityId, recipients);
}

/**
 * VeloExpense: ExpenseOS's `void (async () => …)().catch(warn)`, inside a transaction. A
 * failed statement aborts the whole transaction in Postgres, so the containment is a
 * savepoint: roll back to it, log, and let the decision commit.
 */
async function bestEffort(db: PrismaClient, label: string, fn: () => Promise<void>): Promise<void> {
  await db.$executeRaw`SAVEPOINT report_notify`;
  try {
    await fn();
    await db.$executeRaw`RELEASE SAVEPOINT report_notify`;
  } catch (e) {
    await db.$executeRaw`ROLLBACK TO SAVEPOINT report_notify`;
    console.warn(`[report] ${label} fan-out failed`, e);
  }
}

async function submitterOf(db: PrismaClient, reportId: string): Promise<string | null> {
  const r = await db.expenseReport.findUnique({
    where: { id: reportId },
    select: { submitterId: true },
  });
  return r?.submitterId ?? null;
}

/** Fan out an approver's decision: notify the submitter on a terminal outcome,
 *  and the next approvers on any newly-parked tasks. Fire-and-forget.
 *
 *  VeloExpense: awaited (see the header), and the approver's note travels with it. */
export async function notifyReportDecision(
  db: PrismaClient,
  res: { status: string; subjectId: string; createdTaskIds: string[] },
  actorId: string,
  note: string | null = null,
): Promise<void> {
  await bestEffort(db, 'decision', async () => {
    if (res.status === 'APPROVED' || res.status === 'REJECTED') {
      const activity = await recordActivity(db, {
        subjectId: res.subjectId,
        type: res.status,
        actorId,
        extra: { note: note ?? '' },
      });
      const submitterId = await submitterOf(db, res.subjectId);
      if (submitterId && submitterId !== actorId) {
        await notifyRecipients(db, activity.id, [submitterId]);
      }
    }
    if (res.createdTaskIds.length > 0) {
      const activity = await recordActivity(db, {
        subjectId: res.subjectId,
        type: 'TASK_ASSIGNED',
        actorId,
      });
      const approvers = await taskRecipientIds(db, res.createdTaskIds);
      await notifyRecipients(
        db,
        activity.id,
        approvers.filter((id) => id !== actorId),
      );
    }
  });
}

/** On submit that parked approval tasks (a workflow matched), notify the first
 *  approvers. No-op when the report auto-approved (no tasks). Fire-and-forget.
 *
 *  VeloExpense: as TASK_ASSIGNED — VeloExpense has no SUBMITTED event (see the header). */
export async function notifyReportSubmitted(
  db: PrismaClient,
  reportId: string,
  actorId: string,
  createdTaskIds: string[],
): Promise<void> {
  if (createdTaskIds.length === 0) return;
  await bestEffort(db, 'submit', async () => {
    const activity = await recordActivity(db, {
      subjectId: reportId,
      type: 'TASK_ASSIGNED',
      actorId,
    });
    const approvers = await taskRecipientIds(db, createdTaskIds);
    await notifyRecipients(
      db,
      activity.id,
      approvers.filter((id) => id !== actorId),
    );
  });
}

/** Notify the submitter that their report was returned for edits.
 *  VeloExpense: with the approver's note. */
export async function notifyReportReturned(
  db: PrismaClient,
  reportId: string,
  actorId: string,
  note: string | null = null,
): Promise<void> {
  await notifySubmitterEvent(db, reportId, actorId, 'RETURNED', { note: note ?? '' });
}

/** On recall (submitter withdrew a submitted report), tell the approvers whose
 *  pending tasks were just cancelled so their inbox item disappearing is
 *  explained. No-op when the report had no parked tasks. Fire-and-forget. */
export async function notifyReportRecalled(
  db: PrismaClient,
  reportId: string,
  actorId: string,
  cancelledTaskIds: string[],
): Promise<void> {
  if (cancelledTaskIds.length === 0) return;
  await bestEffort(db, 'recall', async () => {
    const activity = await recordActivity(db, {
      subjectId: reportId,
      type: 'RECALLED',
      actorId,
    });
    const approvers = await taskRecipientIds(db, cancelledTaskIds);
    await notifyRecipients(
      db,
      activity.id,
      approvers.filter((id) => id !== actorId),
    );
  });
}

/** Notify the submitter that their approved report was marked reimbursed. */
export async function notifyReportReimbursed(
  db: PrismaClient,
  reportId: string,
  actorId: string,
): Promise<void> {
  await notifySubmitterEvent(db, reportId, actorId, 'REIMBURSED');
}

/** On manual reassignment, tell the new assignee they now own a pending task.
 *  Records a TASK_ASSIGNED activity and notifies the new assignee only (never
 *  the actor who reassigned). Fire-and-forget.
 *
 *  VeloExpense (d37): and, when a reason is given, the submitter — a REASSIGNED activity
 *  with the reason and who now holds it, which the report's discussion shows. */
export async function notifyReportReassigned(
  db: PrismaClient,
  reportId: string,
  actorId: string,
  newAssigneeId: string,
  why: { note: string; assigneeName: string } | null = null,
): Promise<void> {
  await bestEffort(db, 'reassign', async () => {
    if (newAssigneeId !== actorId) {
      const activity = await recordActivity(db, {
        subjectId: reportId,
        type: 'TASK_ASSIGNED',
        actorId,
      });
      await notifyRecipients(db, activity.id, [newAssigneeId]);
    }
    if (why) {
      const activity = await recordActivity(db, {
        subjectId: reportId,
        type: 'REASSIGNED',
        actorId,
        extra: { note: why.note, assignee: why.assigneeName, assigneeId: newAssigneeId },
      });
      const submitterId = await submitterOf(db, reportId);
      if (submitterId && submitterId !== actorId) {
        await notifyRecipients(db, activity.id, [submitterId]);
      }
    }
  });
}

async function notifySubmitterEvent(
  db: PrismaClient,
  reportId: string,
  actorId: string,
  type: EventType,
  extra: Record<string, string> = {},
): Promise<void> {
  await bestEffort(db, 'submitter', async () => {
    const activity = await recordActivity(db, { subjectId: reportId, type, actorId, extra });
    const submitterId = await submitterOf(db, reportId);
    if (submitterId && submitterId !== actorId) {
      await notifyRecipients(db, activity.id, [submitterId]);
    }
  });
}
