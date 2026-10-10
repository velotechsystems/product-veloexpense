// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
 * VeloExpense: ExpenseOS's `expenseApprovals.test.ts`, for the procedures ported in w2-02a —
 * `decide`, `reassign`, `returnForEdit` and `setFxOverride` (d36). The inbox, `decideBulk`
 * and `markReimbursed` come with Wave 4.
 *
 * The boundary moves. ExpenseOS's router calls its engine piece by piece (`canDecide`,
 * `decideTask`, `withAudit`, the notify and post hooks), so its cases assert on each piece.
 * VeloExpense's router hands the whole transition to VeloExpense's engine
 * (`decideThroughEngine`, `reassignThroughEngine`), which checks eligibility, audits with
 * the override flag, hands an approved report to the ledger and notifies — so here the
 * cases assert what the router decides (the fast refusals, the override it passes, the
 * task it picks), and a case about what the ENGINE does is marked with where it is proven:
 * `expenseApprovals.db.test.ts`, against the real engine. `setFxOverride` keeps its own
 * pieces, and its cases are ExpenseOS's.
 */

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
  };
});
vi.mock('@/auth', () => ({ auth: stubFn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const recomputeReportTotal = stubFn(async () => {});
const snapshotExpensesFx = stubFn(async () => {});
vi.mock('@expenseos/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@expenseos/db');
  return { ...actual, recomputeReportTotal, snapshotExpensesFx };
});

/** VeloExpense: the engine, at the adapter the router calls. */
const decideThroughEngine = stubFn(async () => ({
  decision: 'APPROVED',
  requestStatus: 'APPROVED',
  reportStatus: 'APPROVED',
  nextTaskId: null,
}));
const reassignThroughEngine = stubFn(async () => ({
  reportId: '00000000-0000-7000-8000-000000000002',
  fromUserId: null,
  toUserId: '00000000-0000-7000-8000-000000000003',
}));
vi.mock('@/server/lib/reportLifecycle', () => ({ decideThroughEngine, reassignThroughEngine }));
const resolveDecidableTask = vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null);
vi.mock('@/server/lib/reportApproval', () => ({
  resolveDecidableTask,
  callerCanDecideReport: stubFn(async () => false),
}));

const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const ME = U('9');
const TASK = U('1');
const REPORT = U('2');

function makeDb(over: Record<string, unknown> = {}) {
  return {
    expenseReport: {
      findUnique: vi.fn(async () => ({ id: REPORT, status: 'SUBMITTED' }) as unknown),
      findMany: stubFn(async () => [] as unknown[]),
      update: stubFn(async () => ({ id: REPORT, status: 'RETURNED' })),
    },
    expense: { findMany: stubFn(async () => [] as unknown[]) },
    /** VeloExpense: the task's status, read with SQL (`taskStatusOf`). */
    $queryRaw: vi.fn(async () => [{ status: 'PENDING' }] as unknown[]),
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
  resolveDecidableTask.mockResolvedValue(null);
});

