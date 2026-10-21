// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFUSAL_KEYS, refusalData } from '@/server/refusal';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The approver's side of expense reports: the inbox, decisions, bulk approve, reassign,
 * return-for-edit, and reimbursement.
 *
 * Four rules carry the weight:
 *
 *   · **A decision re-checks PENDING before deciding.** Two approvers clicking at once,
 *     or a stale inbox tab, must not both count — and the status check has to happen on
 *     a fresh read, not on whatever the client sent.
 *   · **Eligibility is the engine's question, not this router's.** `canDecide` resolves
 *     delegation, approver pools, and admin override; re-implementing any of it here is
 *     how the inbox and the decision start disagreeing.
 *   · **Bulk approve decides each task independently.** One stale or ineligible task
 *     must not fail the batch — it reports which ids were skipped and why, so a partial
 *     result is visible rather than silently total.
 *   · **An approved report is pushed to NetSuite immediately.** It is a liability from
 *     the moment it is approved, so posting happens on the decision rather than when
 *     somebody remembers.
 *
 * VeloExpense: ExpenseOS's `expenseApprovals.test.ts`, for the procedures ported —
 * `myTasks` (the inbox), `decide`, `reassign`, `returnForEdit` (w4-00c, on ExpenseOS's
 * engine) and `setFxOverride` (w2-02a). `myDecided` and `decideBulk` came with the inbox
 * (w4-05/w4-07, d71); `markReimbursed` is not ported (d71), and its cases are not here.
 *
 * The bodies of the three actions run in `server/lib/reportLifecycle.ts`, so that the
 * /approvals form and the emailed link decide the same way; that module runs for real here,
 * on the same mocked engine pieces ExpenseOS's cases mock (`canDecide`, `decideTask`). Two
 * differences of plumbing, marked where they show:
 *   · the audit row: ExpenseOS's `withAudit` around the decision. VeloExpense writes the
 *     row after it — REPORT_APPROVED / _REJECTED / _RETURNED through `recordReportOutcome`
 *     (which also does the budgets, history and ledger post), or the step's own row through
 *     `writeAudit` — so `audited` collects both;
 *   · ExpenseOS's `postApprovedReport` is VeloExpense's `recordReportOutcome` on APPROVED.
 */

/**
 * VeloExpense: every audit row the actions write — `writeAudit` (a step, a reassignment) and
 * `recordReportOutcome` (an outcome) — as ExpenseOS's `withAuditCalls` collected them.
 */
const audited: Array<{ action: string; details: Record<string, unknown> }> = [];
const withAuditCalls: Array<Record<string, unknown>> = [];
vi.mock('@expenseos/audit', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@expenseos/audit');
  return {
    ...actual,
    withAudit: vi.fn(
      async (db: unknown, envelope: Record<string, unknown>, fn: (tx: unknown) => unknown) => {
        withAuditCalls.push(envelope);
        return fn(db);
      },
    ),
    writeAudit: vi.fn(async (_db: unknown, row: { action: string; details: Record<string, unknown> }) => {
      audited.push({ action: row.action, details: row.details });
    }),
  };
});
vi.mock('@/auth', () => ({ auth: stubFn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const canDecide = stubFn(async () => true);
const canClaimUnresolvedApproval = stubFn(async () => false);
const isEligible = stubFn(async () => false);
/** VeloExpense: the engine's `DecideResult` (ExpenseOS's mock predates its `status`). */
const decided = (status = 'APPROVED') => ({
  status,
  subjectId: '00000000-0000-7000-8000-000000000002',
  subjectType: 'EXPENSE_REPORT',
  createdTaskIds: [] as string[],
  firedEffects: ['e1'],
});
const decideTask = stubFn(async () => decided());
const primeRequesterIds = stubFn(async () => {});
const claimNeedsRequester = stubFn(() => true);
vi.mock('@expenseos/approvals/engine', () => ({
  canDecide,
  canClaimUnresolvedApproval,
  isEligible,
  decideTask,
  claimNeedsRequester,
  primeRequesterIds,
  /**
   * The real builder, not a stub: it is synchronous, allocates nothing but empty
   * memo slots, and the inbox writes its graph memo into the object it hands back.
   * A `vi.fn()` returning undefined would fail there for reasons that have nothing
   * to do with what these tests are about.
   */
  buildActorEligibilityContext: (actorId: string) => ({
    actorId,
    facts: {},
    auth: {},
    ancestors: {},
    minSortOrders: new Map(),
    requesterIds: new Map(),
    graphs: new Map(),
  }),
}));
// `data` is present because the inbox reads `graph.data.nodes` to work out whether an
// UNASSIGNED task is claimable; a success with no data would throw there.
vi.mock('@expenseos/approvals', () => ({
  graphSchema: {
    safeParse: () => ({
      success: true,
      data: { nodes: [{ id: 'n1', type: 'approval', approver: { kind: 'manager' } }], edges: [] },
    }),
  },
}));

const recomputeReportTotal = stubFn(async () => {});
const snapshotExpensesFx = stubFn(async () => {});
vi.mock('@expenseos/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@expenseos/db');
  return { ...actual, recomputeReportTotal, snapshotExpensesFx };
});

/** VeloExpense: the report's outcome (ExpenseOS: `postApprovedReport`, and the audit row). */
const recordReportOutcome = vi.fn(
  async (_tx: unknown, input: { outcome: string; context?: Record<string, unknown> }) => {
    audited.push({ action: `REPORT_${input.outcome}`, details: input.context ?? {} });
  },
);
vi.mock('@/lib/expenses/lifecycle', () => ({
  recordReportOutcome,
  submitReport: stubFn(async () => ({})),
  recallReport: stubFn(async () => ({})),
  LifecycleError: class extends Error {},
}));
/** VeloExpense: the billing gate, open. Its refusal has its own suite. */
vi.mock('@/lib/billing/gate', () => ({ assertTenantMayWrite: stubFn(async () => {}) }));

const callerCanDecideReport = stubFn(async () => false);
// VeloExpense (eos-573): `canViewReport` lives in this module now, as in ExpenseOS; it is the
// real one (AP and readers of all short-circuit before any query), and only the decide
// lookup is stubbed.
vi.mock('@/server/lib/reportApproval', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/lib/reportApproval')>()),
  callerCanDecideReport,
}));

