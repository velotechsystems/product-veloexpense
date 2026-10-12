import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * VeloExpense (w4-00c): ExpenseOS's suite, on the port. The plumbing the tests follow:
 *   · the fan-out is AWAITED inside the caller's transaction, under a savepoint — each call
 *     is awaited, and `settle()` still drains anything left;
 *   · VeloExpense's notification service: an activity is `{ eventType }` (read back here as
 *     `type`, so the assertions read as ExpenseOS wrote them) and its id is a string;
 *   · a submit tells the first approvers TASK_ASSIGNED (VeloExpense has no SUBMITTED event);
 *   · the activity carries the report's placeholders, and a decision or a return the note.
 */

/**
 * Who hears about what happened to an expense report.
 *
 * The audited decision is already recorded by the engine; this is the fan-out layered on
 * top, and it is fire-and-forget on purpose — a downed notifier must not fail an approval
 * that has committed. Which makes the interesting properties the ones about restraint:
 *
 *   · **Nobody is told about their own action.** Every path filters the actor out. An
 *     approver getting "you approved this" is the fastest way to a muted channel, and a
 *     muted channel is how the next one gets missed.
 *   · **Silence when there is nobody to tell.** A submit that auto-approved parked no
 *     tasks, and a recall that cancelled none had no approvers — writing an activity row
 *     for either claims a notification that went nowhere.
 *   · **Reports get NO one-click approve in email**, unlike VCC: an approver has to open
 *     the report to see its receipts and lines. That is enforced in the dispatcher, but it
 *     is why these are deep-link notifications and nothing more.
 */

const h = vi.hoisted(() => ({
  submitterId: 'sub-1' as string | null,
  recipientsForTasks: [] as string[],
  taskIdsAsked: [] as string[][],
  activities: [] as Array<Record<string, unknown>>,
  notified: [] as Array<{ activityId: string; recipients: string[] }>,
  activityError: null as Error | null,
}));

// VeloExpense: the notification service, on the caller's transaction.
vi.mock('@/lib/notifications/service', () => ({
  recordActivity: async (_db: unknown, entry: Record<string, unknown>) => {
    if (h.activityError) throw h.activityError;
    h.activities.push({ ...entry, type: entry.eventType });
    return `act-${h.activities.length}`;
  },
  notifyRecipients: async (_db: unknown, activityId: string, recipients: string[]) => {
    h.notified.push({ activityId, recipients });
  },
  reportPayload: () => ({ report: 'R' }),
}));
vi.mock('@/lib/db/prisma-pg-bridge', () => ({ queryRunnerOf: (db: unknown) => db }));
vi.mock('@/server/approvals/notify', () => ({
  taskRecipientIds: async (_db: unknown, taskIds: string[]) => {
    h.taskIdsAsked.push(taskIds);
    return h.recipientsForTasks;
  },
}));

import {
  notifyReportDecision,
  notifyReportReassigned,
  notifyReportRecalled,
  notifyReportReimbursed,
  notifyReportReturned,
  notifyReportSubmitted,
} from './reportNotify';

const db = {
  // VeloExpense: the savepoint around each fan-out.
  $executeRaw: async () => 0,
  expenseReport: {
    findUnique: async () =>
      h.submitterId
        ? { submitterId: h.submitterId, title: 'R', number: 'EXP-1', totalMinor: 100n, currencyId: 'CAD' }
        : null,
  },
} as never;

