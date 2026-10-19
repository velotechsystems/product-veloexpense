import { describe, expect, it, vi } from 'vitest';
import {
  COMMENT_THREAD_SUBJECTS,
  hasCommentThread,
  OWNER_RESOLVERS,
  threadParticipants,
} from './threadParticipants';

/**
 * Who is on a subject's discussion thread.
 *
 * One list, two callers, and that is the whole point: the inbound email/Slack path uses it
 * to AUTHORIZE (the replier must already be on the thread) and the in-app path uses it to
 * FAN OUT. Two separate answers would let somebody post a comment nobody is told about,
 * or be told about a thread they are not allowed to post to.
 *
 * It is deliberately NARROWER than "everyone who can view the subject". A report's readers
 * include anyone *eligible* to decide it, which on a filter-approver step can be a pool of
 * people who have never touched it — mailing all of them about every comment is how a
 * channel gets muted, after which the authorization half stops mattering too.
 *
 * VeloExpense: ExpenseOS's `threadParticipants.test.ts` (550b2945), for the expense report
 * (w2-02a) and, since w6-01, the travel request (1e682dd6's cases). The tasks come from SQL over every run of the
 * report (`$queryRaw`), where ExpenseOS reads one instance's through Prisma; the cases are
 * ExpenseOS's, marked where that changes them.
 */

function makeDb(over: Record<string, unknown> = {}) {
  const tasks = vi.fn<(...args: unknown[]) => Promise<Array<Record<string, unknown>>>>(async () => []);
  return {
    db: {
      expenseReport: { findUnique: vi.fn(async () => null as unknown) },
      travelRequest: { findUnique: vi.fn(async () => null as unknown) },
      $queryRaw: tasks,
      ...over,
    } as never,
    tasks,
  };
}

const report = (submitterId = 'u-1') => ({
  expenseReport: { findUnique: vi.fn(async () => ({ submitterId })) },
});

describe('the owner', () => {
  it('always includes the person who raised it', async () => {
    /** A thread with no owner is not a thread. Every real subject has one, which is why an
     *  empty result can only mean "no such subject". */
    const { db } = makeDb(report());
    expect(await threadParticipants(db, 'EXPENSE_REPORT', 'r-1')).toEqual(['u-1']);
  });

  it('reads the owner from each subject’s own column', async () => {
    /**
     * `submitterId` on a report and a travel request. The registry is a field mapping
     * precisely because the interesting half — walking the approval tasks — is identical,
     * and a resolver per subject is how the copies drift.
     *
     * VeloExpense: ExpenseOS's case, without the card request (out of scope).
     */
    for (const [type, table, row] of [
      ['EXPENSE_REPORT', 'expenseReport', { submitterId: 'u-9' }],
      ['TRAVEL_REQUEST', 'travelRequest', { submitterId: 'u-9' }],
    ] as const) {
      const { db } = makeDb({ [table]: { findUnique: vi.fn(async () => row) } });
      expect(await threadParticipants(db, type, 's-1')).toEqual(['u-9']);
    }
  });
});

describe('the approvers', () => {
  it('adds everyone assigned a task on the routing instance', async () => {
    const { db } = makeDb({
      ...report(),
      $queryRaw: vi.fn(async () => [
        { assigneeId: 'mgr-1', decidedById: null },
        { assigneeId: 'fin-1', decidedById: null },
      ]),
    });
    expect(await threadParticipants(db, 'EXPENSE_REPORT', 'r-1')).toEqual([
      'u-1',
      'mgr-1',
      'fin-1',
    ]);
  });

  it('adds whoever actually decided, even when they were not the assignee', async () => {
    /**
     * A delegate or an admin acting on somebody else's task is on the thread — they are
     * the person who took the action being discussed, and excluding them means a reply to
     * their own decision is refused.
     */
    const { db } = makeDb({
      ...report(),
      $queryRaw: vi.fn(async () => [{ assigneeId: 'mgr-1', decidedById: 'admin-1' }]),
    });
    expect(await threadParticipants(db, 'EXPENSE_REPORT', 'r-1')).toEqual([
      'u-1',
      'mgr-1',
      'admin-1',
    ]);
  });

  it('lists each person once, however many tasks they hold', async () => {
    /** A three-step workflow routed to the same manager should not send three copies of
     *  every comment. */
    const { db } = makeDb({
      ...report(),
      $queryRaw: vi.fn(async () => [
        { assigneeId: 'mgr-1', decidedById: 'mgr-1' },
        { assigneeId: 'mgr-1', decidedById: null },
      ]),
    });
    expect(await threadParticipants(db, 'EXPENSE_REPORT', 'r-1')).toEqual(['u-1', 'mgr-1']);
  });

  it('ignores an unassigned, undecided task', async () => {
    /** A filter step with a claimable pool has nobody on it yet. Its eligible pool is
     *  exactly the crowd this list refuses to include. */
    const { db } = makeDb({
      ...report(),
      $queryRaw: vi.fn(async () => [{ assigneeId: null, decidedById: null }]),
    });
    expect(await threadParticipants(db, 'EXPENSE_REPORT', 'r-1')).toEqual(['u-1']);
  });

  // VeloExpense: "does not go looking for tasks on a subject that has no routing" does not
  // apply — a report has no single routing field to be null; a report with no run simply
  // finds no tasks (above).

  it('scopes the task query to that subject’s instance', async () => {
    // VeloExpense: to the subject, across its approval instances — its type and its id.
    const { db, tasks } = makeDb(report());
    await threadParticipants(db, 'EXPENSE_REPORT', 'r-7');
    expect(tasks.mock.calls[0]?.slice(1)).toEqual(['EXPENSE_REPORT', 'r-7']);
  });
});

describe('subjects with no thread', () => {
  it('returns nobody for a subject type nothing registers', async () => {
    /** A reply to one is ignored rather than guessed at — guessing here would mean
     *  authorizing a comment against a participant list nobody defined. */
    const { db } = makeDb();
    expect(await threadParticipants(db, 'SOMETHING_ELSE', 's-1')).toEqual([]);
  });

  it('returns nobody for a subject that does not exist', async () => {
    const { db } = makeDb({ expenseReport: { findUnique: vi.fn(async () => null) } });
    expect(await threadParticipants(db, 'EXPENSE_REPORT', 'gone')).toEqual([]);
  });
});

/**
 * The registry and the list of commentable subjects, kept in step — ExpenseOS's guard
 * (1e682dd6). `OWNER_RESOLVERS` is a total `Record<CommentThreadSubject, …>`, so the compiler
 * enforces one half; this catches an EXTRA key, which a `Record` accepts silently.
 */
describe('the shared list of commentable subjects', () => {
  it('has a participant resolver for exactly the subjects the list names', () => {
    expect(new Set(Object.keys(OWNER_RESOLVERS))).toEqual(new Set(COMMENT_THREAD_SUBJECTS));
  });

  it('answers for every subject the list names, and for nothing else', async () => {
    for (const subject of COMMENT_THREAD_SUBJECTS) {
      expect(hasCommentThread(subject)).toBe(true);
      const { db } = makeDb({
        ...report(),
        travelRequest: { findUnique: vi.fn(async () => ({ submitterId: 'u-1' })) },
      });
      expect(await threadParticipants(db, subject, 's-1'), subject).toEqual(['u-1']);
    }
    expect(hasCommentThread('BUDGET')).toBe(false);
  });
});