const notifyReportDecision = vi.fn();
const notifyReportReassigned = vi.fn();
const notifyReportReturned = vi.fn();
vi.mock('@/server/lib/reportNotify', () => ({
  notifyReportDecision,
  notifyReportReassigned,
  notifyReportReturned,
}));

const executeWorkflowEffects = vi.fn();
vi.mock('@/server/lib/workflowEffects', () => ({ executeWorkflowEffects }));


const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const ME = U('9');
const TASK = U('1');
const REPORT = U('2');

const task = (over: Record<string, unknown> = {}) => ({
  id: TASK,
  status: 'PENDING',
  assigneeUserId: ME,
  instance: { subjectId: REPORT, status: 'RUNNING' },
  ...over,
});

function makeDb(over: Record<string, unknown> = {}) {
  return {
    approvalTask: {
      findUnique: stubFn(async () => task() as unknown),
      findMany: stubFn(async () => [] as unknown[]),
      update: stubFn(async () => ({ id: TASK })),
      updateMany: stubFn(async () => ({ count: 0 })),
    },
    approvalInstance: {
      findUnique: stubFn(async () => null as unknown),
      update: stubFn(async () => ({ id: 'inst-1' })),
    },
    expenseReport: {
      findUnique: vi.fn(
        async () =>
          ({
            id: REPORT,
            status: 'SUBMITTED',
            approvalInstanceId: 'inst-1',
            submitterId: U('8'),
          }) as unknown,
      ),
      findMany: stubFn(async () => [] as unknown[]),
      update: stubFn(async () => ({ id: REPORT, status: 'RETURNED' })),
    },
    expense: { findMany: stubFn(async () => [] as unknown[]) },
    receipt: { findMany: stubFn(async () => [] as unknown[]) },
    user: {
      findFirst: stubFn(async () => ({ id: U('3'), name: 'Pat', email: 'pat@x.example' }) as unknown),
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => null as unknown),
    },
    /** VeloExpense (f29): the reader's currency falls back to the tenant's main entity. */
    legalEntity: { findFirst: stubFn(async () => null as unknown) },
    /** VeloExpense: the report-row lock, and the bridge's raw statements. */
    $queryRaw: stubFn(async () => [] as unknown[]),
    $queryRawUnsafe: stubFn(async () => [] as unknown[]),
    $executeRawUnsafe: stubFn(async () => 0),
    ...over,
  };
}

async function callerFor(db: unknown, permissions: readonly string[] = []) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { expenseApprovalsRouter } = await import('./expenseApprovals');
  return createCallerFactory(expenseApprovalsRouter)(
    makeContext({ db, userId: ME, permissions, roleLabel: 'Manager' }),
  );
}

/** The approval override. It is NOT `read.all` — see the AP_CLERK cases below. */
const ADMIN = [P.expense.report.decideAny] as const;
const AP = [P.expense.report.reimburse] as const;
/** What the seeded AP Clerk actually carries on this surface: reads every report, pays
 *  approved ones, decides nothing it was not assigned. */
const AP_CLERK = [P.expense.report.readAll, P.expense.report.reimburse] as const;
/** Restating a report's FX — a finance-admin grant, deliberately NOT part of `AP`. */
const FX = [P.expense.report.fxOverride] as const;

beforeEach(() => {
  vi.clearAllMocks();
  withAuditCalls.length = 0;
  audited.length = 0;
  canDecide.mockResolvedValue(true);
  // `clearAllMocks` wipes call history and LEAVES implementations, so a test that
  // overrides these would otherwise leak its answer into every later one.
  canClaimUnresolvedApproval.mockResolvedValue(false);
  isEligible.mockResolvedValue(false);
  callerCanDecideReport.mockResolvedValue(false);
  decideTask.mockResolvedValue(decided());
});

describe('the inbox', () => {
  it('returns only pending tasks assigned to the caller', async () => {
    const db = makeDb();
    const c = await callerFor(db, []);
    await c.myTasks();
    expect(JSON.stringify(db.approvalTask.findMany.mock.calls[0]?.[0]?.where)).toContain('PENDING');
  });

  it('asks about the claim using the REPORT, not the caller', async () => {
    /**
     * `canClaimUnresolvedApproval` needs the subject to find the requester, because
     * a no-fallback claim is refused to the requester's own subordinates. Its two
     * id arguments are both strings, so swapping them typechecks perfectly and
     * silently asks "does the actor report to the actor" — every claim would then
     * be allowed, and the narrowing would be dead code that still looked live.
     *
     * The inbox has to give the same verdict the decide path will, or it renders
     * rows that 403 when opened.
     */
    const db = makeDb();
    db.approvalTask.findMany
      .mockResolvedValueOnce([]) // assigned to me: none
      .mockResolvedValueOnce([
        {
          id: TASK,
          label: 'mgr',
          nodeId: 'n1',
          instance: {
            subjectId: REPORT,
            effectiveGraph: null,
            workflowVersion: { graph: {} },
          },
        },
      ]);
    canClaimUnresolvedApproval.mockResolvedValue(true);
    const c = await callerFor(db, []);
    await c.myTasks();
    const call = canClaimUnresolvedApproval.mock.calls[0];
    expect(call?.[3]).toBe(REPORT);
    expect(call?.[4]).toBe(ME);
  });

  it('lists what the caller already decided separately', async () => {
    // An approver needs to see their own history, not just their queue.
    // VeloExpense (w4-05/w4-07, d71): `myDecided` is ported with the inbox.
    const db = makeDb();
    const c = await callerFor(db, []);
    await c.myDecided();
    expect(JSON.stringify(db.approvalTask.findMany.mock.calls[0]?.[0]?.where)).toContain(ME);
  });
});