describe('decide', () => {
  it('404s an unknown task', async () => {
    const db = makeDb();
    db.$queryRaw.mockResolvedValue([]);
    const c = await callerFor(db, []);
    await expect(c.decide({ taskId: TASK, approve: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a task already decided', async () => {
    /**
     * Two approvers clicking at once, or a stale inbox tab, must not both count — and
     * the check is on a fresh read rather than on anything the client sent.
     *
     * VeloExpense: VeloExpense's terminal task statuses (it has no EXPIRED).
     */
    for (const status of ['APPROVED', 'REJECTED', 'SKIPPED', 'CANCELLED']) {
      const db = makeDb();
      db.$queryRaw.mockResolvedValue([{ status }]);
      const c = await callerFor(db, []);
      await expect(c.decide({ taskId: TASK, approve: true }), status).rejects.toThrow(
        /already decided/,
      );
    }
    expect(decideThroughEngine).not.toHaveBeenCalled();
  });

  it('defers eligibility to the engine', async () => {
    // Delegation, approver pools and admin override all live there; re-implementing
    // any of it here is how the inbox and the decision start disagreeing.
    // VeloExpense: the engine's refusal comes back through the adapter as FORBIDDEN
    // (`toTrpcError`); the router asks nothing itself.
    const { TRPCError } = await import('@trpc/server');
    decideThroughEngine.mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN' }));
    const db = makeDb();
    const c = await callerFor(db, []);
    await expect(c.decide({ taskId: TASK, approve: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('asks the engine on the task’s own terms first, and records no override for an assignee', async () => {
    // An override holder who IS the assignee is the assignee: one engine call, no
    // override flag, and the audit row says so.
    // VeloExpense: the engine asks `canDecide` without the override first and labels the
    // row — proven against the real engine in expenseApprovals.db.test.ts. Here: the
    // router hands it the override, and nothing else decides.
    const db = makeDb();
    await (await callerFor(db, ADMIN)).decide({ taskId: TASK, approve: true });
    expect(decideThroughEngine).toHaveBeenCalledTimes(1);
    expect(decideThroughEngine).toHaveBeenCalledWith(
      db,
      TASK,
      ME,
      'APPROVED',
      { note: null, receiptViewAcknowledged: undefined },
      true,
    );
  });

  it('lets the override decide a task that is not theirs, and audits it as an override', async () => {
    /**
     * `expense.report.decide.any` is the only thing that reaches the engine's admin
     * branch, and a decision made on it must be distinguishable in the log from the
     * assigned manager's — a reviewer reading `report.approve` rows has to be able to
     * tell "the manager approved" from "somebody stepped around the manager".
     *
     * VeloExpense: the audit half is the engine's (expenseApprovals.db.test.ts).
     */
    const db = makeDb();
    await (await callerFor(db, ADMIN)).decide({ taskId: TASK, approve: true });
    expect(decideThroughEngine.mock.calls[0]?.[5]).toBe(true);
  });

  it('refuses an AP clerk a task they were not assigned — read.all is not an override', async () => {
    /**
     * THE FINDING. The override used to be keyed on `expense.report.read.all`, which the
     * AP Clerk holds to work its queue — so an AP clerk could approve any report and
     * then, holding `reimburse`, pay it. The engine says "not eligible"; the router must
     * not have a second opinion on the strength of a read permission.
     *
     * VeloExpense: the router never hands the engine the override on `read.all`.
     */
    const db = makeDb();
    await (await callerFor(db, AP_CLERK)).decide({ taskId: TASK, approve: true });
    expect(decideThroughEngine.mock.calls[0]?.[5]).toBe(false);
  });

  it('audits an approval and a rejection as different actions', async () => {
    // VeloExpense: the engine writes REPORT_APPROVED / REPORT_REJECTED (and the step's
    // own row); here, the router asks for two different decisions with the note.
    const db = makeDb();
    const c = await callerFor(db, []);
    await c.decide({ taskId: TASK, approve: true });
    await c.decide({ taskId: TASK, approve: false, note: 'Missing receipt' });
    expect(decideThroughEngine.mock.calls.map((call) => call[3])).toEqual(['APPROVED', 'REJECTED']);
    expect(decideThroughEngine.mock.calls[1]?.[4]).toMatchObject({ note: 'Missing receipt' });
  });

  it('records a null note rather than undefined', async () => {
    const db = makeDb();
    await (await callerFor(db, [])).decide({ taskId: TASK, approve: true });
    expect(decideThroughEngine.mock.calls[0]?.[4]).toMatchObject({ note: null });
  });

  // VeloExpense: ExpenseOS's "pushes an approved report to NetSuite at once" and "runs the
  // workflow effects the engine fired" are the engine's in VeloExpense — it enqueues the
  // ledger post on the approving transition (VX3-4) and has no workflow effects; and
  // "notifies on the decision" is the engine's too. The db suite proves the post and the
  // notification against the real engine.

  it('bounds the note', async () => {
    const c = await callerFor(makeDb(), []);
    await expect(
      c.decide({ taskId: TASK, approve: true, note: 'x'.repeat(2001) }),
    ).rejects.toThrow();
  });

  it('VeloExpense: passes on the receipt acknowledgement a VeloExpense step can require', async () => {
    const db = makeDb();
    await (await callerFor(db, [])).decide({
      taskId: TASK,
      approve: true,
      receiptViewAcknowledged: true,
    });
    expect(decideThroughEngine.mock.calls[0]?.[4]).toMatchObject({
      receiptViewAcknowledged: true,
    });
  });
});

describe('reassign', () => {
  const REASON = 'On leave until the 20th.';

  it('is authorized like a decision', async () => {
    // Whoever could decide it can instead hand it to somebody else.
    // VeloExpense: the engine's eligibility guard, through the adapter.
    const { TRPCError } = await import('@trpc/server');
    reassignThroughEngine.mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN' }));
    const db = makeDb();
    const c = await callerFor(db, []);
    await expect(
      c.reassign({ taskId: TASK, toUserId: U('3'), note: REASON }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses an AP clerk, and audits an override holder’s reassignment as an override', async () => {
    // Reassigning is deciding by another name: the same key, the same label on the row.
    // VeloExpense: the override reaches the engine only on `decide.any`; the row is the
    // engine's (expenseApprovals.db.test.ts).
    await (await callerFor(makeDb(), AP_CLERK)).reassign({
      taskId: TASK,
      toUserId: U('3'),
      note: REASON,
    });
    expect(reassignThroughEngine.mock.calls[0]?.[5]).toBe(false);
    await (await callerFor(makeDb(), ADMIN)).reassign({
      taskId: TASK,
      toUserId: U('3'),
      note: REASON,
    });
    expect(reassignThroughEngine.mock.calls[1]?.[5]).toBe(true);
  });

  it('404s an unknown task and refuses a decided one', async () => {
    const missing = makeDb();
    missing.$queryRaw.mockResolvedValue([]);
    await expect(
      (await callerFor(missing, [])).reassign({ taskId: TASK, toUserId: U('3'), note: REASON }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const done = makeDb();
    done.$queryRaw.mockResolvedValue([{ status: 'APPROVED' }]);
    await expect(
      (await callerFor(done, [])).reassign({ taskId: TASK, toUserId: U('3'), note: REASON }),
    ).rejects.toThrow(/already decided/);
  });

  // VeloExpense: "requires the new assignee to be an active employee" and "notifies the new
  // assignee" are the engine's (`reassignTask`), proven against it in the db suite.

  it('VeloExpense: requires a reason, and hands it to the engine (d37)', async () => {
    const c = await callerFor(makeDb(), []);
    await expect(c.reassign({ taskId: TASK, toUserId: U('3'), note: '   ' })).rejects.toThrow();
    expect(reassignThroughEngine).not.toHaveBeenCalled();
    await c.reassign({ taskId: TASK, toUserId: U('3'), note: `  ${REASON}  ` });
    expect(reassignThroughEngine).toHaveBeenCalledWith(
      expect.anything(),
      TASK,
      ME,
      U('3'),
      REASON,
      false,
    );
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
      db.expenseReport.findUnique.mockResolvedValue({ id: REPORT, status });
      const c = await callerFor(db, ADMIN);
      await expect(
        c.returnForEdit({ reportId: REPORT, note: 'Please attach the receipt' }),
        status,
      ).rejects.toThrow();
    }
    expect(decideThroughEngine).not.toHaveBeenCalled();
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
    expect(decideThroughEngine).not.toHaveBeenCalled();
  });

  it('lets an admin return it without holding a task, and says so on the audit row', async () => {
    // VeloExpense: VeloExpense's engine closes a run through a task, so the override
    // returns it through the report's pending task, as an override — the row is the
    // engine's (db suite).
    resolveDecidableTask.mockImplementation(async (...args: unknown[]) =>
      args[3] === true ? TASK : null,
    );
    const db = makeDb();
    const c = await callerFor(db, ADMIN);
    await expect(
      c.returnForEdit({ reportId: REPORT, note: 'Please attach the receipt' }),
    ).resolves.toMatchObject({ status: 'RETURNED' });
    expect(decideThroughEngine).toHaveBeenCalledWith(
      db,
      TASK,
      ME,
      'RETURNED',
      { note: 'Please attach the receipt' },
      true,
    );
  });

  it('records an eligible approver’s return as an ordinary one, override or not', async () => {
    // Eligibility is asked before the override, so a holder who IS an approver is the
    // approver — there is one pending task and the engine says it is theirs.
    resolveDecidableTask.mockResolvedValue(TASK);
    const db = makeDb();
    await (await callerFor(db, ADMIN)).returnForEdit({ reportId: REPORT, note: 'Fix it' });
    expect(resolveDecidableTask).toHaveBeenCalledTimes(1);
    expect(resolveDecidableTask).toHaveBeenCalledWith(db, REPORT, ME, false);
    expect(decideThroughEngine.mock.calls[0]?.[5]).toBe(false);
  });

  it('refuses an AP clerk who holds no task — read.all does not return a report either', async () => {
    const db = makeDb();
    const c = await callerFor(db, AP_CLERK);
    await expect(c.returnForEdit({ reportId: REPORT, note: 'Fix it' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Never asked on the override's terms.
    expect(resolveDecidableTask).not.toHaveBeenCalledWith(db, REPORT, ME, true);
    expect(decideThroughEngine).not.toHaveBeenCalled();
  });

  // VeloExpense: "skips the pending tasks, cancels the instance and returns the report" is
  // the engine's RETURNED decision (it closes the run and cancels its other tasks), proven
  // in the db suite; "returns a report that had no approval instance" does not arise — every
  // VeloExpense submit opens a run; "notifies the submitter" is the engine's, with the note.
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
