import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Whether the caller may decide on an expense report — and which task to hand them.
 *
 * The authorization model has no blanket "approve reports" permission: being an eligible
 * approver of a PENDING task on the report's running instance IS the authorization. That
 * is deliberate, and it is what makes this resolver security-relevant rather than a
 * convenience — the surfaces that call it (the approvals drawer, the workbench in approver
 * mode, and `expenses.report` admitting an approver as a READER) all take their answer
 * from here.
 *
 * Two properties matter most: it must return a task the caller can actually decide (an id
 * they cannot act on turns into a confusing refusal one call later), and it must not admit
 * a reader on the strength of a task that is already decided.
 */

const h = vi.hoisted(() => ({
  decidable: new Set<string>(),
  admin: false,
  canDecideCalls: [] as Array<{ taskId: string; userId: string; isAdmin: boolean }>,
}));

vi.mock('@expenseos/approvals/engine', () => ({
  canDecide: async (_db: unknown, taskId: string, userId: string, isAdmin: boolean) => {
    h.canDecideCalls.push({ taskId, userId, isAdmin });
    return isAdmin || h.decidable.has(taskId);
  },
}));

import { callerCanDecideReport, resolveDecidableTask } from './reportApproval';

function makeDb(report: unknown, tasks: Array<{ id: string }> = []) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- VeloExpense: ExpenseOS's typed mock (Biome allows it).
  const findMany = vi.fn(async (_args: unknown) => tasks);
  return {
    db: {
      expenseReport: { findUnique: vi.fn(async () => report) },
      approvalTask: { findMany },
    } as never,
    findMany,
  };
}

beforeEach(() => {
  h.decidable = new Set();
  h.admin = false;
  h.canDecideCalls = [];
});

describe('resolveDecidableTask', () => {
  it('returns the first task the caller may actually decide', async () => {
    /** Not the first PENDING task: an id the caller cannot act on becomes a refusal one
     *  call later, from a button that looked live. */
    h.decidable = new Set(['t-2']);
    const { db } = makeDb({ approvalInstanceId: 'inst-1' }, [{ id: 't-1' }, { id: 't-2' }]);
    expect(await resolveDecidableTask(db, 'r-1', 'u-1', false)).toBe('t-2');
  });

  it('stops asking once it has one', async () => {
    // `canDecide` walks delegations and role membership; asking for every task on a wide
    // parallel step is work nobody needs.
    h.decidable = new Set(['t-1', 't-2']);
    const { db } = makeDb({ approvalInstanceId: 'inst-1' }, [{ id: 't-1' }, { id: 't-2' }]);
    await resolveDecidableTask(db, 'r-1', 'u-1', false);
    expect(h.canDecideCalls).toHaveLength(1);
  });

  it('considers only PENDING tasks on the running instance', async () => {
    /** A decided task would otherwise admit its decider as an approver forever — including
     *  after the report moved on. */
    const { db, findMany } = makeDb({ approvalInstanceId: 'inst-1' }, []);
    await resolveDecidableTask(db, 'r-1', 'u-1', false);
    expect((findMany.mock.calls[0][0] as { where: unknown }).where).toEqual({
      instanceId: 'inst-1',
      status: 'PENDING',
    });
  });

  it('returns nothing for a report with no routing at all', async () => {
    // A draft, or one that auto-approved with no workflow.
    const { db, findMany } = makeDb({ approvalInstanceId: null });
    expect(await resolveDecidableTask(db, 'r-1', 'u-1', false)).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('returns nothing for a report that does not exist', async () => {
    const { db } = makeDb(null);
    expect(await resolveDecidableTask(db, 'gone', 'u-1', false)).toBeNull();
  });

  it('returns nothing when every pending task belongs to somebody else', async () => {
    const { db } = makeDb({ approvalInstanceId: 'inst-1' }, [{ id: 't-1' }]);
    expect(await resolveDecidableTask(db, 'r-1', 'stranger', false)).toBeNull();
  });

  it('passes the admin flag through, since an admin may decide any task', async () => {
    const { db } = makeDb({ approvalInstanceId: 'inst-1' }, [{ id: 't-1' }]);
    expect(await resolveDecidableTask(db, 'r-1', 'admin-1', true)).toBe('t-1');
    expect(h.canDecideCalls[0]).toMatchObject({ isAdmin: true });
  });
});

describe('callerCanDecideReport', () => {
  it('gives an admin no blanket yes — the answer comes from the task', async () => {
    /**
     * This asserted the opposite until the self-approval block landed, on the reasoning
     * that "an admin viewing a DRAFT report has no task to find, and a lookup-based
     * answer would deny them". The premise was already false: `callerCanReadReport`
     * short-circuits on `isAdmin` on its own line before it ever calls this, so admin
     * READ access never depended on the short-circuit here.
     *
     * What the short-circuit did do was make this function disagree with the mutation it
     * guards. `expenseApprovals.decide` asks the engine, and the engine now refuses a
     * requester their own subject — so a role-based yes here would render an Approve
     * button that fails when pressed. One question, one answer, both surfaces.
     */
    const { db } = makeDb(null);
    expect(await callerCanDecideReport(db, 'r-1', 'admin-1', true)).toBe(false);
  });

  it('still says yes to an admin deciding somebody else’s report', async () => {
    // The override is load-bearing — it is how a stuck queue gets unwedged. Only the
    // admin's OWN subject is out of reach.
    h.decidable = new Set(['t-1']);
    const { db } = makeDb({ approvalInstanceId: 'inst-1' }, [{ id: 't-1' }]);
    expect(await callerCanDecideReport(db, 'r-1', 'admin-1', true)).toBe(true);
  });

  it('says yes to an eligible approver', async () => {
    h.decidable = new Set(['t-1']);
    const { db } = makeDb({ approvalInstanceId: 'inst-1' }, [{ id: 't-1' }]);
    expect(await callerCanDecideReport(db, 'r-1', 'mgr-1', false)).toBe(true);
  });

  it('says no to somebody with no decidable task', async () => {
    /** This is also what admits an approver as a READER, so a false yes here is a person
     *  reading somebody else's expenses. */
    const { db } = makeDb({ approvalInstanceId: 'inst-1' }, [{ id: 't-1' }]);
    expect(await callerCanDecideReport(db, 'r-1', 'stranger', false)).toBe(false);
  });

  it('says no on a report with no running instance', async () => {
    const { db } = makeDb({ approvalInstanceId: null });
    expect(await callerCanDecideReport(db, 'r-1', 'mgr-1', false)).toBe(false);
  });
});