describe('decide', () => {
  it('404s an unknown task', async () => {
    const db = makeDb();
    db.approvalTask.findUnique.mockResolvedValue(null);
    const c = await callerFor(db, []);
    await expect(c.decide({ taskId: TASK, approve: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a task already decided', async () => {
    /**
     * Two approvers clicking at once, or a stale inbox tab, must not both count — and
     * the check is on a fresh read rather than on anything the client sent.
     */
    for (const status of ['APPROVED', 'REJECTED', 'SKIPPED', 'EXPIRED']) {
      const db = makeDb();
      db.approvalTask.findUnique.mockResolvedValue(task({ status }));
      const c = await callerFor(db, []);
      await expect(c.decide({ taskId: TASK, approve: true }), status).rejects.toThrow(
        /already decided/,
      );
    }
    expect(decideTask).not.toHaveBeenCalled();
  });

  it('defers eligibility to the engine', async () => {
    // Delegation, approver pools and admin override all live there; re-implementing
    // any of it here is how the inbox and the decision start disagreeing.
    canDecide.mockResolvedValue(false);
    const db = makeDb();
    const c = await callerFor(db, []);
    await expect(c.decide({ taskId: TASK, approve: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(decideTask).not.toHaveBeenCalled();
  });

  it('asks the engine on the task’s own terms first, and records no override for an assignee', async () => {
    // An override holder who IS the assignee is the assignee: one engine call, no
    // override flag, and the audit row says so.
    // VeloExpense: asked once by the router's fast refusal and once by the action's body,
    // both on the task's own terms.
    const db = makeDb();
    await (await callerFor(db, ADMIN)).decide({ taskId: TASK, approve: true });
    expect(canDecide).toHaveBeenCalledWith(expect.anything(), TASK, ME, false);
    expect(canDecide).not.toHaveBeenCalledWith(expect.anything(), TASK, ME, true);
    expect(audited[0]?.details).toMatchObject({ override: false });
  });

  it('lets the override decide a task that is not theirs, and audits it as an override', async () => {
    /**
     * `expense.report.decide.any` is the only thing that reaches the engine's admin
     * branch, and a decision made on it must be distinguishable in the log from the
     * assigned manager's — a reviewer reading `report.approve` rows has to be able to
     * tell "the manager approved" from "somebody stepped around the manager".
     */
    canDecide.mockImplementation(async (...args: unknown[]) => args[3] === true);
    const db = makeDb();
    await (await callerFor(db, ADMIN)).decide({ taskId: TASK, approve: true });
    expect(canDecide).toHaveBeenCalledWith(expect.anything(), TASK, ME, true);
    expect(audited[0]?.details).toMatchObject({ taskId: TASK, override: true });
    expect(decideTask).toHaveBeenCalled();
  });

  it('refuses an AP clerk a task they were not assigned — read.all is not an override', async () => {
    /**
     * THE FINDING. The override used to be keyed on `expense.report.read.all`, which the
     * AP Clerk holds to work its queue — so an AP clerk could approve any report and
     * then, holding `reimburse`, pay it. The engine says "not eligible"; the router must
     * not have a second opinion on the strength of a read permission.
     */
    canDecide.mockResolvedValue(false);
    const db = makeDb();
    const c = await callerFor(db, AP_CLERK);
    await expect(c.decide({ taskId: TASK, approve: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(canDecide).not.toHaveBeenCalledWith(expect.anything(), TASK, ME, true);
    expect(decideTask).not.toHaveBeenCalled();
    expect(audited).toHaveLength(0);
  });

  it('audits an approval and a rejection as different actions', async () => {
    const db = makeDb();
    const c = await callerFor(db, []);
    await c.decide({ taskId: TASK, approve: true });
    const approveAction = audited[0]?.action;
    audited.length = 0;
    decideTask.mockResolvedValue(decided('REJECTED'));
    await c.decide({ taskId: TASK, approve: false, note: 'Missing receipt' });
    expect(audited[0]?.action).not.toBe(approveAction);
    expect(audited[0]?.details).toEqual({
      taskId: TASK,
      note: 'Missing receipt',
      override: false,
    });
  });

  it('records a null note rather than undefined', async () => {
    const db = makeDb();
    await (await callerFor(db, [])).decide({ taskId: TASK, approve: true });
    expect(audited[0]?.details).toEqual({ taskId: TASK, note: null, override: false });
  });

  it('pushes an approved report to NetSuite at once', async () => {
    /**
     * An approved report is a liability from the moment it is approved, so it posts on
     * the decision rather than when somebody remembers. The push itself is a no-op
     * unless this was the terminal decision.
     *
     * VeloExpense: the report's outcome, which queues the ledger post on the transition.
     */
    const db = makeDb();
    await (await callerFor(db, [])).decide({ taskId: TASK, approve: true });
    expect(recordReportOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reportId: REPORT, outcome: 'APPROVED', actor: { userId: ME } }),
    );
  });

  it('VeloExpense: names one step of several apart from the decision that ends it', async () => {
    // ExpenseOS writes `report.approve` either way. A step that leaves the approval running
    // is APPROVAL_STEP_APPROVED, and has no outcome: the report is still out for approval.
    decideTask.mockResolvedValue(decided('RUNNING'));
    const db = makeDb();
    await (await callerFor(db, [])).decide({ taskId: TASK, approve: true });
    expect(audited).toEqual([
      { action: 'APPROVAL_STEP_APPROVED', details: { taskId: TASK, note: null, override: false } },
    ]);
    expect(recordReportOutcome).not.toHaveBeenCalled();
  });

  it('runs the workflow effects the engine fired', async () => {
    const db = makeDb();
    await (await callerFor(db, [])).decide({ taskId: TASK, approve: true });
    expect(executeWorkflowEffects).toHaveBeenCalledWith(expect.anything(), {
      subjectType: 'EXPENSE_REPORT',
      subjectId: REPORT,
      effectNodeIds: ['e1'],
      actorId: ME,
    });
  });

  it('notifies on the decision', async () => {
    const db = makeDb();
    decideTask.mockResolvedValue(decided('REJECTED'));
    await (await callerFor(db, [])).decide({ taskId: TASK, approve: false });
    expect(notifyReportDecision).toHaveBeenCalled();
  });

  it('bounds the note', async () => {
    const c = await callerFor(makeDb(), []);
    await expect(
      c.decide({ taskId: TASK, approve: true, note: 'x'.repeat(2001) }),
    ).rejects.toThrow();
  });
});

/*
 * VeloExpense (w4-05/w4-07, d71): ported with the inbox. Each approval runs through
 * `decideThroughEngine`, as a single `decide` does: the engine is asked twice per task (the
 * router's fast refusal, then the action's body), so a case that scripted ExpenseOS's calls in
 * ORDER answers per task instead; the audit rows are VeloExpense's (`audited` — the report's
 * outcome row carries the details), and the post on approval is `recordReportOutcome`.
 * ExpenseOS's "requires the reimburse permission" family is `markReimbursed`, not ported (d71).
 */
describe('decideBulk', () => {
  it('is approve-only by design', async () => {
    // A bulk reject would need a per-report reason, which belongs in the single flow.
    const c = await callerFor(makeDb(), []);
    await c.decideBulk({ taskIds: [TASK] });
    expect(decideTask).toHaveBeenCalledWith(expect.anything(), TASK, true, ME, null);
  });

  it('reports each skipped task with its reason', async () => {
    /**
     * A partial result has to be visible. Failing the batch on one stale task would
     * make an inbox group action unusable — there is always one stale row.
     */
    const db = makeDb();
    db.approvalTask.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(task({ status: 'APPROVED' }))
      .mockResolvedValueOnce(task())
      .mockResolvedValue(task());
    // VeloExpense: per task — U('6') is not the caller's; the rest are.
    canDecide.mockImplementation(async (...args: unknown[]) => args[1] !== U('6'));
    const c = await callerFor(db, []);
    const out = await c.decideBulk({ taskIds: [U('4'), U('5'), U('6'), TASK] });
    expect(out.skipped).toEqual([
      { taskId: U('4'), reason: 'not_found' },
      { taskId: U('5'), reason: 'not_pending' },
      { taskId: U('6'), reason: 'forbidden' },
    ]);
    expect(out.approved).toEqual([TASK]);
  });

  it('skips, rather than approves, every task an AP clerk was not assigned', async () => {
    // The bulk variant of the finding: 100 task ids at once, none of them theirs.
    canDecide.mockResolvedValue(false);
    const db = makeDb();
    const c = await callerFor(db, AP_CLERK);
    const out = await c.decideBulk({ taskIds: [U('4'), TASK] });
    expect(out.approved).toEqual([]);
    expect(out.skipped.map((s: { reason: string }) => s.reason)).toEqual([
      'forbidden',
      'forbidden',
    ]);
    expect(decideTask).not.toHaveBeenCalled();
  });

  it('labels each override in a batch on its own audit row', async () => {
    // First task: assigned to the caller. Second: somebody else's, taken on the override.
    // VeloExpense: per task, as above.
    canDecide.mockImplementation(async (...args: unknown[]) => args[1] === U('4') || args[3] === true);
    const db = makeDb();
    const out = await (await callerFor(db, ADMIN)).decideBulk({ taskIds: [U('4'), TASK] });
    expect(out.approved).toEqual([U('4'), TASK]);
    expect(audited.map((a) => (a.details as { override: boolean }).override)).toEqual([false, true]);
  });

  it('keeps going after a skip', async () => {
    const db = makeDb();
    db.approvalTask.findUnique.mockResolvedValueOnce(null).mockResolvedValue(task());
    const c = await callerFor(db, []);
    const out = await c.decideBulk({ taskIds: [U('4'), TASK] });
    expect(out.approved).toEqual([TASK]);
    expect(decideTask).toHaveBeenCalledOnce();
  });

  it('marks each audit row as part of a bulk action', async () => {
    // So the trail distinguishes a considered single approval from a group click.
    const db = makeDb();
    await (await callerFor(db, [])).decideBulk({ taskIds: [TASK] });
    expect(audited[0]?.details).toMatchObject({ bulk: true });
  });

  it('posts and notifies for each approval', async () => {
    const db = makeDb();
    await (await callerFor(db, [])).decideBulk({ taskIds: [TASK, U('7')] });
    expect(recordReportOutcome).toHaveBeenCalledTimes(2);
    expect(notifyReportDecision).toHaveBeenCalledTimes(2);
  });

  it('requires at least one id and caps the batch', async () => {
    const c = await callerFor(makeDb(), []);
    await expect(c.decideBulk({ taskIds: [] })).rejects.toThrow();
    await expect(
      c.decideBulk({ taskIds: Array.from({ length: 101 }, () => TASK) }),
    ).rejects.toThrow();
  });
});

describe('reassign', () => {
  /** VeloExpense (d37): a reason is required. */
  const NOTE = 'On leave until the 20th.';

  it('is authorized like a decision', async () => {
    // Whoever could decide it can instead hand it to somebody else.
    canDecide.mockResolvedValue(false);
    const db = makeDb();
    const c = await callerFor(db, []);
    await expect(c.reassign({ taskId: TASK, toUserId: U('3'), note: NOTE })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses an AP clerk, and audits an override holder’s reassignment as an override', async () => {
    // Reassigning is deciding by another name: the same key, the same label on the row.
    canDecide.mockResolvedValue(false);
    await expect(
      (await callerFor(makeDb(), AP_CLERK)).reassign({ taskId: TASK, toUserId: U('3'), note: NOTE }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    canDecide.mockReset();
    canDecide.mockImplementation(async (...args: unknown[]) => args[3] === true);
    await (await callerFor(makeDb(), ADMIN)).reassign({ taskId: TASK, toUserId: U('3'), note: NOTE });
    expect(audited[0]?.details).toMatchObject({ toUserId: U('3'), override: true });
  });

  it('404s an unknown task and refuses a decided one', async () => {
    const missing = makeDb();
    missing.approvalTask.findUnique.mockResolvedValue(null);
    await expect(
      (await callerFor(missing, [])).reassign({ taskId: TASK, toUserId: U('3'), note: NOTE }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const done = makeDb();
    done.approvalTask.findUnique.mockResolvedValue(task({ status: 'APPROVED' }));
    await expect(
      (await callerFor(done, [])).reassign({ taskId: TASK, toUserId: U('3'), note: NOTE }),
    ).rejects.toThrow(/already decided/);
  });

  it('requires the new assignee to be an active employee', async () => {
    // Reassigning to a departed account parks the report where nobody will see it.
    const db = makeDb();
    db.user.findFirst.mockResolvedValue(null);
    const c = await callerFor(db, []);
    await expect(c.reassign({ taskId: TASK, toUserId: U('3'), note: NOTE })).rejects.toThrow(
      /Unknown or inactive assignee/,
    );
  });

  it('notifies the new assignee', async () => {
    const db = makeDb();
    await (await callerFor(db, [])).reassign({ taskId: TASK, toUserId: U('3'), note: NOTE });
    expect(notifyReportReassigned).toHaveBeenCalled();
  });

  it('VeloExpense: requires a reason, and passes it to the submitter with the new assignee (d37)', async () => {
    const c = await callerFor(makeDb(), []);
    await expect(c.reassign({ taskId: TASK, toUserId: U('3'), note: '   ' })).rejects.toThrow();
    await c.reassign({ taskId: TASK, toUserId: U('3'), note: `  ${NOTE}  ` });
    expect(notifyReportReassigned).toHaveBeenCalledWith(expect.anything(), REPORT, ME, U('3'), {
      note: NOTE,
      assigneeName: 'Pat',
    });
  });

  it('VeloExpense: refuses the submitter, and the person who already holds it, as the target', async () => {
    const toSubmitter = makeDb();
    await expect(
      (await callerFor(toSubmitter, [])).reassign({ taskId: TASK, toUserId: U('8'), note: NOTE }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const toHolder = makeDb();
    await expect(
      (await callerFor(toHolder, [])).reassign({ taskId: TASK, toUserId: ME, note: NOTE }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(toSubmitter.approvalTask.update).not.toHaveBeenCalled();
    expect(toHolder.approvalTask.update).not.toHaveBeenCalled();
  });
});

describe('returnForEdit', () => {
  it('only returns a SUBMITTED report', async () => {
    /**
     * Returning an approved or already-returned report would reopen something whose
     * decision has already been acted on downstream.
     */
    for (const status of ['DRAFT', 'APPROVED', 'RETURNED', 'REIMBURSED']) {
      const db = makeDb();
      db.expenseReport.findUnique.mockResolvedValue({
        id: REPORT,
        status,
        approvalInstanceId: 'inst-1',
      });
      const c = await callerFor(db, ADMIN);
      await expect(
        c.returnForEdit({ reportId: REPORT, note: 'Please attach the receipt' }),
        status,
      ).rejects.toThrow();
    }
  });

  it('404s a report that does not exist', async () => {
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue(null);
    const c = await callerFor(db, ADMIN);
    await expect(c.returnForEdit({ reportId: REPORT, note: 'Fix it' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses somebody who could not decide it', async () => {
    const db = makeDb();
    const c = await callerFor(db, []);
    await expect(c.returnForEdit({ reportId: REPORT, note: 'Fix it' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('lets an admin return it without holding a task, and says so on the audit row', async () => {
    const db = makeDb();
    const c = await callerFor(db, ADMIN);
    await expect(
      c.returnForEdit({ reportId: REPORT, note: 'Please attach the receipt' }),
    ).resolves.toBeTruthy();
    expect(audited[0]?.details).toMatchObject({ override: true });
  });

  it('records an eligible approver’s return as an ordinary one, override or not', async () => {
    // Eligibility is asked before the override, so a holder who IS an approver is the
    // approver — there is one pending task and the engine says it is theirs.
    // VeloExpense: `callerCanDecideReport` is that question (ExpenseOS: `canDecideReport`).
    callerCanDecideReport.mockResolvedValue(true);
    const db = makeDb();
    await (await callerFor(db, ADMIN)).returnForEdit({ reportId: REPORT, note: 'Fix it' });
    expect(audited[0]?.details).toMatchObject({ override: false });
  });

  it('refuses an AP clerk who holds no task — read.all does not return a report either', async () => {
    const db = makeDb();
    const c = await callerFor(db, AP_CLERK);
    await expect(c.returnForEdit({ reportId: REPORT, note: 'Fix it' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(audited).toHaveLength(0);
  });

  it('skips the pending tasks, cancels the instance and returns the report', async () => {
    /**
     * All three, or the report sits in RETURNED with live approval tasks — every
     * approver still sees it in their inbox while the submitter is editing it.
     */
    const db = makeDb();
    const c = await callerFor(db, ADMIN);
    await c.returnForEdit({ reportId: REPORT, note: 'Fix it' });
    expect(db.approvalTask.updateMany).toHaveBeenCalledWith({
      where: { instanceId: 'inst-1', status: 'PENDING' },
      data: { status: 'SKIPPED' },
    });
    const instance = db.approvalInstance.update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(instance.status).toBe('CANCELLED');
    expect(instance.completedAt).toBeInstanceOf(Date);
    expect(db.expenseReport.update.mock.calls[0]?.[0]?.data).toMatchObject({
      status: 'RETURNED',
    });
  });

  it('returns a report that had no approval instance', async () => {
    // An auto-approved report can still be returned.
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue({
      id: REPORT,
      status: 'SUBMITTED',
      approvalInstanceId: null,
    });
    const c = await callerFor(db, ADMIN);
    await expect(c.returnForEdit({ reportId: REPORT, note: 'Fix it' })).resolves.toBeTruthy();
    expect(db.approvalInstance.update).not.toHaveBeenCalled();
  });

  it('notifies the submitter', async () => {
    const db = makeDb();
    await (await callerFor(db, ADMIN)).returnForEdit({ reportId: REPORT, note: 'Fix it' });
    expect(notifyReportReturned).toHaveBeenCalled();
  });
});

describe('setFxOverride', () => {
  /**
   * AP pins the rate a card statement actually charged. The override re-stamps every
   * foreign expense's home amount and the report total — the figures the approver
   * signs and NetSuite posts on approval — so it is allowed only while the decision is
   * pending, and only within shouting distance of the daily rate.
   */
  const fxReport = (status: string) => ({
    id: REPORT,
    status,
    currency: { code: 'CAD' },
    fxRateOverrideCurrency: null,
    expenses: [
      { id: U('5'), currency: { code: 'USD' } },
      { id: U('6'), currency: { code: 'CAD' } },
    ],
  });
  const fxDb = (status: string, daily: string | null = '1.37') =>
    makeDb({
      expenseReport: {
        findUnique: stubFn(async () => fxReport(status) as unknown),
        update: stubFn(async () => ({ id: REPORT })),
      },
      fxRate: {
        // `resolveExpenseFx` asks for the published pair first, then its reciprocal,
        // then a pivot; one direct row answers the first question.
        findFirst: stubFn(async () => (daily === null ? null : { rate: daily }) as unknown),
        findMany: stubFn(async () => [] as unknown[]),
      },
    });

  it('is a finance-admin grant, not a payment one: reimburse alone is FORBIDDEN', async () => {
    /**
     * Segregation of duties. The AP Clerk holds `reimburse` next to `netsuite.sync.push`;
     * with the override on `reimburse` one role could decide what a report's total was
     * and then send it to the ledger. The gate is `expense.report.fxOverride`, which AP
     * never holds (`systemRoles.test.ts`) — so setting AND clearing are refused before
     * the report is even read.
     */
    const db = fxDb('SUBMITTED');
    const c = await callerFor(db, AP);
    await expect(
      c.setFxOverride({ reportId: REPORT, rate: '1.40', fromCurrency: 'USD' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.setFxOverride({ reportId: REPORT, rate: null })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.expenseReport.findUnique).not.toHaveBeenCalled();
    expect(db.expenseReport.update).not.toHaveBeenCalled();
    expect(snapshotExpensesFx).not.toHaveBeenCalled();
  });

  it('records who set it, which is what the posting rule reads', async () => {
    /** `fxRateOverrideById` is the name `netsuiteSync.approveExpenseReportPosting`
     *  refuses; a stamp without the author would leave the two-person rule blind. */
    const db = fxDb('SUBMITTED');
    const c = await callerFor(db, FX);
    await c.setFxOverride({ reportId: REPORT, rate: '1.40', fromCurrency: 'USD' });
    expect(db.expenseReport.update.mock.calls[0][0]).toMatchObject({
      data: { fxRateOverrideById: ME, fxRateOverride: '1.40' },
    });
    await c.setFxOverride({ reportId: REPORT, rate: null });
    expect(db.expenseReport.update.mock.calls[1][0]).toMatchObject({
      data: { fxRateOverrideById: null, fxRateOverride: null },
    });
  });

  it('is refused on anything but a SUBMITTED report, setting or clearing', async () => {
    for (const status of ['DRAFT', 'APPROVED', 'REIMBURSED', 'REJECTED', 'RETURNED']) {
      const db = fxDb(status);
      const c = await callerFor(db, FX);
      const set = await c
        .setFxOverride({ reportId: REPORT, rate: '1.40', fromCurrency: 'USD' })
        .catch((e: unknown) => e);
      expect(set).toMatchObject({ code: 'PRECONDITION_FAILED' });
      // The popover renders this key in the reader's language, not the English message.
      expect(refusalData(set)).toEqual({ key: REFUSAL_KEYS.fxOverrideNotSubmitted });
      const cleared = await c
        .setFxOverride({ reportId: REPORT, rate: null })
        .catch((e: unknown) => e);
      expect(cleared).toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(refusalData(cleared)).toEqual({ key: REFUSAL_KEYS.fxOverrideNotSubmitted });
      expect(snapshotExpensesFx).not.toHaveBeenCalled();
      expect(recomputeReportTotal).not.toHaveBeenCalled();
      expect(db.expenseReport.update).not.toHaveBeenCalled();
    }
  });

  it('stamps a statement rate onto the foreign expenses of a SUBMITTED report', async () => {
    const db = fxDb('SUBMITTED');
    const c = await callerFor(db, FX);
    await c.setFxOverride({ reportId: REPORT, rate: '1.40', fromCurrency: 'USD' });
    expect(snapshotExpensesFx).toHaveBeenCalledWith(db, {
      expenseIds: [U('5')],
      force: { rate: '1.40', source: 'MANUAL' },
    });
    expect(recomputeReportTotal).toHaveBeenCalledWith(db, REPORT);
    // VeloExpense: VeloExpense's registry name for ExpenseOS's `report.fxOverride`.
    expect(withAuditCalls[0]).toMatchObject({ action: 'REPORT_FX_OVERRIDE_SET' });
  });

  it('refuses a rate more than 2× away from the daily rate', async () => {
    // USD 730 approved at CAD 1,000 became CAD 10,000 with one extra digit.
    const db = fxDb('SUBMITTED');
    const c = await callerFor(db, FX);
    for (const rate of ['13.7', '0.5']) {
      const err = await c
        .setFxOverride({ reportId: REPORT, rate, fromCurrency: 'USD' })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringMatching(/away from the daily rate 1.37/),
      });
      // Everything the sentence needs, so the French one can say the same figures.
      expect(refusalData(err)).toEqual({
        key: REFUSAL_KEYS.fxRateFarFromDaily,
        params: { rate, band: 2, reference: '1.37', from: 'USD', home: 'CAD' },
      });
    }
    expect(snapshotExpensesFx).not.toHaveBeenCalled();
    expect(db.expenseReport.update).not.toHaveBeenCalled();
  });

  it('falls back to a hard cap when no daily rate exists', async () => {
    const db = fxDb('SUBMITTED', null);
    const c = await callerFor(db, FX);
    const err = await c
      .setFxOverride({ reportId: REPORT, rate: '1000001', fromCurrency: 'USD' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/no greater/),
    });
    expect(refusalData(err)).toEqual({
      key: REFUSAL_KEYS.fxRateOutOfBounds,
      params: { max: 1_000_000 },
    });
    await c.setFxOverride({ reportId: REPORT, rate: '5', fromCurrency: 'USD' });
    expect(snapshotExpensesFx).toHaveBeenCalledOnce();
  });
});

describe('the report-total guard, seen from the router', () => {
  /**
   * `setFxOverride` is the one SUBMITTED-stage caller of `recomputeReportTotal`, so it is
   * where a frozen total would surface in review: the status check above it passes
   * (SUBMITTED), the override is stamped, and then the recompute finds — say — a
   * NetSuite posting already in flight. The typed refusal must reach the reviewer as a
   * precondition, not as a 500 that hides what happened. The caller holds
   * `expense.report.fxOverride`: since the segregation-of-duties split, restating a rate
   * is a finance-admin grant, so AP would be refused before the guard is ever reached.
   */
  const fxReport = {
    id: REPORT,
    status: 'SUBMITTED',
    currency: { code: 'CAD' },
    fxRateOverrideCurrency: null,
    expenses: [{ id: U('5'), currency: { code: 'USD' } }],
  };

  it("refuses with PRECONDITION_FAILED and the guard's reason", async () => {
    const { ReportTotalFrozenError } =
      await vi.importActual<typeof import('@expenseos/db')>('@expenseos/db');
    recomputeReportTotal.mockRejectedValueOnce(
      new ReportTotalFrozenError(REPORT, 'SUBMITTED', 'PROCESSING'),
    );
    const db = makeDb({
      expenseReport: {
        findUnique: stubFn(async () => fxReport as unknown),
        update: stubFn(async () => ({ id: REPORT })),
      },
      fxRate: {
        findFirst: stubFn(async () => ({ rate: '1.37' }) as unknown),
        findMany: stubFn(async () => [] as unknown[]),
      },
    });
    const c = await callerFor(db, FX);
    await expect(
      c.setFxOverride({ reportId: REPORT, rate: '1.40', fromCurrency: 'USD' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      // VeloExpense: the tenant's ledger rather than NetSuite (`ReportTotalFrozenError`).
      message: expect.stringMatching(/ledger posting is PROCESSING/),
    });
  });
});

/** One CAD expense on a SUBMITTED report, read through `report`. */
const expense = (allocations: unknown[], lineItems: unknown[] = []) => ({
  id: U('e'),
  merchant: 'Cafe',
  placeText: null,
  date: new Date('2026-10-01T00:00:00Z'),
  explanation: null,
  attendees: [],
  amountMinor: 1000n,
  taxGstHstMinor: null,
  taxQstMinor: null,
  currency: { code: 'CAD', symbol: '$' },
  fxRate: null,
  fxRateSource: null,
  homeCurrency: null,
  homeAmountMinor: null,
  lineItems,
  allocations,
  receipts: [],
});

function reportDb(expenses: unknown[]) {
  const findUnique = stubFn(
    async () =>
      ({
        id: REPORT,
        number: 'R-1',
        title: 'Trip',
        purpose: null,
        status: 'SUBMITTED',
        totalMinor: 1000n,
        currency: { code: 'CAD', symbol: '$' },
        submittedAt: new Date('2026-10-02T00:00:00Z'),
        submitterId: U('3'),
        approvalInstanceId: null,
        // VeloExpense: the submitter's one display name, and violations read on their own.
        submitter: {
          id: U('3'),
          name: 'Ann Lee',
          email: 'ann@example.com',
          entity: null,
        },
        expenses,
      }) as unknown,
  );
  const db = makeDb({
    expenseReport: { findUnique },
    policyViolation: { findMany: stubFn(async () => [] as unknown[]) },
  });
  return { db, findUnique };
}

// VeloExpense: receipts are presigned through VeloExpense's storage; in memory here.
beforeAll(async () => {
  const { MemoryStorage, setStorage } = await import('@/lib/storage');
  setStorage(new MemoryStorage());
});

/** AP reads every report (`canViewReport`), which keeps these cases off the auth path. */
const readReport = async (expenses: unknown[]) => {
  const { db, findUnique } = reportDb(expenses);
  const out = await (await callerFor(db, AP)).report({ reportId: REPORT });
  return { findUnique, out };
};

/*
 * VeloExpense (eos-573): ExpenseOS's cases, less NetSuite. VeloExpense posts to no NetSuite and
 * has no class (see `expenses.ts`), so there is no business-unit source to read: a line names
 * the admin business unit and its department, as `expenses.report` sends it. ExpenseOS's two
 * NETSUITE-source cases are not carried; the rest keep their assertions with the NetSuite and
 * class fields at the null `expenses.report` sends.
 */
describe('report: the coding the approver signs off on', () => {
  /** A coded line: an admin business unit and a department. */
  const allocation = (over: Record<string, unknown> = {}) => ({
    id: U('a'),
    expenseId: U('e'),
    percentBp: 10000,
    businessUnitId: U('b'),
    businessUnit: { id: U('b'), label: 'Admin BU' },
    departmentId: U('d'),
    department: { id: U('d'), label: 'Finance' },
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  });

  it('sends the coding: the admin business unit and department, no NetSuite label, no class', async () => {
    const { out } = await readReport([expense([allocation()])]);
    expect(out.expenses[0]?.allocations).toEqual([
      {
        id: U('a'),
        percentBp: 10000,
        businessUnitId: U('b'),
        businessUnit: { id: U('b'), label: 'Admin BU' },
        nsBusinessUnitLabel: null,
        departmentId: U('d'),
        department: { id: U('d'), label: 'Finance' },
        classId: null,
        class: null,
      },
    ]);
  });

  it('returns no lines for an uncoded expense', async () => {
    const { out } = await readReport([expense([])]);
    expect(out.expenses[0]?.allocations).toEqual([]);
  });

  it('sends only the named fields — no foreign keys, no picker state', async () => {
    const { out } = await readReport([expense([allocation()])]);
    const [line] = out.expenses[0]?.allocations ?? [];
    expect(line).toBeDefined();
    expect(line).not.toHaveProperty('pickerNsBusinessUnitId');
    expect(line).not.toHaveProperty('nsBusinessUnitId');
    expect(line).not.toHaveProperty('expenseId');
    expect(line).not.toHaveProperty('createdAt');
  });

  it('loads the report once, with the allocations include', async () => {
    const { findUnique } = await readReport([expense([allocation()])]);
    expect(findUnique).toHaveBeenCalledTimes(1);
    const [args] = findUnique.mock.calls[0] ?? [];
    expect(args?.include.expenses.include.allocations).toEqual({
      orderBy: { createdAt: 'asc' },
      include: {
        businessUnit: { select: { id: true, label: true } },
        department: { select: { id: true, label: true } },
      },
    });
  });
});

describe('report: the mileage claim the approver signs off on', () => {
  /** What Prisma hands back for a `Decimal` column, as far as the mapping reads it. */
  const dec = (v: string) => ({ toString: () => v });

  /** A filed MILEAGE line: A → B → C, 12 km + 8 km by the lookup, 15 km claimed. */
  const mileageLine = (over: Record<string, unknown> = {}) => ({
    id: U('l'),
    expenseId: U('e'),
    kind: 'MILEAGE',
    payload: null,
    categoryId: U('k'),
    category: { id: U('k'), label: 'Mileage', icon: 'car' },
    glAccountId: U('g'),
    amountMinor: 1050n,
    notes: 'Client visit',
    mileageDistance: dec('15.00'),
    mileageUnit: 'KM',
    mileageRateId: U('r'),
    mileageYtdBefore: dec('120.00'),
    mileageBreakdown: [
      { fromDistance: '120.00', rateMinor: 70, distance: '15.00', amountMinor: 1050 },
    ],
    mileageRoute: {
      stops: [
        { placeId: 'place-A', description: 'Office' },
        { placeId: 'place-B', description: 'Client' },
        { placeId: 'place-C', description: 'Home' },
      ],
      legs: [
        { fromPlaceId: 'place-A', toPlaceId: 'place-B', meters: 12_000 },
        { fromPlaceId: 'place-B', toPlaceId: 'place-C', meters: 8_000 },
      ],
    },
    mileageDistanceOverride: dec('15.00'),
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  });

  /** A meal whose mileage columns still hold values: stale columns on a non-mileage
   *  line must not reach the wire either. */
  const STANDARD_LINE = {
    ...mileageLine(),
    kind: 'STANDARD',
    category: { id: U('m'), label: 'Meals', icon: 'tools-kitchen' },
    notes: 'Lunch',
  };

  const readLines = async (lineItems: unknown[]) => {
    const { out } = await readReport([expense([], lineItems)]);
    return out.expenses[0]?.lineItems ?? [];
  };

  it('maps a MILEAGE line by name, with the trimmed route and the route distance', async () => {
    const [line] = await readLines([mileageLine()]);
    expect(line).toEqual({
      id: U('l'),
      category: { id: U('k'), label: 'Mileage', icon: 'car' },
      kind: 'MILEAGE',
      amountMinor: '1050',
      mileageDistance: '15.00',
      mileageUnit: 'KM',
      mileageBreakdown: [
        { fromDistance: '120.00', rateMinor: 70, distance: '15.00', amountMinor: 1050 },
      ],
      mileageRoute: {
        stops: [{ description: 'Office' }, { description: 'Client' }, { description: 'Home' }],
      },
      routeDistance: '20.00',
      mileageRouteUnavailable: false,
    });
  });

  it('never sends legs, place ids, the rate id, the override, notes or the YTD', async () => {
    // A route the write path accepted with keys nobody asked for, at both levels.
    const extraKeyRoute = {
      stops: [
        { placeId: 'place-A', description: 'Office', lat: 45.5, lng: -73.6, extra: 'x' },
        { placeId: 'place-B', description: 'Client', lat: 45.6, lng: -73.7, extra: 'x' },
      ],
      legs: [{ fromPlaceId: 'place-A', toPlaceId: 'place-B', meters: 12_000 }],
      // The chosen route: its label and the number offered reach the approver, its
      // position among them does not.
      routeLabel: 'Hwy 401',
      routeIndex: 1,
      routeCount: 3,
      lat: 45.5,
      lng: -73.6,
      extra: { anything: true },
    };
    const { out } = await readReport([
      expense(
        [],
        [mileageLine(), mileageLine({ id: U('n'), mileageRoute: extraKeyRoute }), STANDARD_LINE],
      ),
    ]);
    // The extra-key route was read, not refused: its stop names are on the wire.
    expect(out.expenses[0]?.lineItems[1]?.mileageRoute).toEqual({
      stops: [{ description: 'Office' }, { description: 'Client' }],
      routeLabel: 'Hwy 401',
      routeCount: 3,
    });
    const wire = JSON.stringify(out);
    for (const key of [
      'legs',
      'placeId',
      'routeIndex',
      'mileageRateId',
      'mileageDistanceOverride',
      'notes',
      'mileageYtdBefore',
    ]) {
      expect(wire).not.toContain(key);
    }
    // As JSON keys: the bare letters occur inside ordinary words on the wire.
    for (const key of ['lat', 'lng', 'extra']) {
      expect(wire).not.toContain(`"${key}"`);
    }
    expect(wire).not.toContain('place-A');
    expect(wire).not.toContain('Client visit');
  });

  it('rebuilds the breakdown by name, dropping keys the engine never writes', async () => {
    const [line] = await readLines([
      mileageLine({
        mileageBreakdown: [
          {
            fromDistance: '0.00',
            rateMinor: '70',
            distance: '5.00',
            amountMinor: '350',
            extra: 'x',
          },
          { fromDistance: '5.00', rateMinor: 64, distance: 10, amountMinor: 640, ytd: '120.00' },
        ],
      }),
    ]);
    expect(line?.mileageBreakdown).toEqual([
      { fromDistance: '0.00', rateMinor: '70', distance: '5.00', amountMinor: '350' },
      { fromDistance: '5.00', rateMinor: 64, distance: 10, amountMinor: 640 },
    ]);
    expect(line?.mileageBreakdown?.[0]).not.toHaveProperty('extra');
    expect(line?.mileageBreakdown?.[1]).not.toHaveProperty('ytd');
  });

  it.each([
    ['not an array', { fromDistance: '0.00' }],
    ['an entry that is not an object', ['0.00']],
    ['an entry missing a field', [{ fromDistance: '0.00', rateMinor: 70, distance: '1.00' }]],
    [
      'an entry with a non-primitive field',
      [{ fromDistance: '0.00', rateMinor: { n: 70 }, distance: '1.00', amountMinor: 70 }],
    ],
    [
      'an entry with a non-finite number',
      [{ fromDistance: '0.00', rateMinor: Number.NaN, distance: '1.00', amountMinor: 70 }],
    ],
  ])('sends a null breakdown, and still answers, for %s', async (_case, mileageBreakdown) => {
    const [line] = await readLines([mileageLine({ mileageBreakdown })]);
    expect(line?.mileageBreakdown).toBeNull();
    expect(line?.mileageDistance).toBe('15.00');
  });

  it('gives the route distance in miles on a mile-denominated line', async () => {
    const [line] = await readLines([
      mileageLine({ mileageUnit: 'MI', mileageDistance: dec('9.00') }),
    ]);
    expect(line?.routeDistance).toBe('12.43');
  });

  it('hides the route distance when the claim is the route', async () => {
    const [line] = await readLines([mileageLine({ mileageDistance: dec('20.00') })]);
    expect(line?.routeDistance).toBeNull();
    expect(line?.mileageRoute?.stops).toHaveLength(3);
  });

  it('says an unreadable route is unavailable, and still answers', async () => {
    const [line] = await readLines([mileageLine({ mileageRoute: '{"stops": [' })]);
    expect(line).toMatchObject({
      mileageRoute: null,
      routeDistance: null,
      mileageRouteUnavailable: true,
      mileageDistance: '15.00',
    });
  });

  it('tells a line with no route from one with an unreadable route', async () => {
    const [line] = await readLines([mileageLine({ mileageRoute: null })]);
    expect(line).toMatchObject({ mileageRoute: null, mileageRouteUnavailable: false });
  });

  it('sends null for every mileage field on a STANDARD line, whatever its columns hold', async () => {
    const [line] = await readLines([STANDARD_LINE]);
    expect(line).toEqual({
      id: U('l'),
      category: { id: U('m'), label: 'Meals', icon: 'tools-kitchen' },
      kind: 'STANDARD',
      amountMinor: '1050',
      mileageDistance: null,
      mileageUnit: null,
      mileageBreakdown: null,
      mileageRoute: null,
      routeDistance: null,
      mileageRouteUnavailable: false,
    });
  });
});
