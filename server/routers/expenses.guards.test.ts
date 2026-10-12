// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REFUSAL_KEYS, refusalData } from '@/server/refusal';
import { stubFn } from '@/test-utils/stubFn';
import { makeContext } from '../__test-helpers__/trpcCaller';

/**
 * The expense router's OWNERSHIP and EDITABILITY gates — the guards every one of its
 * thirty-odd procedures funnels through, and the paths the database-backed suites do
 * not reach because they exercise the happy path.
 *
 * Three rules, each of which fails silently if it regresses:
 *
 *   · **A stranger's expense is NOT FOUND, not FORBIDDEN.** Returning 403 confirms the
 *     id exists, which turns any expense endpoint into an existence oracle over other
 *     people's spending.
 *   · **A submitted report is read-only to its submitter.** `DRAFT` and `RETURNED` are
 *     the only editable states — RETURNED because an approver sending it back is
 *     precisely an invitation to edit. Without the check, somebody could change the
 *     amounts under an approver mid-review.
 *   · **An unfiled expense is always editable by its owner.** It has no report to take
 *     a status from, and treating a missing report as "not editable" would strand every
 *     expense created before it was filed.
 *
 * VeloExpense: ExpenseOS's `expenses.guards.test.ts`, for the procedures ported so far
 * (w2-07: `list`, `categories`, `currencies`, `deleteReport`, `updateReport`; w2-08b: the
 * expense, line and tax procedures — the ownership, editability, manual-tax and input
 * blocks; w2-08c: `report` — the read-access block, with the approvals mock; w2-03:
 * `dimensionOptions` in the permission gates; w2-09: the receipt procedures — the receipt
 * upload and removal blocks, with VeloExpense's storage mocked; w2-11: `submit`,
 * `justifyViolation` and `recall` — the submit cases in the report-level block, and the
 * justification and recall blocks, with VeloExpense's policy pass and lifecycle adapter
 * mocked). The harness below is ExpenseOS's, less the mocks for what is not ported (jobs,
 * the approval engine, NetSuite); `@/auth` is VeloExpense's session module.
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

const callerCanDecideReport = stubFn(async () => false);
vi.mock('@/server/lib/reportApproval', () => ({ callerCanDecideReport }));

/**
 * The step `submit` takes before the policy pass. Stubbed as ExpenseOS stubs it: the rollup
 * is arithmetic with its own tests.
 */
vi.mock('@expenseos/db', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    reportRollupFor: vi.fn(async () => ({ homeCurrency: 'CAD', missingRates: [] })),
  };
});

/**
 * VeloExpense: w2-11. VeloExpense's policy pass in place of ExpenseOS's
 * `@/server/policy/validate`, and the lifecycle adapter (d23) in place of its approval
 * engine and the notify / post / effects hooks. Both have their own database-backed suites;
 * here they are the boundary the guards stop at.
 */
const policyPass = vi.fn(async () => ({
  violations: [] as unknown[],
  counts: { INFO: 0, WARNING: 0, BLOCK: 0 },
  blocking: false,
  unjustifiedWarning: 0,
}));
const acknowledgeViolation = stubFn(async () => ({}));
const clearAcknowledgement = stubFn(async () => {});
vi.mock('@/lib/policy/service', () => ({
  validateReport: policyPass,
  acknowledgeViolation,
  clearAcknowledgement,
}));
// w4-00c: the lifecycle starts the engine and hands back its result; ExpenseOS's hooks after
// it (notify the first approvers, the workflow's effects, tell the recalled approvers) are
// the procedure's, so they are spied on here.
const submitThroughLifecycle = stubFn(async () => ({
  approval: { instanceId: 'inst-1', status: 'RUNNING', createdTaskIds: ['t-1'], firedEffects: ['n-1'] },
}));
const recallThroughLifecycle = stubFn(async () => ({
  id: REPORT,
  status: 'DRAFT',
  cancelledTaskIds: ['t-1'],
}));
vi.mock('@/server/lib/reportLifecycle', () => ({
  submitThroughLifecycle,
  recallThroughLifecycle,
}));
const notifyReportSubmitted = stubFn(async () => {});
const notifyReportRecalled = stubFn(async () => {});
vi.mock('@/server/lib/reportNotify', () => ({ notifyReportSubmitted, notifyReportRecalled }));
const executeWorkflowEffects = stubFn(async () => {});
vi.mock('@/server/lib/workflowEffects', () => ({ executeWorkflowEffects }));

/**
 * VeloExpense: VeloExpense's storage (`getStorage`) in place of ExpenseOS's
 * `@expenseos/storage`. `getUploadUrl` keeps ExpenseOS's name for the spy on the upload
 * signer, VeloExpense's `presignUpload`; `head` reports an object of 100 bytes, which is what
 * `receiptCreate` reads back before recording one (d29).
 */
const getUploadUrl = stubFn(async () => ({ url: 'https://s3/put', headers: {}, expiresInSeconds: 300 }));
vi.mock('@/lib/storage', () => ({
  getStorage: () => ({
    presignUpload: getUploadUrl,
    presignDownload: stubFn(async () => 'https://s3/get'),
    head: stubFn(async () => ({ sizeBytes: 100, contentType: 'application/pdf' })),
    delete: stubFn(async () => {}),
  }),
}));

const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const ME = U('9');
const EXPENSE = U('1');
const REPORT = U('2');
/** VeloExpense: the tenant `app.current_org` names, for a receipt key's prefix. */
const ORG = U('5');

/** An expense owned by the caller, filed on a draft report. */
const owned = (over: Record<string, unknown> = {}) => ({
  reportId: REPORT,
  ownerId: ME,
  report: { submitterId: ME, status: 'DRAFT' },
  ...over,
});

