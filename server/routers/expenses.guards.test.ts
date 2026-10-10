// @vitest-environment node
import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
 * `dimensionOptions` in the permission gates). Each later
 * slice brings the blocks for the procedures it ports — the receipt, submit,
 * justification and recall blocks — and the mocks they need (jobs, policy, storage). The harness below is ExpenseOS's, less those mocks;
 * `@/auth` is VeloExpense's session module.
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

const U = (n: string) => `00000000-0000-7000-8000-00000000000${n}`;
const ME = U('9');
const EXPENSE = U('1');
const REPORT = U('2');

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
    // VeloExpense: `report` reads the violations and the posting row with tagged raw SQL.
    $queryRaw: stubFn(async () => [] as unknown[]),
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
      // VeloExpense: `receiptList` joins this list with the receipts port (w2-09).
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
      // VeloExpense: `receiptRemove` joins this list with the receipt procedures (w2-09).
      // `updateReport`, behind the same permission, stands in until then.
      c.updateReport({ reportId: REPORT, title: 'New' } as never),
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
      // VeloExpense: `receiptList` joins this list with the receipt procedures (w2-09).
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
      // VeloExpense: `receiptList` joins this list with the receipts port (w2-09).
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
