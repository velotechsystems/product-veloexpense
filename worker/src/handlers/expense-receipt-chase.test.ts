// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The nightly nudge about draft expenses with no receipt.
 *
 * Before this, the only thing that mentioned a missing receipt was the RECEIPT_REQUIRED
 * policy rule — which fires at SUBMIT. So a report could sit half-finished for weeks and
 * the submitter met the blocker on the day expenses were due.
 *
 * A chaser is one bad decision away from being worse than nothing, and each of those
 * decisions is a test here:
 *
 *   · **Only reports the submitter can still act on.** Chasing a SUBMITTED report nags
 *     about work that is out of their hands; an APPROVED one is settled.
 *   · **One reminder per REPORT.** Three receiptless lines is one piece of news, and
 *     three emails about it reads as a bug.
 *   · **The cooldown is derived from the Activity row it writes.** A daily job with no
 *     memory mails the same person every night until they mute notifications — at which
 *     point the chaser has cost more than it ever bought.
 *   · **One bad report cannot abandon the run**, or the first failure silences everyone
 *     behind it.
 *
 * VeloExpense: ExpenseOS's `expense-receipt-chase.test.ts` (550b2945), Wave 3 (w3-05). The cases
 * are ExpenseOS's; the seams are VeloExpense's, each marked: `db` is the tenant-scoped client,
 * the activity table is read through the notification service's SQL (`queryRunnerOf`), the
 * reminder is RECEIPT_CHASE (d46) through `lib/notifications/service`, a receipt is a STORED
 * one, and the cooldown also counts the person-sent RECEIPT_REMINDER. ExpenseOS's "tuning
 * flags" block is not ported: VeloExpense has no system flags, so the defaults are constants,
 * and its cases on them are the ones above that read 3 and 7 days.
 */

const h = vi.hoisted(() => ({
  reports: [] as Array<Record<string, unknown>>,
  recent: [] as Array<{ subjectId: string }>,
  reportWhere: undefined as Record<string, unknown> | undefined,
  reportArgs: undefined as Record<string, unknown> | undefined,
  // VeloExpense: the cooldown query, as SQL and its parameters.
  activityQuery: undefined as { sql: string; params: unknown[] } | undefined,
  activities: [] as Array<Record<string, unknown>>,
  notified: [] as string[][],
  activityError: null as Error | null,
}));

// VeloExpense: the tenant-scoped client. A transaction hands back a stand-in the bridge mock
// below turns into a query runner.
vi.mock('@/lib/db/prisma', () => ({
  db: {
    expenseReport: {
      findMany: async (args: Record<string, unknown>) => {
        h.reportArgs = args;
        h.reportWhere = args.where as Record<string, unknown>;
        return h.reports;
      },
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
  },
}));
vi.mock('@/lib/db/prisma-pg-bridge', () => ({
  queryRunnerOf: () => ({
    query: async (sql: string, params: unknown[]) => {
      h.activityQuery = { sql, params };
      return { rows: h.recent.map((r) => ({ subject_id: r.subjectId })), rowCount: h.recent.length };
    },
  }),
}));
// VeloExpense: VeloExpense's notification service, in place of `@expenseos/notifications`.
vi.mock('@/lib/notifications/service', () => ({
  recordActivity: async (_tx: unknown, entry: Record<string, unknown>) => {
    if (h.activityError) throw h.activityError;
    h.activities.push(entry);
    return `act-${h.activities.length}`;
  },
  notifyRecipients: async (_tx: unknown, _id: string, recipients: string[]) => {
    h.notified.push(recipients);
    return recipients;
  },
  reportPayload: (r: { title: string; number: string | null }) => ({
    report: r.title,
    number: r.number ?? '',
    total: 'CA$50.00',
  }),
}));

import { handleExpenseReceiptChase } from './expense-receipt-chase';

const run = () => handleExpenseReceiptChase(undefined as never);
const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {});
const quietWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
const report = (over: Record<string, unknown> = {}) => ({
  id: 'r-1',
  number: 'EXP-001',
  submitterId: 'u-1',
  // VeloExpense: for the report placeholders.
  title: 'October',
  totalMinor: 5000n,
  currencyId: 'CAD',
  _count: { expenses: 2 },
  ...over,
});