function makeDb(over: Record<string, unknown> = {}) {
  return {
    expense: {
      findUnique: stubFn(async () => owned() as unknown),
      // What the tax bound reads: the gross the paid tax is checked against.
      findUniqueOrThrow: stubFn(
        async () =>
          ({
            amountMinor: 11398n,
            taxGstHstMinor: null,
            taxQstMinor: null,
            taxPstMinor: null,
            currency: { code: 'CAD' },
          }) as unknown,
      ),
      findMany: stubFn(async () => [] as unknown[]),
      update: stubFn(async () => ({ id: EXPENSE })),
      delete: stubFn(async () => ({ id: EXPENSE })),
      deleteMany: stubFn(async () => ({ count: 1 })),
      create: stubFn(async () => ({ id: EXPENSE })),
      count: stubFn(async () => 0),
    },
    expenseReport: {
      findUnique: stubFn(async () => ({ id: REPORT, submitterId: ME, status: 'DRAFT' }) as unknown),
      findMany: stubFn(async () => [] as unknown[]),
      update: stubFn(async () => ({ id: REPORT })),
      delete: stubFn(async () => ({ id: REPORT })),
      create: stubFn(async () => ({ id: REPORT, number: 'EXP-1', expenses: [] })),
      count: stubFn(async () => 0),
    },
    receipt: {
      findUnique: stubFn(async () => null as unknown),
      findMany: stubFn(async () => [] as unknown[]),
      create: stubFn(async () => ({ id: 'rc1' })),
      delete: stubFn(async () => ({ id: 'rc1' })),
      update: stubFn(async () => ({ id: 'rc1' })),
    },
    expenseLineItem: {
      findUnique: stubFn(async () => null as unknown),
      findMany: stubFn(async () => [] as unknown[]),
      create: stubFn(async () => ({ id: 'li1' })),
      update: stubFn(async () => ({ id: 'li1' })),
      delete: stubFn(async () => ({ id: 'li1' })),
    },
    expenseAllocation: {
      deleteMany: stubFn(async () => ({ count: 0 })),
      createMany: stubFn(async () => ({ count: 0 })),
    },
    expenseCategory: { findMany: stubFn(async () => [] as unknown[]) },
    currency: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => null as unknown),
    },
    fxRate: { findMany: stubFn(async () => [] as unknown[]) },
    documentExtraction: { findMany: stubFn(async () => [] as unknown[]) },
    businessUnit: { findMany: stubFn(async () => [] as unknown[]) },
    department: { findMany: stubFn(async () => [] as unknown[]) },
    netSuiteClass: { findMany: stubFn(async () => [] as unknown[]) },
    netSuiteLocation: { findMany: stubFn(async () => [] as unknown[]) },
    user: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: stubFn(async () => null as unknown),
    },
    policyViolation: {
      findMany: stubFn(async () => [] as unknown[]),
      findUnique: vi.fn(
        async () => ({ id: U('4'), severity: 'WARNING', report: { submitterId: ME } }) as unknown,
      ),
      update: stubFn(async () => ({ id: U('4') })),
      updateMany: stubFn(async () => ({ count: 0 })),
    },
    approvalTask: {
      findMany: stubFn(async () => [] as unknown[]),
      updateMany: stubFn(async () => ({ count: 0 })),
    },
    approvalInstance: { update: stubFn(async () => ({ id: 'inst-1' })) },
    integration: { findUnique: stubFn(async () => null as unknown) },
    virtualCardTransaction: { findMany: stubFn(async () => [] as unknown[]) },
    // VeloExpense: tagged raw SQL — `report`'s violations and posting row, and the tenant's id
    // and slug a receipt key and link are built from. One row that answers the last two.
    $queryRaw: stubFn(async () => [{ id: ORG, slug: 'acme' }] as unknown[]),
    $transaction: vi.fn(async (fn: unknown) =>
      typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(over.self ?? undefined) : fn,
    ),
    ...over,
  };
}

async function callerFor(db: unknown, permissions: readonly string[] = [], userId = ME) {
  const { createCallerFactory } = await import('@/server/trpc');
  const { expensesRouter } = await import('./expenses');
  return createCallerFactory(expensesRouter)(
    makeContext({ db, userId, permissions, roleLabel: 'Employee' }),
  );
}

/**
 * Assert the GUARD let the call through — not that the whole procedure succeeded.
 *
 * Past the ownership/editability check these procedures go on to serialise a full
 * report, which needs far more of the schema than a guard test should have to stub.
 * The database-backed suites cover that. What matters here is the negative: the call
 * did not stop at NOT_FOUND ("not yours") or at "Report is not editable".
 */
async function passesGuard(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    expect(err.code, `guard rejected: ${err.message}`).not.toBe('NOT_FOUND');
    expect(err.message ?? '').not.toMatch(/not editable/);
  }
}

const UPDATE = [P.expense.report.updateOwn] as const;
const READ = [P.expense.report.readOwn] as const;
beforeEach(() => {
  vi.clearAllMocks();
  withAuditCalls.length = 0;
  callerCanDecideReport.mockResolvedValue(false);
});

