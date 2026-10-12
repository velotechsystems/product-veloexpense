import { addBusinessDays, loadRequesterId, sweepExpiredTasks } from '@expenseos/approvals/engine';
import type { JobMap } from '@expenseos/jobs';
import { db, type TenantDb } from '@/lib/db/prisma';
import { queryRunnerOf } from '@/lib/db/prisma-pg-bridge';
import { recallLadderSubmissions, recordReportOutcome } from '@/lib/expenses/lifecycle';
import type { EventType } from '@/lib/notifications/catalog';
import {
  notifyRecipients as notifyServiceRecipients,
  recordActivity as recordServiceActivity,
  reportPayload,
} from '@/lib/notifications/service';

/**
 * Handler for `approval.sweepExpired`. Runs on a cron:
 *  1. Expire overdue tasks via the engine (escalate / reject / approve per the
 *     node's onExpire policy) and fan out a TASK_EXPIRED activity.
 *  2. Send "deadline approaching" reminders for tasks due within one business
 *     day that haven't been reminded yet.
 * Generic over subjects: the requester is resolved per subject type via the
 * engine's loadRequesterId, so VCC requests and expense reports both fan out.
 *
 * An expense report this sweep approves (onExpire=APPROVE) is offered to NetSuite the
 * same way a manager's approval is: through the post-on-approval rule, which sends only
 * under `postingTrigger: AUTOMATIC`. This used to be the one approval path with no hook,
 * left to the half-hourly unposted-report sweep — which still catches it if the enqueue
 * here is dropped.
 *
 * Ported from ExpenseOS's `apps/worker/src/handlers/approval-sweep.ts` (550b2945), w4-00c.
 * VeloExpense, each marked below:
 *   · it runs for ONE tenant, the one its payload names (`inTenant`, worker/src/main.ts); the
 *     schedule's own run only fans out (`fanOutToTenants`). The engine's sweep runs in one
 *     tenant transaction (`db.$transaction`), because it takes a savepoint per task;
 *   · a report the sweep APPROVES or REJECTS reaches its outcome through
 *     `recordReportOutcome` — budgets, history, the ledger post, the audit row as
 *     `system:approval.sweepExpired` — inside that task's savepoint, so the outcome and its
 *     consequences commit together. ExpenseOS posts after the fact and keeps a half-hourly
 *     sweep for a dropped post; VeloExpense queues the post on the transition and has none;
 *   · the activities carry the report's placeholders (`reportPayload`) and go through
 *     VeloExpense's notification service;
 *   · FIRST, the cutover's recall (d52, `recallLadderSubmissions`): a report still SUBMITTED
 *     on the retired approval ladder goes back to DRAFT. Idempotent, and nothing to do after
 *     the first run.
 */
export async function handleApprovalSweep(_data: JobMap['approval.sweepExpired']): Promise<void> {
  // VeloExpense (d52): the ladder's leftovers, before anything else reads a report's state.
  const recalled = await db.$transaction((tx) => recallLadderSubmissions(queryRunnerOf(tx)));

  // VeloExpense: one tenant transaction for the engine's per-task savepoints, and each
  // report's outcome recorded inside its task's savepoint.
  const results = await db.$transaction((tx) =>
    sweepExpiredTasks(tx, new Date(), async (r) => {
      if (r.subjectType !== 'EXPENSE_REPORT') return;
      if (r.outcome !== 'APPROVED' && r.outcome !== 'REJECTED') return;
      await recordReportOutcome(queryRunnerOf(tx), {
        reportId: r.subjectId,
        outcome: r.outcome,
        actor: { system: 'approval.sweepExpired' },
        note: null,
        context: { expired: true },
      });
    }),
  );
  let escalated = 0;
  let resolved = 0;
  for (const r of results) {
    if (r.outcome === 'SKIPPED') continue;
    if (r.outcome === 'ESCALATED') escalated += 1;
    else resolved += 1;
    try {
      const activity = await recordActivity(db, {
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        type: 'TASK_EXPIRED',
        actorId: null,
        payload: { outcome: r.outcome },
      });
      const requesterId = await loadRequesterId(db, r.subjectType, r.subjectId);
      const recipients = new Set<string>();
      if (requesterId) recipients.add(requesterId);
      if (r.outcome === 'ESCALATED' && r.reassignedTo) recipients.add(r.reassignedTo);
      await notifyRecipients(db, activity.id, [...recipients]);
    } catch (err) {
      console.warn('[approval.sweep] expiry fan-out failed', r.subjectId, err);
    }
    // VeloExpense: no post here — `recordReportOutcome` queued it on the transition, above.
  }

  const reminded = await sendDeadlineReminders();
  console.log(
    `[approval.sweep] expired: ${escalated} escalated, ${resolved} resolved; reminders: ${reminded}` +
      // VeloExpense (d52): said only when it did something.
      (recalled > 0 ? `; recalled from the ladder: ${recalled}` : ''),
  );
}

/** Remind the current approver of tasks due within one business day. Sets
 *  deadlineReminderAt so a task is reminded at most once. Returns the count. */
async function sendDeadlineReminders(): Promise<number> {
  const now = new Date();
  const horizon = addBusinessDays(now, 1);
  const due = await db.approvalTask.findMany({
    where: {
      status: 'PENDING',
      deadlineReminderAt: null,
      expiresAt: { not: null, gt: now, lte: horizon },
      instance: { status: 'RUNNING' },
    },
    select: {
      id: true,
      assigneeUserId: true,
      instance: { select: { subjectId: true, subjectType: true } },
    },
    take: 500,
  });
  let count = 0;
  for (const t of due) {
    try {
      await db.approvalTask.update({
        where: { id: t.id },
        data: { deadlineReminderAt: now },
      });
      if (!t.assigneeUserId) continue; // unassigned filter task — no single recipient
      const activity = await recordActivity(db, {
        subjectType: t.instance.subjectType,
        subjectId: t.instance.subjectId,
        type: 'DEADLINE_NEAR',
        actorId: null,
      });
      await notifyRecipients(db, activity.id, [t.assigneeUserId]);
      count += 1;
    } catch (err) {
      console.warn('[approval.sweep] reminder failed', t.id, err);
    }
  }
  return count;
}

/** VeloExpense: ExpenseOS's `recordActivity`, through VeloExpense's notification service, with
 *  an expense report's placeholders on every report activity. */
async function recordActivity(
  client: TenantDb,
  entry: {
    subjectType: string;
    subjectId: string;
    type: EventType;
    actorId: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<{ id: string }> {
  let placeholders: Record<string, string> = {};
  if (entry.subjectType === 'EXPENSE_REPORT') {
    const r = await client.expenseReport.findUnique({
      where: { id: entry.subjectId },
      select: { title: true, number: true, totalMinor: true, currencyId: true },
    });
    if (r) {
      placeholders = reportPayload({
        title: r.title,
        number: r.number,
        totalMinor: r.totalMinor,
        currencyCode: r.currencyId,
      });
    }
  }
  const id = await recordServiceActivity(queryRunnerOf(client), {
    subjectType: 'EXPENSE_REPORT',
    subjectId: entry.subjectId,
    eventType: entry.type,
    actorId: entry.actorId,
    payload: { ...placeholders, ...(entry.payload ?? {}) },
  });
  return { id };
}

/** VeloExpense: ExpenseOS's `notifyRecipients`, through VeloExpense's notification service. */
async function notifyRecipients(client: TenantDb, activityId: string, recipients: string[]) {
  await notifyServiceRecipients(queryRunnerOf(client), activityId, recipients);
}
