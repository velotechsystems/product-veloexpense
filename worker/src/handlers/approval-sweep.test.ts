// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cron that makes an approval deadline mean something.
 *
 * Two jobs in one pass, and the failure modes are opposites:
 *
 *   · **Expiry** already happened in the engine by the time this runs. The fan-out is
 *     how anybody FINDS OUT, so it must not be able to take the sweep down: one
 *     unreachable recipient cannot be allowed to leave the rest of the batch
 *     un-notified, which is why each subject is fanned out inside its own try.
 *   · **Reminders** are the opposite risk — sending twice. `deadlineReminderAt` is
 *     stamped BEFORE the notification goes out, so a crash mid-fan-out costs one lost
 *     reminder rather than a nightly repeat until the deadline passes.
 *
 * And SKIPPED results are counted as neither: a task the engine looked at and left alone
 * has not expired, and reporting it as resolved would make the sweep's numbers describe
 * nothing that happened.
 *
 * VeloExpense (w4-00c): ExpenseOS's suite, with the mocks moved to VeloExpense's modules
 * (`@/lib/db/prisma`, the notification service, the lifecycle). Its "offered to NetSuite"
 * cases become the report's OUTCOME — recorded through `recordReportOutcome`, inside the
 * engine's sweep, for an approval AND a rejection.
 */

const h = vi.hoisted(() => ({
  swept: [] as Array<Record<string, unknown>>,
  due: [] as Array<Record<string, unknown>>,
  requesterId: 'req-1' as string | null,
  activityError: null as Error | null,
  updateError: null as Error | null,
  activities: [] as Array<Record<string, unknown>>,
  notified: [] as Array<{ activityId: string; recipients: string[] }>,
  updated: [] as Array<Record<string, unknown>>,
  taskWhere: undefined as Record<string, unknown> | undefined,
  /** VeloExpense: reports whose outcome went through `recordReportOutcome`. */
  outcomes: [] as Array<{ reportId: string; outcome: string; actor: unknown }>,
  outcomeError: null as Error | null,
}));

vi.mock('@expenseos/approvals/engine', () => ({
  // VeloExpense: the engine calls `onExpired` for each task it did not skip, inside the task's
  // savepoint; the mock does the same, so a throwing hook is the engine's to contain.
  sweepExpiredTasks: async (
    _db: unknown,
    _now: Date,
    onExpired?: (r: Record<string, unknown>) => Promise<void>,
  ) => {
    for (const r of h.swept) {
      if (r.outcome === 'SKIPPED' || !onExpired) continue;
      try {
        await onExpired(r);
      } catch {
        // The engine rolls the task back to its savepoint and moves on.
      }
    }
    return h.swept;
  },
  loadRequesterId: async () => h.requesterId,
  // One business day from Friday is Monday; the sweep only needs "later than now".
  addBusinessDays: (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000),
}));
// VeloExpense: the tenant-scoped client; `$transaction` hands the same client to `fn`.
vi.mock('@/lib/db/prisma', () => {
  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
    approvalTask: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        h.taskWhere = args.where;
        return h.due;
      },
      update: async (args: Record<string, unknown>) => {
        if (h.updateError) throw h.updateError;
        h.updated.push(args);
        return {};
      },
    },
    expenseReport: { findUnique: async () => null },
  };
  return { db: client };
});
vi.mock('@/lib/db/prisma-pg-bridge', () => ({ queryRunnerOf: (tx: unknown) => tx }));
vi.mock('@/lib/expenses/lifecycle', () => ({

  recordReportOutcome: async (
    _tx: unknown,
    input: { reportId: string; outcome: string; actor: unknown },
  ) => {
    if (h.outcomeError) throw h.outcomeError;
    h.outcomes.push({ reportId: input.reportId, outcome: input.outcome, actor: input.actor });
  },
}));
vi.mock('@/lib/notifications/service', () => ({
  reportPayload: () => ({}),
  recordActivity: async (_tx: unknown, entry: Record<string, unknown>) => {
    if (h.activityError) throw h.activityError;
    // VeloExpense: the service's field is `eventType`; recorded as ExpenseOS's `type`.
    h.activities.push({ ...entry, type: entry.eventType });
    return `act-${h.activities.length}`;
  },
  notifyRecipients: async (_tx: unknown, activityId: string, recipients: string[]) => {
    h.notified.push({ activityId, recipients });
  },
}));

import { handleApprovalSweep } from './approval-sweep';

const run = () => handleApprovalSweep(undefined as never);
const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {});
const quietWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

