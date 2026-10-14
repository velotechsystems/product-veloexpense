import { permissions as P } from '@expenseos/rbac';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /expenses/[reportId] — the report page's server-side gate, read as an element rather than
 * mounted (it is a server component).
 *
 * WHO GETS IN is `canViewReport`, the read rule the approvals drawer, `expenses.report` and
 * the comment thread already share. It is run FOR REAL here, against a stubbed database and
 * a stubbed `canDecide`, so a case below is a statement about the rule and not about a mock
 * of it: a direct manager is admitted because the submitter's `managerId` names them, an
 * approver because a task does.
 *
 * WHAT THEY MAY DO is the submitter's alone. Edit, delete and submit are passed as
 * `isSubmitter && <permission>`, so a manager or an admin holding every write permission
 * still gets none of the controls on a report they did not file — the server would refuse
 * each one, because its rule is ownership.
 *
 * A STRANGER AND A MISSING ID LOOK THE SAME — both `notFound()` — so the page cannot be used
 * to learn which report ids exist. A malformed id is refused before any read: Prisma throws
 * on a non-UUID against a uuid column, which would otherwise be a 500.
 *
 * VeloExpense (eos-573): the session and `RbacUser` are the shell context's
 * (`shellContext`), the reads run in the tenant transaction (`withTenantDb`), and no session
 * is VeloExpense's `forbidden()` rather than a not-found — see the page's header. Everything
 * else is ExpenseOS's, case for case.
 */

const REPORT_ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
const SUBMITTER = 'u-submitter';
const MANAGER = 'u-manager';

const h = vi.hoisted(() => ({
  session: null as { user: { id: string; roleId: string; roleLabel: string } } | null,
  permissions: [] as string[],
  /** The report row, or null for an id that names nothing. */
  report: null as { id: string; submitterId: string; approvalInstanceId: string | null } | null,
  /** Users a task on the report is or was assigned to, or who decided one. */
  involved: [] as string[],
  /** Users `canDecide` says yes to without the override. */
  deciders: [] as string[],
  /** Whether `canDecide` says yes to anybody asked WITH the override (`decide.any`). */
  overrideDecides: false,
  /** The pending task's label — the engine writes the workflow node's type there. */
  taskLabel: 'approve' as string | null,
  /** Every database call, by model and method — so "no read at all" is checkable. */
  reads: [] as string[],
}));

// VeloExpense: the session comes from `@/auth` (auth-kit), read only through the shell here.
vi.mock('@/auth', () => ({ auth: async () => null }));
// VeloExpense: the shell context in place of `auth()` + `resolveRbacUser`.
vi.mock('@/server/shell', () => ({
  shellContext: async () =>
    h.session
      ? {
          rbac: { id: h.session.user.id, permissions: h.permissions },
          user: { id: h.session.user.id, organizationId: 'org-1' },
        }
      : null,
}));
vi.mock('@/server/platform/guard', () => ({ requireActiveModule: async () => undefined }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  // VeloExpense: no session is a 403, as on every VeloExpense screen.
  forbidden: () => {
    throw new Error('NEXT_FORBIDDEN');
  },
}));
// VeloExpense: the page reads in the tenant transaction; here that is the stub below.
vi.mock('@/lib/db/prisma', () => ({
  withTenantDb: async (_org: string, fn: (tx: unknown) => unknown) => fn(fakeDb),
}));
const fakeDb = {
  expenseReport: {
    findUnique: async () => {
      h.reads.push('expenseReport.findUnique');
      return h.report;
    },
  },
  user: {
    // `isDirectManagerOf` asks for the SUBMITTER's manager.
    findUnique: async ({ where }: { where: { id: string } }) => {
      h.reads.push('user.findUnique');
      return where.id === SUBMITTER ? { managerId: MANAGER } : null;
    },
  },
  approvalTask: {
    findFirst: async ({ where }: { where: { OR: [{ assigneeUserId: string }] } }) => {
      h.reads.push('approvalTask.findFirst');
      return h.involved.includes(where.OR[0].assigneeUserId) ? { id: 'task-old' } : null;
    },
    findMany: async () => {
      h.reads.push('approvalTask.findMany');
      return [{ id: 'task-1', label: h.taskLabel }];
    },
  },
};
vi.mock('@expenseos/approvals/engine', () => ({
  canDecide: async (_db: unknown, _taskId: string, userId: string, mayOverride: boolean) =>
    h.deciders.includes(userId) || (mayOverride && h.overrideDecides),
}));
/** The client island. Its props are what the page decided; its rendering is its own test's. */
vi.mock('./ExpenseReportWorkbench', () => ({
  ExpenseReportWorkbench: function ExpenseReportWorkbench() {
    return null;
  },
}));