beforeEach(() => {
  h.reports = [report()];
  h.recent = [];
  h.reportWhere = undefined;
  h.reportArgs = undefined;
  h.activityQuery = undefined;
  h.activities = [];
  h.notified = [];
  h.activityError = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('which reports it chases', () => {
  it('only ones the submitter can still attach to', async () => {
    /** A SUBMITTED report is out of their hands and an APPROVED one is settled; nagging
     *  about either asks somebody to fix something they cannot reach. */
    quiet();
    await run();
    expect(h.reportWhere).toMatchObject({ status: { in: ['DRAFT', 'RETURNED'] } });
  });

  it('requires at least one receiptless expense old enough to be worth chasing', async () => {
    /** An expense captured this morning must not be chased tonight — that reads as the
     *  system not having noticed the upload. */
    quiet();
    const before = Date.now();
    await run();
    const some = (
      h.reportWhere as { expenses: { some: { receipts: unknown; createdAt: { lt: Date } } } }
    ).expenses.some;
    // VeloExpense: a receipt is a STORED one (d29).
    expect(some.receipts).toEqual({ none: { status: 'STORED' } });
    expect(before - some.createdAt.lt.getTime()).toBeGreaterThan(2 * 86_400_000);
  });

  it('caps the batch so a backlog cannot fan out unboundedly', async () => {
    quiet();
    await run();
    expect(h.reportArgs?.take).toBe(500);
  });

  it('starts with the reports nobody has touched in longest', async () => {
    quiet();
    await run();
    expect(h.reportArgs?.orderBy).toEqual({ updatedAt: 'asc' });
  });

  it('says there is nothing to chase, and asks nothing further', async () => {
    h.reports = [];
    const log = quiet();
    await run();
    expect(h.activityQuery).toBeUndefined();
    expect(String(log.mock.calls[0][0])).toContain('nothing to chase');
  });
});

describe('the reminder', () => {
  it('goes to the submitter, once, naming how many receipts are missing', async () => {
    /** One per report: three receiptless lines is one piece of news. And the count is
     *  what makes the message actionable rather than a general reproach. */
    quiet();
    await run();
    expect(h.activities).toHaveLength(1);
    // VeloExpense: RECEIPT_CHASE (d46), with the report placeholders every report event carries.
    expect(h.activities[0]).toMatchObject({
      subjectType: 'EXPENSE_REPORT',
      subjectId: 'r-1',
      eventType: 'RECEIPT_CHASE',
      actorId: null,
      payload: { number: 'EXP-001', missing: 2, report: 'October' },
    });
    expect(h.notified[0]).toEqual(['u-1']);
  });

  it('has no actor, because nobody sent it', async () => {
    /** A name here would render as a colleague chasing them, which is a different and
     *  much less welcome message. */
    quiet();
    await run();
    expect(h.activities[0].actorId).toBeNull();
  });

  it('skips a report whose receipts arrived between the two queries', async () => {
    // The count is read with the report; a zero means somebody just uploaded.
    h.reports = [report({ _count: { expenses: 0 } })];
    quiet();
    await run();
    expect(h.activities).toHaveLength(0);
  });

  it('keeps chasing the rest when one report fails', async () => {
    quiet();
    const warn = quietWarn();
    h.activityError = new Error('notifications down');
    h.reports = [report(), report({ id: 'r-2' })];
    await run();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('the cooldown', () => {
  it('reads recent reminders in one query, not one per report', async () => {
    /** N reports is N queries otherwise, on a job whose entire batch is 500. */
    quiet();
    h.reports = [report(), report({ id: 'r-2' })];
    await run();
    // VeloExpense: one SQL read over every candidate, both reminder events counting.
    expect(h.activityQuery?.params[0]).toEqual(['r-1', 'r-2']);
    expect(h.activityQuery?.sql).toContain("event_type IN ('RECEIPT_CHASE', 'RECEIPT_REMINDER')");
  });

  it('says nothing to a report reminded inside the window', async () => {
    /** The Activity row IS the throttle. Without it this job mails the same person every
     *  night until they mute notifications — worse than never chasing at all. */
    quiet();
    h.recent = [{ subjectId: 'r-1' }];
    await run();
    expect(h.activities).toHaveLength(0);
  });

  it('chases the reports that are not on cooldown in the same pass', async () => {
    quiet();
    h.reports = [report(), report({ id: 'r-2', submitterId: 'u-2' })];
    h.recent = [{ subjectId: 'r-1' }];
    await run();
    expect(h.activities).toHaveLength(1);
    expect(h.notified[0]).toEqual(['u-2']);
  });

  it('looks back one cooldown window, not to the beginning of time', async () => {
    quiet();
    const before = Date.now();
    await run();
    const since = h.activityQuery?.params[1] as Date;
    expect(Math.round((before - since.getTime()) / 86_400_000)).toBe(7);
  });
});

describe('what it reports', () => {
  it('separates candidates from reminders actually sent', async () => {
    /** "500 candidates, 0 sent" is a working cooldown; "500 sent" every night is the bug
     *  this distinction exists to make visible. */
    const log = quiet();
    h.reports = [report(), report({ id: 'r-2' })];
    h.recent = [{ subjectId: 'r-2' }];
    await run();
    expect(String(log.mock.calls[0][0])).toContain('2 candidate report(s), 1 reminder(s) sent');
  });
});