const expired = (over: Record<string, unknown> = {}) => ({
  outcome: 'ESCALATED',
  subjectType: 'VIRTUAL_CARD_REQUEST',
  subjectId: 'vcr-1',
  reassignedTo: 'mgr-1',
  ...over,
});

beforeEach(() => {
  h.swept = [];
  h.due = [];
  h.requesterId = 'req-1';
  h.activityError = null;
  h.updateError = null;
  h.activities = [];
  h.notified = [];
  h.updated = [];
  h.taskWhere = undefined;
  h.outcomes = [];
  h.outcomeError = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('expired tasks', () => {
  it('tells the requester their request expired', async () => {
    quiet();
    h.swept = [expired({ outcome: 'REJECTED', reassignedTo: null })];
    await run();
    expect(h.notified[0].recipients).toEqual(['req-1']);
    expect(h.activities[0]).toMatchObject({ type: 'TASK_EXPIRED', actorId: null });
  });

  it('also tells the new approver when the expiry escalated to them', async () => {
    /** An escalation lands silently in somebody's queue otherwise — the same failure as
     *  the request that expired unnoticed in the first place. */
    quiet();
    h.swept = [expired()];
    await run();
    expect(h.notified[0].recipients).toEqual(['req-1', 'mgr-1']);
  });

  it('notifies the requester once when they are also the escalation target', async () => {
    // A Set, so a self-escalation does not send two copies of the same thing.
    quiet();
    h.requesterId = 'mgr-1';
    h.swept = [expired()];
    await run();
    expect(h.notified[0].recipients).toEqual(['mgr-1']);
  });

  it('records the outcome on the activity, since "expired" alone says nothing', async () => {
    quiet();
    h.swept = [expired({ outcome: 'APPROVED' })];
    await run();
    expect(h.activities[0]).toMatchObject({ payload: { outcome: 'APPROVED' } });
  });

  it('still records the activity when the subject has no resolvable requester', async () => {
    /** A soft-deleted requester must not swallow the timeline entry — the history is what
     *  an approver reads to understand why a request moved. */
    quiet();
    h.requesterId = null;
    h.swept = [expired({ reassignedTo: null })];
    await run();
    expect(h.activities).toHaveLength(1);
    expect(h.notified[0].recipients).toEqual([]);
  });

  it('leaves SKIPPED results alone entirely', async () => {
    /** The engine looked and decided not to expire it. Fanning out would tell somebody
     *  their request expired when it did not. */
    const log = quiet();
    h.swept = [expired({ outcome: 'SKIPPED' })];
    await run();
    expect(h.activities).toHaveLength(0);
    expect(String(log.mock.calls[0][0])).toContain('0 escalated, 0 resolved');
  });

  it('counts escalations apart from resolutions', async () => {
    const log = quiet();
    h.swept = [
      expired(),
      expired({ subjectId: 'vcr-2' }),
      expired({ outcome: 'REJECTED', subjectId: 'vcr-3', reassignedTo: null }),
      expired({ outcome: 'SKIPPED', subjectId: 'vcr-4' }),
    ];
    await run();
    expect(String(log.mock.calls[0][0])).toContain('2 escalated, 1 resolved');
  });

  it('keeps sweeping when one subject’s fan-out fails', async () => {
    /**
     * The expiry itself already happened in the engine — this loop only tells people. One
     * unreachable recipient taking down the batch would leave every later subject expired
     * and unannounced, which is the exact failure the deadline exists to prevent.
     */
    quiet();
    const warn = quietWarn();
    h.activityError = new Error('activity write failed');
    h.swept = [expired(), expired({ subjectId: 'vcr-2' })];
    await run();
    expect(warn).toHaveBeenCalledTimes(2);
    // The counts still describe what the engine did, because it did do it.
    expect(h.notified).toHaveLength(0);
  });
});

describe('deadline reminders', () => {
  it('looks only for pending tasks, not yet reminded, on a live instance', async () => {
    /** Each clause removes a way of reminding somebody about nothing: a decided task, a
     *  second reminder, or a task on an instance that has already finished. */
    quiet();
    await run();
    expect(h.taskWhere).toMatchObject({
      status: 'PENDING',
      deadlineReminderAt: null,
      instance: { status: 'RUNNING' },
    });
  });

  it('looks one business day ahead, and not into the past', async () => {
    quiet();
    const before = Date.now();
    await run();
    const window = (h.taskWhere as { expiresAt: { gt: Date; lte: Date } }).expiresAt;
    expect(window.gt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(window.lte.getTime()).toBeGreaterThan(window.gt.getTime());
  });

  it('reminds the assignee, and stamps the task so it cannot remind twice', async () => {
    quiet();
    h.due = [
      { id: 't-1', assigneeUserId: 'ap-1', instance: { subjectId: 'r-1', subjectType: 'REPORT' } },
    ];
    await run();
    expect(h.updated[0]).toMatchObject({ where: { id: 't-1' } });
    expect(h.activities[0]).toMatchObject({ type: 'DEADLINE_NEAR', subjectId: 'r-1' });
    expect(h.notified[0].recipients).toEqual(['ap-1']);
  });

  it('stamps before it notifies, so a crash costs one reminder and not a nightly repeat', async () => {
    /** The order is the guarantee. Notifying first and stamping after would re-send every
     *  night until the deadline passed, whenever the fan-out threw. */
    quiet();
    quietWarn();
    h.activityError = new Error('notify down');
    h.due = [
      { id: 't-1', assigneeUserId: 'ap-1', instance: { subjectId: 'r-1', subjectType: 'REPORT' } },
    ];
    await run();
    expect(h.updated).toHaveLength(1);
    expect(h.notified).toHaveLength(0);
  });

  it('skips a task nobody is assigned to', async () => {
    /** An unassigned filter task has no single recipient — the reminder would have to
     *  guess, and it is still stamped so the sweep does not reconsider it nightly. */
    quiet();
    h.due = [
      { id: 't-1', assigneeUserId: null, instance: { subjectId: 'r-1', subjectType: 'REPORT' } },
    ];
    await run();
    expect(h.updated).toHaveLength(1);
    expect(h.notified).toHaveLength(0);
  });

  it('keeps going when one reminder fails', async () => {
    quiet();
    const warn = quietWarn();
    h.updateError = new Error('row locked');
    h.due = [
      { id: 't-1', assigneeUserId: 'ap-1', instance: { subjectId: 'r-1', subjectType: 'REPORT' } },
      { id: 't-2', assigneeUserId: 'ap-2', instance: { subjectId: 'r-2', subjectType: 'REPORT' } },
    ];
    await run();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reports how many reminders went out', async () => {
    const log = quiet();
    h.due = [
      { id: 't-1', assigneeUserId: 'ap-1', instance: { subjectId: 'r-1', subjectType: 'REPORT' } },
      { id: 't-2', assigneeUserId: null, instance: { subjectId: 'r-2', subjectType: 'REPORT' } },
    ];
    await run();
    // One of the two had nobody to remind.
    expect(String(log.mock.calls[0][0])).toContain('reminders: 1');
  });
});

describe('an expense report the expiry decided', () => {
  // VeloExpense: ExpenseOS offers an approved report to NetSuite here; VeloExpense records the
  // report's outcome (budgets, history, the ledger post, the audit row) inside the sweep.
  it('records an approval through the report outcome, as the sweep', async () => {
    quiet();
    h.swept = [expired({ outcome: 'APPROVED', subjectType: 'EXPENSE_REPORT', subjectId: 'rep-1' })];
    await run();
    expect(h.outcomes).toEqual([
      { reportId: 'rep-1', outcome: 'APPROVED', actor: { system: 'approval.sweepExpired' } },
    ]);
  });

  it('records a rejection too — the report leaves the pending budget either way', async () => {
    quiet();
    h.swept = [expired({ outcome: 'REJECTED', subjectType: 'EXPENSE_REPORT', subjectId: 'rep-2' })];
    await run();
    expect(h.outcomes).toMatchObject([{ reportId: 'rep-2', outcome: 'REJECTED' }]);
  });

  it('records it even when its notification fan-out failed', async () => {
    quiet();
    quietWarn();
    h.activityError = new Error('boom');
    h.swept = [expired({ outcome: 'APPROVED', subjectType: 'EXPENSE_REPORT', subjectId: 'rep-1' })];
    await run();
    expect(h.outcomes).toMatchObject([{ reportId: 'rep-1' }]);
  });

  it('records nothing for an escalation or a skip', async () => {
    quiet();
    h.swept = [
      expired({ outcome: 'ESCALATED', subjectType: 'EXPENSE_REPORT', subjectId: 'rep-esc' }),
      expired({ outcome: 'SKIPPED', subjectType: 'EXPENSE_REPORT', subjectId: 'rep-skip' }),
    ];
    await run();
    expect(h.outcomes).toEqual([]);
  });
});