import ExpenseReportPage from './page';

type WorkbenchProps = {
  reportId: string;
  isSubmitter: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  isAcknowledge: boolean;
  canReimburse: boolean;
  canChase: boolean;
  taskId?: string;
};

const signIn = (id: string) => {
  h.session = { user: { id, roleId: 'role-1', roleLabel: 'Employee' } };
};

const open = async (reportId = REPORT_ID) =>
  (
    (await ExpenseReportPage({ params: Promise.resolve({ reportId }) })) as {
      props: WorkbenchProps;
    }
  ).props;

/** Every write permission the workbench mirrors, all held. */
const ALL_WRITES = [
  P.expense.report.readOwn,
  P.expense.report.updateOwn,
  P.expense.report.deleteDraft,
  P.expense.report.submitOwn,
];

beforeEach(() => {
  h.session = null;
  h.permissions = [];
  h.report = { id: REPORT_ID, submitterId: SUBMITTER, approvalInstanceId: 'inst-1' };
  h.involved = [];
  h.deciders = [];
  h.overrideDecides = false;
  h.taskLabel = 'approve';
  h.reads = [];
});

describe('who is turned away', () => {
  it('turns away a caller with no session', async () => {
    // VeloExpense: a 403, as every VeloExpense screen answers no session (see the header).
    await expect(open()).rejects.toThrow('NEXT_FORBIDDEN');
  });

  it('turns away a malformed id without reading anything', async () => {
    signIn(SUBMITTER);
    h.permissions = [P.expense.report.readAll];
    await expect(open('not-a-report-id')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(h.reads).toEqual([]);
  });

  it('turns away an id that names no report — an admin included', async () => {
    signIn('u-admin');
    h.permissions = [P.expense.report.readAll];
    h.report = null;
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('turns away a stranger with the same not-found', async () => {
    // Holding every own-report permission makes nobody a reader of somebody else's report.
    signIn('u-stranger');
    h.permissions = ALL_WRITES;
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('does not let `decide.any` alone make a reader', async () => {
    /**
     * The override answers "may this person decide it", never "may they read it" —
     * `canViewReport` asks the decide question without it. The page resolves the task with
     * the override only once the caller is already in.
     */
    signIn('u-overrider');
    h.permissions = [P.expense.report.decideAny];
    h.overrideDecides = true;
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('who gets in, and with what', () => {
  it('admits the submitter, with each control by its own permission', async () => {
    signIn(SUBMITTER);
    h.permissions = [P.expense.report.readOwn, P.expense.report.updateOwn];
    expect(await open()).toMatchObject({
      reportId: REPORT_ID,
      isSubmitter: true,
      canEdit: true,
      canDelete: false,
      canSubmit: false,
      canApprove: false,
    });

    h.permissions = ALL_WRITES;
    expect(await open()).toMatchObject({ canEdit: true, canDelete: true, canSubmit: true });
  });

  it('admits a direct manager, read-only even holding every write permission', async () => {
    // Status is not looked at: this is also the manager opening a subordinate's draft.
    signIn(MANAGER);
    h.permissions = [...ALL_WRITES, P.expense.report.approve];
    expect(await open()).toMatchObject({
      isSubmitter: false,
      canEdit: false,
      canDelete: false,
      canSubmit: false,
      canApprove: false,
    });
  });

  it('admits an AP clerk with no task, with nothing to decide', async () => {
    signIn('u-ap');
    h.permissions = [P.expense.report.reimburse, ...ALL_WRITES];
    const props = await open();
    expect(props).toMatchObject({
      isSubmitter: false,
      canEdit: false,
      canDelete: false,
      canSubmit: false,
      canApprove: false,
    });
    // `undefined` rather than null: the client prop is optional.
    expect(props.taskId).toBeUndefined();
  });

  it('admits a read-all viewer, with nothing to decide', async () => {
    signIn('u-admin');
    h.permissions = [P.expense.report.readAll, ...ALL_WRITES];
    expect(await open()).toMatchObject({
      isSubmitter: false,
      canEdit: false,
      canDelete: false,
      canSubmit: false,
      canApprove: false,
    });
  });

  it('admits an eligible approver and hands them the task', async () => {
    signIn('u-approver');
    h.deciders = ['u-approver'];
    expect(await open()).toMatchObject({
      isSubmitter: false,
      canEdit: false,
      canApprove: true,
      taskId: 'task-1',
    });
  });

  it('admits somebody who was assigned a task before, without deciding anything now', async () => {
    signIn('u-past');
    h.involved = ['u-past'];
    expect(await open()).toMatchObject({ canApprove: false });
  });

  it('switches on approver mode through `decide.any` once a reader is in', async () => {
    // The override still resolves the task — only after the gate, never instead of it.
    signIn('u-admin');
    h.permissions = [P.expense.report.readAll, P.expense.report.decideAny];
    h.overrideDecides = true;
    expect(await open()).toMatchObject({ canApprove: true, taskId: 'task-1' });
  });

  it('does not hand `read.all` a task — reading the queue is not deciding it', async () => {
    signIn('u-admin');
    h.permissions = [P.expense.report.readAll];
    h.overrideDecides = true;
    expect(await open()).toMatchObject({ canApprove: false });
  });
});

/**
 * The three actions the drawer had and the workbench gained — Acknowledge, Mark reimbursed,
 * Request receipts. The page decides who is OFFERED each; every one is re-checked by its
 * procedure, so these are statements about which buttons appear, not about who may act.
 */
describe('acknowledging, paying and chasing', () => {
  it('passes an acknowledge task down as one', async () => {
    signIn('u-approver');
    h.deciders = ['u-approver'];
    h.taskLabel = 'acknowledge';
    expect(await open()).toMatchObject({
      canApprove: true,
      taskId: 'task-1',
      isAcknowledge: true,
    });
  });

  it('does not call an approval task, or no task, an acknowledgement', async () => {
    signIn('u-approver');
    h.deciders = ['u-approver'];
    expect(await open()).toMatchObject({ canApprove: true, isAcknowledge: false });

    signIn('u-admin');
    h.permissions = [P.expense.report.readAll];
    h.taskLabel = 'acknowledge';
    expect(await open()).toMatchObject({ canApprove: false, isAcknowledge: false });
  });

  it('offers an AP clerk with no task both paying and chasing', async () => {
    signIn('u-ap');
    h.permissions = [P.expense.report.reimburse];
    expect(await open()).toMatchObject({
      canApprove: false,
      canReimburse: true,
      canChase: true,
    });
  });

  it('lets a read-all viewer chase, but not pay', async () => {
    signIn('u-admin');
    h.permissions = [P.expense.report.readAll];
    expect(await open()).toMatchObject({ canReimburse: false, canChase: true });
  });

  it('lets an eligible approver chase', async () => {
    signIn('u-approver');
    h.deciders = ['u-approver'];
    expect(await open()).toMatchObject({ canChase: true });
  });

  it('does not let a direct manager with no task chase', async () => {
    signIn(MANAGER);
    expect(await open()).toMatchObject({ canChase: false });
  });

  it('does not let a task held only through `decide.any` chase', async () => {
    /**
     * `chaseReceipts` asks the decide question WITHOUT the override, so a report this
     * caller decides only by stepping around its approver is one the procedure skips. The
     * button would report "nothing to ask for" while receipts are plainly missing.
     */
    signIn(MANAGER);
    h.permissions = [P.expense.report.decideAny];
    h.overrideDecides = true;
    expect(await open()).toMatchObject({ canApprove: true, canChase: false });
  });

  it('never offers the submitter a chase of their own report', async () => {
    // Even holding read-all: the server would send it, but it is a note to yourself.
    signIn(SUBMITTER);
    h.permissions = [P.expense.report.readAll, P.expense.report.reimburse];
    expect(await open()).toMatchObject({ isSubmitter: true, canChase: false });
  });
});
