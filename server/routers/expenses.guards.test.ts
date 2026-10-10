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
 * (w2-07: `list`, `categories`, `currencies`, `deleteReport`, `updateReport`). Each later
 * slice brings the blocks for the procedures it ports — the expense, receipt, tax,
 * read-access, validation, justification and recall blocks — and the mocks they need
 * (approvals, jobs, NetSuite, policy, tax). The harness below is ExpenseOS's, less those
 * mocks; `@/auth` is VeloExpense's session module.
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

// VeloExpense: ExpenseOS's `passesGuard` arrives with the ownership blocks that use it (w2-08).

const UPDATE = [P.expense.report.updateOwn] as const;
const READ = [P.expense.report.readOwn] as const;
beforeEach(() => {
  vi.clearAllMocks();
  withAuditCalls.length = 0;
});

describe('permission gates', () => {
  it('refuses read procedures without readOwn', async () => {
    const db = makeDb();
    const c = await callerFor(db, []);
    for (const attempt of [
      c.list({}),
      c.categories(),
      c.currencies(),
      // VeloExpense: `dimensionOptions` (w2-03) and `receiptList` (w2-09) join this list
      // when they are ported.
    ]) {
      await expect(attempt).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('refuses write procedures without updateOwn', async () => {
    const db = makeDb();
    const c = await callerFor(db, READ);
    for (const attempt of [
      // VeloExpense: `updateExpense`, `deleteExpense`, `lineItemRemove` (w2-08) and
      // `receiptRemove` (w2-09) join this list when they are ported; `updateReport` is the
      // write ported so far, behind the same permission.
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