describe('permission gates', () => {
  it('refuses read procedures without readOwn', async () => {
    const db = makeDb();
    const c = await callerFor(db, []);
    for (const attempt of [
      c.list({}),
      c.categories(),
      c.currencies(),
      c.dimensionOptions(),
      c.receiptList({ expenseId: EXPENSE }),
    ]) {
      await expect(attempt).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('refuses write procedures without updateOwn', async () => {
    const db = makeDb();
    const c = await callerFor(db, READ);
    for (const attempt of [
      c.updateExpense({ expenseId: EXPENSE } as never),
      c.deleteExpense({ expenseId: EXPENSE }),
      c.lineItemRemove({ id: U('3') }),
      c.receiptRemove({ id: U('3') }),
    ]) {
      await expect(attempt).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('separates deleting a draft report from editing it', async () => {
    // Deleting a whole report is its own permission — a stronger act than editing.
    const db = makeDb();
    const c = await callerFor(db, UPDATE);
    await expect(c.deleteReport({ reportId: REPORT })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('expense ownership', () => {
  /**
   * NOT_FOUND rather than FORBIDDEN throughout. A 403 confirms the id exists, which
   * turns any of these endpoints into an existence oracle over other people's spending.
   */
  const strangersExpense = () => ({
    reportId: REPORT,
    ownerId: U('3'),
    report: { submitterId: U('3'), status: 'DRAFT' },
  });

  it('hides a stranger’s expense behind NOT_FOUND', async () => {
    const db = makeDb();
    db.expense.findUnique.mockResolvedValue(strangersExpense());
    const c = await callerFor(db, [...UPDATE, ...READ]);
    for (const attempt of [
      c.updateExpense({ expenseId: EXPENSE } as never),
      c.deleteExpense({ expenseId: EXPENSE }),
      c.receiptList({ expenseId: EXPENSE }),
    ]) {
      await expect(attempt).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('hides an expense that does not exist the same way', async () => {
    // Indistinguishable from a stranger's, which is the point.
    const db = makeDb();
    db.expense.findUnique.mockResolvedValue(null);
    const c = await callerFor(db, UPDATE);
    await expect(c.deleteExpense({ expenseId: EXPENSE })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('lets the report SUBMITTER edit an expense they do not own', async () => {
    /**
     * A report can carry expenses created by somebody else (a receipt filed on their
     * behalf), so ownership is "owner OR report submitter" — restricting it to the
     * owner alone would lock the submitter out of their own report.
     */
    const db = makeDb();
    db.expense.findUnique.mockResolvedValue({
      reportId: REPORT,
      ownerId: U('3'),
      report: { submitterId: ME, status: 'DRAFT' },
    });
    const c = await callerFor(db, UPDATE);
    await passesGuard(c.deleteExpense({ expenseId: EXPENSE }));
  });

  it('lets the OWNER edit an expense on somebody else’s report', async () => {
    const db = makeDb();
    db.expense.findUnique.mockResolvedValue({
      reportId: REPORT,
      ownerId: ME,
      report: { submitterId: U('3'), status: 'DRAFT' },
    });
    const c = await callerFor(db, UPDATE);
    await passesGuard(c.deleteExpense({ expenseId: EXPENSE }));
  });
});

describe('report editability', () => {
  it('refuses edits once the report has been submitted', async () => {
    /**
     * A submitted report is read-only to its submitter. Without this, somebody could
     * change the amounts under an approver who is mid-review, and the decision would
     * describe something that no longer exists.
     */
    for (const status of ['SUBMITTED', 'APPROVED', 'REJECTED', 'REIMBURSED']) {
      const db = makeDb();
      db.expense.findUnique.mockResolvedValue(owned({ report: { submitterId: ME, status } }));
      const c = await callerFor(db, UPDATE);
      await expect(c.updateExpense({ expenseId: EXPENSE } as never), status).rejects.toThrow(
        /not editable/,
      );
    }
  });

  it('allows edits on a RETURNED report', async () => {
    // An approver returning a report is precisely an invitation to edit it.
    const db = makeDb();
    db.expense.findUnique.mockResolvedValue(
      owned({ report: { submitterId: ME, status: 'RETURNED' } }),
    );
    const c = await callerFor(db, UPDATE);
    await passesGuard(c.updateExpense({ expenseId: EXPENSE } as never));
  });

  it('always allows edits to an unfiled expense', async () => {
    /**
     * An unfiled expense has no report to take a status from. Treating the missing
     * report as "not editable" would strand every expense created before filing.
     */
    const db = makeDb();
    db.expense.findUnique.mockResolvedValue({ reportId: null, ownerId: ME, report: null });
    const c = await callerFor(db, UPDATE);
    await passesGuard(c.updateExpense({ expenseId: EXPENSE } as never));
  });
});

describe('report-level guards', () => {
  it('refuses to submit somebody else’s report', async () => {
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue({
      id: REPORT,
      submitterId: U('3'),
      status: 'DRAFT',
      expenses: [],
    });
    const c = await callerFor(db, [P.expense.report.createOwn]);
    await expect(c.submit({ reportId: REPORT })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to submit a report that is not editable', async () => {
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue({
      id: REPORT,
      submitterId: ME,
      status: 'SUBMITTED',
      expenses: [],
    });
    const c = await callerFor(db, [P.expense.report.createOwn]);
    await expect(c.submit({ reportId: REPORT })).rejects.toThrow();
  });

  // VeloExpense: ExpenseOS's six NetSuite coding cases ("refuses to submit a report NetSuite
  // could never accept", the expense/expenses wording, the three unresolved-category cases
  // and "does not invent a coding rule when NetSuite is not installed") pin a guard VeloExpense
  // does not have: its coding gate is the lifecycle's (UD-2, only with a connected ledger),
  // covered in `test/lifecycle.db.test.ts`.

  it('waits for a receipt still being read, ahead of every other content check', async () => {
    /**
     * A late reading rewrites the amounts, so every check below it — rates, tax, total,
     * coding, policy — is provisional until it lands. The coding gap is set up here too,
     * and the sentence has to be the reading's: telling the submitter to code an expense
     * whose amount is about to change would send them to fix the wrong thing first.
     *
     * VeloExpense: there is no NetSuite coding gate to set up (see above), so the checks
     * that must not be reached are the policy pass and the lifecycle's transition.
     */
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue({
      id: REPORT,
      submitterId: ME,
      status: 'DRAFT',
      totalMinor: 10_000n,
      expenses: [],
    });
    db.expense.count.mockResolvedValue(1);
    db.documentExtraction.findMany.mockResolvedValue([
      { scanStatus: 'CLEAN', status: 'EXTRACTING', error: null, updatedAt: new Date() },
      { scanStatus: 'SCANNING', status: 'PENDING', error: null, updatedAt: new Date() },
      // Parked by the worker — not in flight, not counted.
      {
        scanStatus: 'CLEAN',
        status: 'PENDING',
        error: 'extraction not configured',
        updatedAt: new Date(),
      },
    ]);
    const c = await callerFor(db, [P.expense.report.createOwn]);
    await expect(c.submit({ reportId: REPORT })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^2 receipts are still being read\./),
    });
    expect(policyPass).not.toHaveBeenCalled();
    expect(submitThroughLifecycle).not.toHaveBeenCalled();
  });

  it('VeloExpense: refuses an unjustified warning before the transition (d34)', async () => {
    // ExpenseOS's gate, on VeloExpense's policy pass: the refusal carries the result, and
    // the lifecycle is never asked.
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue({
      id: REPORT,
      submitterId: ME,
      status: 'DRAFT',
      totalMinor: 10_000n,
    });
    db.expense.count.mockResolvedValue(1);
    policyPass.mockResolvedValueOnce({
      violations: [],
      counts: { INFO: 0, WARNING: 1, BLOCK: 0 },
      blocking: false,
      unjustifiedWarning: 1,
    });
    const c = await callerFor(db, [P.expense.report.createOwn]);
    await expect(c.submit({ reportId: REPORT })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Report has unresolved policy violations.',
    });
    expect(submitThroughLifecycle).not.toHaveBeenCalled();
  });

  it('VeloExpense: hands a clean, RETURNED report to the lifecycle as the caller', async () => {
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue({
      id: REPORT,
      submitterId: ME,
      status: 'RETURNED',
      totalMinor: 10_000n,
    });
    db.expense.count.mockResolvedValue(1);
    (db.expenseReport as Record<string, unknown>).findUniqueOrThrow = stubFn(async () => ({
      id: REPORT,
      status: 'SUBMITTED',
      totalMinor: 10_000n,
    }));
    const c = await callerFor(db, [P.expense.report.createOwn]);
    const res = await c.submit({ reportId: REPORT });
    expect(submitThroughLifecycle).toHaveBeenCalledWith(db, REPORT, ME);
    // ExpenseOS's hooks after the start: the first approvers, then the workflow's effects.
    expect(notifyReportSubmitted).toHaveBeenCalledWith(db, REPORT, ME, ['t-1']);
    expect(executeWorkflowEffects).toHaveBeenCalledWith(db, {
      subjectType: 'EXPENSE_REPORT',
      subjectId: REPORT,
      effectNodeIds: ['n-1'],
      actorId: ME,
    });
    expect(res.report).toMatchObject({ status: 'SUBMITTED', totalMinor: '10000' });
    expect(res.counts).toEqual({ info: 0, warning: 0, block: 0, unjustifiedWarning: 0 });
  });

  it('refuses to delete a report that is not a draft', async () => {
    // Deleting a submitted report would erase what an approver is looking at.
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue({
      id: REPORT,
      submitterId: ME,
      status: 'SUBMITTED',
    });
    const c = await callerFor(db, [P.expense.report.deleteDraft]);
    await expect(c.deleteReport({ reportId: REPORT })).rejects.toThrow();
  });

  it('refuses to delete somebody else’s draft', async () => {
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue({
      id: REPORT,
      submitterId: U('3'),
      status: 'DRAFT',
    });
    const c = await callerFor(db, [P.expense.report.deleteDraft]);
    await expect(c.deleteReport({ reportId: REPORT })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to edit the header of a submitted report', async () => {
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue({
      id: REPORT,
      submitterId: ME,
      status: 'APPROVED',
    });
    const c = await callerFor(db, UPDATE);
    await expect(c.updateReport({ reportId: REPORT, title: 'New' } as never)).rejects.toThrow();
  });
});

describe('manual tax bound', () => {
  it('refuses paid tax that exceeds the expense amount', async () => {
    /**
     * MANUAL figures are trusted verbatim from here to the ledger: the engine takes
     * them as the split, the allocator multiplies them by the category ITC%, and the
     * poster carves the recoverable out with `net = gross − recoverable`. $5,000.00 of
     * GST on a $113.98 lunch therefore posted a $2,500 ITC receivable and a NEGATIVE
     * meals line, while the report total the approver saw stayed $113.98.
     */
    const db = makeDb();
    const c = await callerFor(db, UPDATE);
    await expect(
      c.expenseTaxUpdate({
        expenseId: EXPENSE,
        taxSource: 'MANUAL',
        taxGstHstMinor: 500000n,
      } as never),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message:
        'Tax of 5000.00 CAD exceeds the expense amount of 113.98 CAD. Tax cannot be more than what was paid.',
    });
    expect(db.expense.update).not.toHaveBeenCalled();
  });

  it('sums the components, keeping any that are left unchanged', async () => {
    // GST 60 + QST 60 is fine on its own; with 100 of PST already stored it is not.
    const db = makeDb();
    db.expense.findUniqueOrThrow.mockResolvedValue({
      amountMinor: 200n,
      taxGstHstMinor: null,
      taxQstMinor: null,
      taxPstMinor: 100n,
      currency: { code: 'CAD' },
    });
    const c = await callerFor(db, UPDATE);
    await expect(
      c.expenseTaxUpdate({
        expenseId: EXPENSE,
        taxSource: 'MANUAL',
        taxGstHstMinor: '60',
        taxQstMinor: '60',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/2.20 CAD/) });
    // Clearing the PST explicitly brings the sum back under.
    await passesGuard(
      c.expenseTaxUpdate({
        expenseId: EXPENSE,
        taxSource: 'MANUAL',
        taxGstHstMinor: '60',
        taxQstMinor: '60',
        taxPstMinor: null,
      } as never),
    );
    expect(db.expense.update).toHaveBeenCalled();
  });

  it('accepts tax within the amount, and does not bound CALCULATED at all', async () => {
    const db = makeDb();
    const c = await callerFor(db, UPDATE);
    await passesGuard(
      c.expenseTaxUpdate({
        expenseId: EXPENSE,
        taxSource: 'MANUAL',
        taxGstHstMinor: 500n,
      } as never),
    );
    // CALCULATED hands the figure back to the engine; the typed amounts are ignored.
    await passesGuard(
      c.expenseTaxUpdate({
        expenseId: EXPENSE,
        taxSource: 'CALCULATED',
        taxGstHstMinor: 500000n,
      } as never),
    );
    expect(db.expense.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });
});

describe('receipt uploads', () => {
  const file = (contentType: string) => ({ filename: 'r.pdf', contentType, sizeBytes: 100 });

  it('refuses a content type receipts cannot hold', async () => {
    /**
     * The allowlist is the gate. These objects are later fetched and handed to the
     * extraction pipeline, so an arbitrary type is both an extraction failure and a
     * stored-content risk — and the filename is echoed back so the user knows which
     * file was rejected.
     */
    const db = makeDb();
    const c = await callerFor(db, UPDATE);
    await expect(
      c.receiptUploadUrl({ expenseId: EXPENSE, ...file('application/x-msdownload') } as never),
    ).rejects.toThrow(/Unsupported file type/);
    expect(getUploadUrl).not.toHaveBeenCalled();
  });

  describe('the declared size', () => {
    /**
     * The link is signed for the size the caller declares, so storage refuses a body of any
     * other length. The router's part: the size is required, within the receipt cap, and it
     * is the DECLARED size that reaches the signer. A router forwarding the cap instead would
     * pass every refusal test here and break every real upload.
     */
    const upload = (sizeBytes?: unknown) => ({
      expenseId: EXPENSE,
      filename: 'r.pdf',
      contentType: 'application/pdf',
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    });

    it.each([
      ['missing', undefined],
      ['zero', 0],
      ['negative', -1],
      ['fractional', 1.5],
      ['one byte over 10 MiB', 10_485_761],
    ])('refuses a %s size before minting a URL', async (_label, sizeBytes) => {
      const c = await callerFor(makeDb(), UPDATE);
      await expect(c.receiptUploadUrl(upload(sizeBytes) as never)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(getUploadUrl).not.toHaveBeenCalled();
    });

    // VeloExpense: `getUploadUrl` stands for VeloExpense's `presignUpload(key, contentType,
    // options)`, so the length is read off its third argument.
    it('accepts exactly 10 MiB', async () => {
      const c = await callerFor(makeDb(), UPDATE);
      await c.receiptUploadUrl(upload(10_485_760) as never);
      expect(getUploadUrl).toHaveBeenCalledWith(
        expect.any(String),
        'application/pdf',
        expect.objectContaining({ contentLength: 10_485_760 }),
      );
    });

    it('signs the link for the declared size, not the cap', async () => {
      const c = await callerFor(makeDb(), UPDATE);
      await c.receiptUploadUrl(upload(1234) as never);
      expect(getUploadUrl).toHaveBeenCalledTimes(1);
      expect(getUploadUrl).toHaveBeenCalledWith(
        expect.any(String),
        'application/pdf',
        expect.objectContaining({ contentLength: 1234 }),
      );
    });

    it('refuses a caller without the permission, even with a valid size', async () => {
      const c = await callerFor(makeDb(), READ);
      await expect(c.receiptUploadUrl(upload(1234) as never)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(getUploadUrl).not.toHaveBeenCalled();
    });
  });

  it('accepts a PDF and an image', async () => {
    const db = makeDb();
    const c = await callerFor(db, UPDATE);
    for (const type of ['application/pdf', 'image/jpeg', 'image/png']) {
      await passesGuard(c.receiptUploadUrl({ expenseId: EXPENSE, ...file(type) } as never));
    }
  });

  it('checks ownership before minting any URL', async () => {
    const db = makeDb();
    db.expense.findUnique.mockResolvedValue({
      reportId: REPORT,
      ownerId: U('3'),
      report: { submitterId: U('3'), status: 'DRAFT' },
    });
    const c = await callerFor(db, UPDATE);
    await expect(
      c.receiptUploadUrl({ expenseId: EXPENSE, ...file('application/pdf') } as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getUploadUrl).not.toHaveBeenCalled();
  });

  it('still allows attaching a receipt to a SUBMITTED report', async () => {
    /**
     * Documented deliberately, because it looks like a missing check: the attach path
     * uses `assertExpenseAttachable`, which admits SUBMITTED as well as the editable
     * statuses. Attaching supporting documentation is not editing the claim — an
     * approver asking for a missing receipt on a submitted report is a real flow, and
     * the worker refuses to redetermine a filed report's numbers from it.
     */
    const db = makeDb();
    db.expense.findUnique.mockResolvedValue(
      owned({ report: { submitterId: ME, status: 'SUBMITTED' } }),
    );
    const c = await callerFor(db, UPDATE);
    await expect(
      c.receiptUploadUrl({ expenseId: EXPENSE, ...file('application/pdf') } as never),
    ).resolves.toBeTruthy();
    await passesGuard(
      c.receiptCreate({
        expenseId: EXPENSE,
        // VeloExpense: under the tenant's prefix (`receiptPrefix`).
        key: `org/${ORG}/receipts/${REPORT}/x.pdf`,
        ...file('application/pdf'),
      } as never),
    );
  });

  it('refuses to attach anything once the report has been decided', async () => {
    /**
     * The window closes with the decision. NetSuite's File Cabinet push sends whatever
     * is on the report at post time, so a document added after approval is evidence
     * the approver never saw; and there is no post-approval attach path on purpose.
     */
    for (const status of ['APPROVED', 'REJECTED', 'REIMBURSED']) {
      const db = makeDb();
      db.expense.findUnique.mockResolvedValue(owned({ report: { submitterId: ME, status } }));
      db.receipt.findUnique.mockResolvedValue({
        id: 'rc1',
        s3Key: `${REPORT}/s.pdf`,
        expenseId: EXPENSE,
        filename: 's.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
        kind: 'BANK_STATEMENT',
        extraction: null,
      });
      db.receipt.findMany.mockResolvedValue([
        { id: 'rc1', expense: { ownerId: ME, report: { submitterId: ME, status } } },
      ]);
      const c = await callerFor(db, UPDATE);
      const refused = { code: 'BAD_REQUEST', message: expect.stringMatching(/decided/) };
      const upload = await c
        .receiptUploadUrl({ expenseId: EXPENSE, ...file('application/pdf') } as never)
        .catch((e: unknown) => e);
      expect(upload).toMatchObject(refused);
      expect(refusalData(upload)).toEqual({ key: REFUSAL_KEYS.documentsClosed });
      expect(getUploadUrl).not.toHaveBeenCalled();
      await expect(
        c.receiptCreate({
          expenseId: EXPENSE,
          key: `${REPORT}/x.pdf`,
          ...file('application/pdf'),
        } as never),
      ).rejects.toMatchObject(refused);
      expect(db.receipt.create).not.toHaveBeenCalled();
      await expect(
        c.statementApply({ receiptId: U('7'), expenseIds: [U('8')] } as never),
      ).rejects.toMatchObject(refused);
      const reread = await c.startExtraction({ receiptIds: [U('7')] }).catch((e: unknown) => e);
      expect(reread).toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringMatching(/decided/),
      });
      expect(refusalData(reread)).toEqual({ key: REFUSAL_KEYS.documentsRereadClosed });
    }
  });
});

describe('receipt removal and moves', () => {
  const receipt = {
    id: 'rc1',
    s3Key: `${REPORT}/r.pdf`,
    expenseId: EXPENSE,
    filename: 'r.pdf',
  };

  it('refuses to remove or move a document once the report is submitted', async () => {
    /**
     * Evidence on a filed report is what the approver looked at. `receiptRemove`
     * deletes the row AND the S3 object; `receiptMove` can delete the vacated expense
     * and restate the total. Both used to check ownership only, so a submitter could
     * strip the receipt off an APPROVED or REIMBURSED claim — or collapse two approved
     * expenses into one — after the fact. Both are draft-only writes now.
     */
    for (const status of ['SUBMITTED', 'APPROVED', 'REIMBURSED']) {
      const db = makeDb();
      db.expense.findUnique.mockResolvedValue(owned({ report: { submitterId: ME, status } }));
      db.receipt.findUnique.mockResolvedValue(receipt);
      const c = await callerFor(db, UPDATE);
      const removed = await c.receiptRemove({ id: U('7') }).catch((e: unknown) => e);
      expect(removed).toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringMatching(/not editable/),
      });
      // The browser renders this key, in the reader's language; the message is the log's.
      expect(refusalData(removed)).toEqual({ key: REFUSAL_KEYS.reportNotEditable });
      expect(db.receipt.delete).not.toHaveBeenCalled();
      const moved = await c
        .receiptMove({ id: U('7'), toExpenseId: U('8') })
        .catch((e: unknown) => e);
      expect(moved).toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringMatching(/not editable/),
      });
      expect(refusalData(moved)).toEqual({ key: REFUSAL_KEYS.reportNotEditable });
      expect(db.receipt.update).not.toHaveBeenCalled();
      expect(db.expense.delete).not.toHaveBeenCalled();
    }
  });

  it('still lets the submitter remove and move documents on a RETURNED report', async () => {
    // An approver sending it back is precisely an invitation to fix the evidence.
    const db = makeDb();
    db.expense.findUnique.mockResolvedValue(
      owned({ report: { submitterId: ME, status: 'RETURNED' } }),
    );
    db.receipt.findUnique.mockResolvedValue(receipt);
    const c = await callerFor(db, UPDATE);
    await passesGuard(c.receiptRemove({ id: U('7') }));
    expect(db.receipt.delete).toHaveBeenCalled();
    await passesGuard(c.receiptMove({ id: U('7'), toExpenseId: U('8') }));
    expect(db.receipt.update).toHaveBeenCalled();
  });
});

describe('manual tax bound', () => {
  it('refuses paid tax that exceeds the expense amount', async () => {
    /**
     * MANUAL figures are trusted verbatim from here to the ledger: the engine takes
     * them as the split, the allocator multiplies them by the category ITC%, and the
     * poster carves the recoverable out with `net = gross − recoverable`. $5,000.00 of
     * GST on a $113.98 lunch therefore posted a $2,500 ITC receivable and a NEGATIVE
     * meals line, while the report total the approver saw stayed $113.98.
     */
    const db = makeDb();
    const c = await callerFor(db, UPDATE);
    await expect(
      c.expenseTaxUpdate({
        expenseId: EXPENSE,
        taxSource: 'MANUAL',
        taxGstHstMinor: 500000n,
      } as never),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message:
        'Tax of 5000.00 CAD exceeds the expense amount of 113.98 CAD. Tax cannot be more than what was paid.',
    });
    expect(db.expense.update).not.toHaveBeenCalled();
  });

  it('sums the components, keeping any that are left unchanged', async () => {
    // GST 60 + QST 60 is fine on its own; with 100 of PST already stored it is not.
    const db = makeDb();
    db.expense.findUniqueOrThrow.mockResolvedValue({
      amountMinor: 200n,
      taxGstHstMinor: null,
      taxQstMinor: null,
      taxPstMinor: 100n,
      currency: { code: 'CAD' },
    });
    const c = await callerFor(db, UPDATE);
    await expect(
      c.expenseTaxUpdate({
        expenseId: EXPENSE,
        taxSource: 'MANUAL',
        taxGstHstMinor: '60',
        taxQstMinor: '60',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/2.20 CAD/) });
    // Clearing the PST explicitly brings the sum back under.
    await passesGuard(
      c.expenseTaxUpdate({
        expenseId: EXPENSE,
        taxSource: 'MANUAL',
        taxGstHstMinor: '60',
        taxQstMinor: '60',
        taxPstMinor: null,
      } as never),
    );
    expect(db.expense.update).toHaveBeenCalled();
  });

  it('accepts tax within the amount, and does not bound CALCULATED at all', async () => {
    const db = makeDb();
    const c = await callerFor(db, UPDATE);
    await passesGuard(
      c.expenseTaxUpdate({
        expenseId: EXPENSE,
        taxSource: 'MANUAL',
        taxGstHstMinor: 500n,
      } as never),
    );
    // CALCULATED hands the figure back to the engine; the typed amounts are ignored.
    await passesGuard(
      c.expenseTaxUpdate({
        expenseId: EXPENSE,
        taxSource: 'CALCULATED',
        taxGstHstMinor: 500000n,
      } as never),
    );
    expect(db.expense.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });
});

describe('report read access', () => {
  const reportRow = (submitterId: string) => ({
    id: REPORT,
    submitterId,
    status: 'SUBMITTED',
    expenses: [],
    currency: { code: 'CAD' },
  });

  it('lets the submitter read their own', async () => {
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue(reportRow(ME));
    const c = await callerFor(db, READ);
    await passesGuard(c.report({ reportId: REPORT }));
  });

  it('lets a reader-of-all read anybody’s', async () => {
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue(reportRow(U('3')));
    const c = await callerFor(db, [P.expense.report.readAll]);
    await passesGuard(c.report({ reportId: REPORT }));
  });

  it('lets AP read anybody’s, because they have to pay it', async () => {
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue(reportRow(U('3')));
    const c = await callerFor(db, [P.expense.report.reimburse]);
    await passesGuard(c.report({ reportId: REPORT }));
  });

  it('lets an approver on the report read it', async () => {
    // Eligibility is the approvals engine's question, including delegation.
    callerCanDecideReport.mockResolvedValue(true);
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue(reportRow(U('3')));
    const c = await callerFor(db, []);
    await passesGuard(c.report({ reportId: REPORT }));
  });

  it('hides a stranger’s report behind NOT_FOUND, not FORBIDDEN', async () => {
    /**
     * The same non-enumeration choice the expense guards make: a 403 would confirm the
     * report id exists, and report ids are sequential-ish numbers somebody could walk.
     */
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue(reportRow(U('3')));
    const c = await callerFor(db, READ);
    await expect(c.report({ reportId: REPORT })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses the submitter when they lack even readOwn', async () => {
    // Being the submitter is not itself a permission.
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue(reportRow(ME));
    const c = await callerFor(db, []);
    await expect(c.report({ reportId: REPORT })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('404s a report that does not exist', async () => {
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue(null);
    const c = await callerFor(db, [P.expense.report.readAll]);
    await expect(c.report({ reportId: REPORT })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('input validation', () => {
  it('rejects a non-uuid id everywhere', async () => {
    const db = makeDb();
    const c = await callerFor(db, [...UPDATE, ...READ]);
    for (const attempt of [
      c.deleteExpense({ expenseId: 'nope' } as never),
      c.receiptList({ expenseId: 'nope' } as never),
      c.report({ reportId: 'nope' } as never),
    ]) {
      await expect(attempt).rejects.toThrow();
    }
  });

  it('requires at least one id for a bulk delete', async () => {
    // An empty bulk delete would audit a no-op.
    const db = makeDb();
    const c = await callerFor(db, UPDATE);
    await expect(c.deleteExpenses({ ids: [] } as never)).rejects.toThrow();
  });

  it('accepts money as a bigint or a digit string', async () => {
    /**
     * superjson may send either, so both have to parse — and a non-numeric string must
     * not silently become NaN in a money column.
     */
    const db = makeDb();
    const c = await callerFor(db, UPDATE);
    await passesGuard(c.updateExpense({ expenseId: EXPENSE, amountMinor: '12345' } as never));
    await passesGuard(c.updateExpense({ expenseId: EXPENSE, amountMinor: 12345n } as never));
    await expect(
      c.updateExpense({ expenseId: EXPENSE, amountMinor: '12.34' } as never),
    ).rejects.toThrow();
    await expect(
      c.updateExpense({ expenseId: EXPENSE, amountMinor: 'lots' } as never),
    ).rejects.toThrow();
  });
});

describe('justifyViolation', () => {
  const caller = (db: unknown) => callerFor(db, UPDATE);
  /** VeloExpense: the violation lookup is SQL (`$queryRaw`), with the report's submitter. */
  const violation = (over: Record<string, unknown> = {}) => [
    { id: U('4'), severity: 'WARNING', reportId: REPORT, submitterId: ME, ...over },
  ];

  it('404s a violation on somebody else’s report', async () => {
    // Same non-enumeration rule: a 403 would confirm the violation exists.
    const db = makeDb();
    db.$queryRaw.mockResolvedValue(violation({ submitterId: U('3') }));
    await expect(
      (await caller(db)).justifyViolation({ violationId: U('4'), note: 'Client dinner' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('404s a violation that does not exist', async () => {
    const db = makeDb();
    db.$queryRaw.mockResolvedValue([]);
    await expect(
      (await caller(db)).justifyViolation({ violationId: U('4'), note: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to justify a BLOCK', async () => {
    /**
     * A BLOCK is the thing actually preventing the submission. Letting the submitter
     * write a note past it would be a self-service override with no approval behind it —
     * only WARNING and INFO are acknowledgeable.
     */
    const db = makeDb();
    db.$queryRaw.mockResolvedValue(violation({ severity: 'BLOCK' }));
    await expect(
      (await caller(db)).justifyViolation({ violationId: U('4'), note: 'Please allow it' }),
    ).rejects.toThrow();
    expect(acknowledgeViolation).not.toHaveBeenCalled();
  });

  it('stores a trimmed justification', async () => {
    // VeloExpense: through `acknowledgeViolation`, which stamps who and when.
    const db = makeDb();
    db.$queryRaw.mockResolvedValue(violation());
    await (await caller(db)).justifyViolation({ violationId: U('4'), note: '  Client dinner  ' });
    expect(acknowledgeViolation).toHaveBeenCalledWith(
      expect.anything(),
      U('4'),
      ME,
      'Client dinner',
    );
  });

  it('clears the justification on a blank note', async () => {
    // Mirrors the admin register: a blank note un-acknowledges rather than storing an
    // empty justification that reads as signed off.
    const db = makeDb();
    db.$queryRaw.mockResolvedValue(violation());
    const c = await caller(db);
    for (const note of [undefined, null, '', '   ']) {
      clearAcknowledgement.mockClear();
      await c.justifyViolation({ violationId: U('4'), note } as never);
      expect(clearAcknowledgement, JSON.stringify(note)).toHaveBeenCalledWith(
        expect.anything(),
        U('4'),
      );
    }
    expect(acknowledgeViolation).not.toHaveBeenCalled();
  });

  it('bounds the note', async () => {
    const c = await caller(makeDb());
    await expect(
      c.justifyViolation({ violationId: U('4'), note: 'x'.repeat(2001) }),
    ).rejects.toThrow();
  });
});

describe('recall', () => {
  const caller = (db: unknown) => callerFor(db, [P.expense.report.createOwn]);

  it('404s somebody else’s report', async () => {
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue({
      id: REPORT,
      submitterId: U('3'),
      status: 'SUBMITTED',
    });
    await expect((await caller(db)).recall({ reportId: REPORT })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('only recalls a SUBMITTED report', async () => {
    /**
     * Recalling an approved report would pull back something already acted on
     * downstream — posted to NetSuite, or paid.
     *
     * VeloExpense: RETURNED included, as in ExpenseOS — although VeloExpense's lifecycle
     * would take a RETURNED report back to DRAFT, the ported procedure refuses first.
     */
    for (const status of ['DRAFT', 'APPROVED', 'RETURNED', 'REIMBURSED', 'REJECTED']) {
      const db = makeDb();
      db.expenseReport.findUnique.mockResolvedValue({ id: REPORT, submitterId: ME, status });
      await expect((await caller(db)).recall({ reportId: REPORT }), status).rejects.toThrow();
    }
    expect(recallThroughLifecycle).not.toHaveBeenCalled();
  });

  it('skips the pending tasks, cancels the instance and returns the report', async () => {
    /**
     * All three. Leaving the tasks pending keeps the report in every approver's inbox
     * after the submitter pulled it back, and they would decide on something the
     * submitter is already editing.
     *
     * VeloExpense: the cancel is the lifecycle's (d23, w4-00c) — ExpenseOS's body runs there
     * under the report lock, pinned in `test/lifecycle.db.test.ts`. Here: the procedure hands
     * the report to it as the caller, tells the approvers whose tasks it cancelled, and
     * returns it as DRAFT.
     */
    const db = makeDb();
    db.expenseReport.findUnique.mockResolvedValue({
      id: REPORT,
      submitterId: ME,
      status: 'SUBMITTED',
    });
    const res = await (await caller(db)).recall({ reportId: REPORT });
    expect(recallThroughLifecycle).toHaveBeenCalledWith(db, REPORT, ME);
    expect(notifyReportRecalled).toHaveBeenCalledWith(db, REPORT, ME, ['t-1']);
    // DRAFT, and this assertion is why the mismatch survived: it was written FROM the
    // implementation, so it asserted RETURNED — the very thing that made the "Recall to
    // draft" button lie — and would have gone red the moment anybody fixed it.
    expect(res).toMatchObject({ status: 'DRAFT' });
  });

  // VeloExpense: ExpenseOS's "recalls a report that had no approval instance" covers an
  // auto-approved report's missing instance. VeloExpense refuses a submit with no workflow
  // (d58), and the lifecycle's cancel answers null for a report with no running instance
  // (`test/lifecycle.db.test.ts`).
});