/** These are floating promises by design; drain the queue. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  h.submitterId = 'sub-1';
  h.recipientsForTasks = [];
  h.taskIdsAsked = [];
  h.activities = [];
  h.notified = [];
  h.activityError = null;
});

describe('a decision', () => {
  it('tells the submitter their report was approved', async () => {
    await notifyReportDecision(db, { status: 'APPROVED', subjectId: 'r-1', createdTaskIds: [] }, 'mgr-1');
    await settle();
    expect(h.activities[0]).toMatchObject({
      subjectType: 'EXPENSE_REPORT',
      subjectId: 'r-1',
      type: 'APPROVED',
      actorId: 'mgr-1',
    });
    expect(h.notified[0].recipients).toEqual(['sub-1']);
  });

  it('tells them about a rejection too', async () => {
    await notifyReportDecision(db, { status: 'REJECTED', subjectId: 'r-1', createdTaskIds: [] }, 'mgr-1');
    await settle();
    expect(h.activities[0]).toMatchObject({ type: 'REJECTED' });
  });

  it('says nothing to the submitter when they decided it themselves', async () => {
    /** An admin approving their own report does not need to be told they did. */
    await notifyReportDecision(db, { status: 'APPROVED', subjectId: 'r-1', createdTaskIds: [] }, 'sub-1');
    await settle();
    expect(h.notified).toHaveLength(0);
  });

  it('records the activity even when the submitter is gone', async () => {
    /** The timeline entry is the report's history and belongs there regardless; only the
     *  delivery depends on somebody existing to receive it. */
    h.submitterId = null;
    await notifyReportDecision(db, { status: 'APPROVED', subjectId: 'r-1', createdTaskIds: [] }, 'mgr-1');
    await settle();
    expect(h.activities).toHaveLength(1);
    expect(h.notified).toHaveLength(0);
  });

  it('stays quiet on an intermediate approval that parked nothing', async () => {
    /**
     * A tier-one approval on a three-tier workflow is not a terminal outcome. Telling the
     * submitter "approved" there would be wrong twice: it is not approved, and they would
     * get the message again later.
     */
    await notifyReportDecision(db, { status: 'RUNNING', subjectId: 'r-1', createdTaskIds: [] }, 'mgr-1');
    await settle();
    expect(h.activities).toHaveLength(0);
  });

  it('tells the next approvers about newly-parked tasks', async () => {
    h.recipientsForTasks = ['fin-1', 'fin-2'];
    await notifyReportDecision(
      db,
      { status: 'RUNNING', subjectId: 'r-1', createdTaskIds: ['t-2'] },
      'mgr-1',
    );
    await settle();
    expect(h.taskIdsAsked[0]).toEqual(['t-2']);
    expect(h.activities[0]).toMatchObject({ type: 'TASK_ASSIGNED' });
    expect(h.notified[0].recipients).toEqual(['fin-1', 'fin-2']);
  });

  it('does not tell the decider about a task they now own themselves', async () => {
    /** Happens on a workflow that routes two tiers to the same person — an email telling
     *  them about the queue item they just created reads as a bug. */
    h.recipientsForTasks = ['mgr-1', 'fin-1'];
    await notifyReportDecision(
      db,
      { status: 'RUNNING', subjectId: 'r-1', createdTaskIds: ['t-2'] },
      'mgr-1',
    );
    await settle();
    expect(h.notified[0].recipients).toEqual(['fin-1']);
  });

  it('does both when a terminal decision also parks a task', async () => {
    // Rare but real: a terminal branch that also opens a notify/acknowledge step.
    h.recipientsForTasks = ['fin-1'];
    await notifyReportDecision(
      db,
      { status: 'APPROVED', subjectId: 'r-1', createdTaskIds: ['t-9'] },
      'mgr-1',
    );
    await settle();
    expect(h.activities.map((a) => a.type)).toEqual(['APPROVED', 'TASK_ASSIGNED']);
  });

  it('swallows a fan-out failure rather than rejecting into a floating promise', async () => {
    /** The decision is already committed and audited. An unhandled rejection here is a
     *  process-level event over an email that did not send. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.activityError = new Error('notifications down');
    // VeloExpense: awaited — it resolves, having rolled back to its savepoint.
    await expect(
      notifyReportDecision(db, { status: 'APPROVED', subjectId: 'r-1', createdTaskIds: [] }, 'mgr-1'),
    ).resolves.toBeUndefined();
    await settle();
    expect(String(warn.mock.calls[0]?.[0])).toContain('decision fan-out failed');
    warn.mockRestore();
  });
});

describe('submitting', () => {
  it('tells the first approvers', async () => {
    h.recipientsForTasks = ['mgr-1'];
    await notifyReportSubmitted(db, 'r-1', 'sub-1', ['t-1']);
    await settle();
    // VeloExpense: TASK_ASSIGNED — no SUBMITTED event here.
    expect(h.activities[0]).toMatchObject({ type: 'TASK_ASSIGNED', actorId: 'sub-1' });
    expect(h.notified[0].recipients).toEqual(['mgr-1']);
  });

  it('does nothing at all when the report auto-approved', async () => {
    /**
     * No parked tasks means no workflow matched and the report is already approved. A
     * SUBMITTED activity with nobody to notify would put a "waiting for approval" entry on
     * a report that is not waiting for anything.
     */
    await notifyReportSubmitted(db, 'r-1', 'sub-1', []);
    await settle();
    expect(h.activities).toHaveLength(0);
  });

  it('does not notify a submitter who is also the first approver', async () => {
    h.recipientsForTasks = ['sub-1'];
    await notifyReportSubmitted(db, 'r-1', 'sub-1', ['t-1']);
    await settle();
    expect(h.notified[0].recipients).toEqual([]);
  });
});

describe('returning and reimbursing', () => {
  it('tells the submitter their report came back for edits', async () => {
    await notifyReportReturned(db, 'r-1', 'mgr-1');
    await settle();
    expect(h.activities[0]).toMatchObject({ type: 'RETURNED' });
    expect(h.notified[0].recipients).toEqual(['sub-1']);
  });

  it('tells the submitter the money went out', async () => {
    await notifyReportReimbursed(db, 'r-1', 'ap-1');
    await settle();
    expect(h.activities[0]).toMatchObject({ type: 'REIMBURSED' });
    expect(h.notified[0].recipients).toEqual(['sub-1']);
  });

  it('says nothing when the submitter did it to their own report', async () => {
    await notifyReportReimbursed(db, 'r-1', 'sub-1');
    await settle();
    expect(h.notified).toHaveLength(0);
  });
});

describe('recalling', () => {
  it('explains the inbox item that just disappeared', async () => {
    /** An approver whose queue item vanishes with no explanation assumes the system lost
     *  it — and then asks somebody. */
    h.recipientsForTasks = ['mgr-1', 'fin-1'];
    await notifyReportRecalled(db, 'r-1', 'sub-1', ['t-1', 't-2']);
    await settle();
    expect(h.activities[0]).toMatchObject({ type: 'RECALLED', actorId: 'sub-1' });
    expect(h.notified[0].recipients).toEqual(['mgr-1', 'fin-1']);
    expect(h.taskIdsAsked[0]).toEqual(['t-1', 't-2']);
  });

  it('stays quiet when the report had nothing parked', async () => {
    await notifyReportRecalled(db, 'r-1', 'sub-1', []);
    await settle();
    expect(h.activities).toHaveLength(0);
  });
});

describe('reassignment', () => {
  it('tells the new owner they have a task', async () => {
    await notifyReportReassigned(db, 'r-1', 'admin-1', 'mgr-2');
    await settle();
    expect(h.activities[0]).toMatchObject({ type: 'TASK_ASSIGNED', actorId: 'admin-1' });
    expect(h.notified[0].recipients).toEqual(['mgr-2']);
  });

  it('does nothing when somebody assigns a task to themselves', async () => {
    /** Not even an activity row: they are looking at the thing they just did. */
    await notifyReportReassigned(db, 'r-1', 'mgr-1', 'mgr-1');
    await settle();
    expect(h.activities).toHaveLength(0);
  });

  it('tells only the new owner, not the previous one', async () => {
    // Deliberate: the outgoing assignee's item disappearing is covered by the reassigning
    // admin's own conversation with them, and a "you no longer own this" email invites a
    // reply nobody reads.
    await notifyReportReassigned(db, 'r-1', 'admin-1', 'mgr-2');
    await settle();
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0].recipients).toEqual(['mgr-2']);
  });
});
