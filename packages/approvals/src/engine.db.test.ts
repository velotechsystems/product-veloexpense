// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- ported suite: the harness reads rows untyped. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../../../server/__test-helpers__/tenantHarness';

/*
 * VeloExpense (w4-00b): ExpenseOS's suite (550b2945), run against one tenant.
 *   · The database is VeloExpense's harness tenant (`createTenantHarness`), not ExpenseOS's
 *     shared test database, and every engine call runs inside that tenant's transaction —
 *     as every caller will (w4-00c). The `engine` below is ExpenseOS's module with the
 *     suite's `db` swapped for that transaction; each test reads as ExpenseOS wrote it.
 *   · Roles are the tenant's rows (0068, w4-10a), found as ExpenseOS finds them.
 *   · Job levels are seeded here: the harness tenant has none, and ExpenseOS's cases read
 *     its seeded levels (a guard that returns early would make them pass vacuously).
 *   · The virtual-card and travel adapters are out of scope or not built yet (d50); their
 *     cases are skipped, marked.
 */
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

/**
 * The engine's DATABASE layer: which workflow governs a subject, who may act on a task,
 * and what the decision writes back to the subject itself.
 *
 * The pure interpreter is tested in engine-core.test.ts and the no-manager fallback has
 * its own file. What only a real database can exercise is the part in between — and it is
 * where the consequential mistakes live:
 *
 *   · **Workflow selection** is priority-ordered with an isDefault catch-all LAST, and
 *     only PUBLISHED current versions are eligible. A draft version that could govern a
 *     live report would route production through something somebody was still editing.
 *   · **Who may decide** is three different rules — an admin, the resolved assignee, or
 *     any matching active user on an unassigned filter task — and widening any of them
 *     is a privilege escalation rather than a convenience.
 *   · **The outcome write is per subject type**, and each one means something different:
 *     a limit increase APPLIES the new ceiling to the card, a travel request SNAPSHOTS
 *     its total, an expense report stamps approvedAt only on a positive outcome.
 *
 * Fixtures are created and removed per run — the test database is shared and never reset.
 */

/**
 * The shape most of these tests need: start → one manager approval → approved.
 *
 * An edge with no `sourceHandle` IS the approve exit — the interpreter routes the
 * unhandled edges as the positive path, so a `reject` handle is opt-in.
 */
const MANAGER_APPROVAL_GRAPH = {
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'approve-1', type: 'approval', approver: { kind: 'manager' } },
    { id: 'done', type: 'approved' },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'approve-1' },
    { id: 'e2', source: 'approve-1', target: 'done' },
  ],
};

describe.skipIf(!process.env.DATABASE_URL)('approval engine (integration)', () => {
  let db: any;
  let h: TenantHarness;
  let engine: typeof import('./engine');
  let currencyId: string;
  let approverRoleId: string;
  let noPermRoleId: string;

  const userIds: string[] = [];
  const workflowIds: string[] = [];
  /** Seeded workflows this suite parked, to be restored afterwards. */
  const parkedWorkflowIds: string[] = [];
  const instanceIds: string[] = [];
  const reportIds: string[] = [];

  const TAG = `eng-${process.pid}`;

  const makeUser = async (
    over: { managerId?: string | null; roleId?: string; jobLevelId?: string | null } & Record<
      string,
      unknown
    > = {},
  ): Promise<string> => {
    // VeloExpense: one display name.
    const u = await db.user.create({
      data: {
        email: `${TAG}-${userIds.length}@example.test`,
        name: 'QA Engine',
        roleId: over.roleId ?? approverRoleId,
        employeeStatus: 'ACTIVE',
        ...over,
      },
      select: { id: true },
    });
    userIds.push(u.id);
    return u.id;
  };

  /**
   * A workflow with one published version. `graph` defaults to a single approval node
   * routed at the requester's manager, which is the shape most of these tests need.
   */
  const makeWorkflow = async (opts: {
    key: string;
    matchCondition?: unknown;
    graph?: unknown;
    isDefault?: boolean;
    priority?: number;
    status?: 'DRAFT' | 'PUBLISHED';
    active?: boolean;
    callable?: boolean;
    subjectType?: string;
  }): Promise<{ id: string; versionId: string }> => {
    const workflow = await db.approvalWorkflow.create({
      data: {
        key: `${TAG}-${opts.key}`,
        name: `${TAG} ${opts.key}`,
        subjectType: opts.subjectType ?? 'EXPENSE_REPORT',
        isDefault: opts.isDefault ?? false,
        priority: opts.priority ?? 0,
        active: opts.active ?? true,
        callable: opts.callable ?? false,
      },
      select: { id: true },
    });
    workflowIds.push(workflow.id);
    const version = await db.approvalWorkflowVersion.create({
      data: {
        workflowId: workflow.id,
        version: 1,
        matchCondition: opts.matchCondition ?? { all: [] },
        graph: opts.graph ?? MANAGER_APPROVAL_GRAPH,
        status: opts.status ?? 'PUBLISHED',
      },
      select: { id: true },
    });
    await db.approvalWorkflow.update({
      where: { id: workflow.id },
      data: { currentVersionId: version.id },
    });
    return { id: workflow.id, versionId: version.id };
  };

  /** Every workflow this suite made, gone — so selection tests see only their own. */
  const clearWorkflows = async () => {
    await db.approvalInstance.deleteMany({ where: { id: { in: instanceIds } } }).catch(() => {});
    instanceIds.length = 0;
    await db.approvalWorkflow.deleteMany({ where: { id: { in: workflowIds } } }).catch(() => {});
    workflowIds.length = 0;
  };

  const makeReport = async (submitterId: string, totalMinor = 100_000n): Promise<string> => {
    const r = await db.expenseReport.create({
      data: {
        title: `${TAG} report`,
        submitterId,
        currencyId,
        status: 'SUBMITTED',
        totalMinor,
      },
      select: { id: true },
    });
    reportIds.push(r.id);
    return r.id;
  };

  beforeAll(async () => {
    // VeloExpense: the harness tenant, and the engine run inside its transaction.
    h = await createTenantHarness({ slug: 'approval-engine', name: 'Approval Engine' });
    db = h.db;
    const raw = await import('./engine');
    engine = new Proxy(raw, {
      get(target, key) {
        const value = (target as Record<string | symbol, unknown>)[key];
        if (typeof value !== 'function') return value;
        return (first: unknown, ...rest: unknown[]) =>
          first === db
            ? db.$transaction((tx: unknown) => (value as (...a: unknown[]) => unknown)(tx, ...rest))
            : (value as (...a: unknown[]) => unknown)(first, ...rest);
      },
    }) as typeof raw;
    // VeloExpense: a currency's id is its code.
    currencyId = 'CAD';
    approverRoleId = (
      await db.role.findFirstOrThrow({
        where: { permissions: { has: 'expense.report.approve' }, active: true },
        select: { id: true },
      })
    ).id;
    noPermRoleId = (
      await db.role.findFirstOrThrow({
        where: { NOT: { permissions: { has: 'expense.report.approve' } }, active: true },
        select: { id: true },
      })
    ).id;
    // VeloExpense: two job levels, as ExpenseOS's seed provides.
    for (const [code, track, sortOrder] of [
      ['IC1', 'INDIVIDUAL_CONTRIBUTOR', 10],
      ['E1', 'EXECUTIVE', 90],
    ] as const) {
      await h.admin.query(
        `INSERT INTO job_level (organization_id, code, track, label, sort_order) VALUES ($1, $2, $3, $4, $5)`,
        [h.orgId, code, track, JSON.stringify({ en: code }), sortOrder],
      );
    }

    /**
     * Park every workflow the seed installed, for the duration of this file.
     *
     * Selection is global by subject type, so the seeded amount-tiered expense
     * workflow would win every one of these tests — including the ones asserting that
     * nothing matches. The db project runs files serially, so nothing else is looking
     * at these rows meanwhile, and afterAll puts back exactly what it took.
     */
    const seeded = await db.approvalWorkflow.findMany({
      where: { active: true },
      select: { id: true },
    });
    parkedWorkflowIds.push(...seeded.map((w: { id: string }) => w.id));
    await db.approvalWorkflow.updateMany({
      where: { id: { in: parkedWorkflowIds } },
      data: { active: false },
    });
  });

  afterAll(async () => {
    await db.approvalWorkflow
      .updateMany({ where: { id: { in: parkedWorkflowIds } }, data: { active: true } })
      .catch(() => {});
    await db.approvalTask
      .deleteMany({ where: { instanceId: { in: instanceIds } } })
      .catch(() => {});
    await db.approvalInstance.deleteMany({ where: { id: { in: instanceIds } } }).catch(() => {});
    await db.expenseReport.deleteMany({ where: { id: { in: reportIds } } }).catch(() => {});
    await db.approvalWorkflow.deleteMany({ where: { id: { in: workflowIds } } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await h?.end();
  });

  // ── selectWorkflowVersion ───────────────────────────────────────────────────

  describe('choosing which workflow governs a subject', () => {
    const facts = { amount: 100_000, userId: null };

    it('returns nothing when no workflow is published for the subject', async () => {
      /**
       * NO_WORKFLOW is a real outcome, not a failure: a report with nothing to route
       * through auto-approves, which is the documented behaviour.
       */
      await clearWorkflows();
      // VeloExpense: ExpenseOS asks about VIRTUAL_CARD_LIMIT_INCREASE, not a subject here.
      const selected = await engine.selectWorkflowVersion(db, 'TRAVEL_REQUEST', facts as never);
      expect(selected).toBeNull();
    });

    it('picks a workflow whose condition matches the facts', async () => {
      await clearWorkflows();
      const wf = await makeWorkflow({
        key: 'match-high',
        matchCondition: { all: [{ field: 'amount', op: 'gte', value: 50_000 }] },
      });
      const selected = await engine.selectWorkflowVersion(db, 'EXPENSE_REPORT', facts as never);
      expect(selected?.versionId).toBe(wf.versionId);
    });

    it('does not pick one whose condition does not match', async () => {
      await clearWorkflows();
      await makeWorkflow({
        key: 'match-higher',
        matchCondition: { all: [{ field: 'amount', op: 'gte', value: 500_000 }] },
      });
      expect(await engine.selectWorkflowVersion(db, 'EXPENSE_REPORT', facts as never)).toBeNull();
    });

    it('prefers the higher priority among several that match', async () => {
      /**
       * Two workflows can legitimately claim the same subject — "over $50k" and "US
       * entity". Priority is how an admin says which wins, and an unstable order here
       * would route the same report differently on different days.
       */
      await clearWorkflows();
      await makeWorkflow({ key: 'low', priority: 1 });
      const high = await makeWorkflow({ key: 'high', priority: 10 });
      const selected = await engine.selectWorkflowVersion(db, 'EXPENSE_REPORT', facts as never);
      expect(selected?.versionId).toBe(high.versionId);
    });

    it('falls back to the catch-all when nothing matches', async () => {
      await clearWorkflows();
      await makeWorkflow({
        key: 'specific',
        matchCondition: { all: [{ field: 'amount', op: 'gte', value: 500_000 }] },
      });
      const fallback = await makeWorkflow({ key: 'catch-all', isDefault: true });
      const selected = await engine.selectWorkflowVersion(db, 'EXPENSE_REPORT', facts as never);
      expect(selected?.versionId).toBe(fallback.versionId);
    });

    it('prefers a matching workflow over the catch-all', async () => {
      // The catch-all is a floor, not a competitor.
      await clearWorkflows();
      await makeWorkflow({ key: 'catch-all-2', isDefault: true });
      const specific = await makeWorkflow({
        key: 'specific-2',
        matchCondition: { all: [{ field: 'amount', op: 'gte', value: 50_000 }] },
      });
      const selected = await engine.selectWorkflowVersion(db, 'EXPENSE_REPORT', facts as never);
      expect(selected?.versionId).toBe(specific.versionId);
    });

    it('ignores a version that is still a draft', async () => {
      /**
       * The one that matters most here: routing a live report through a version
       * somebody is mid-way through editing is a decision nobody made.
       */
      await clearWorkflows();
      await makeWorkflow({ key: 'draft', status: 'DRAFT' });
      expect(await engine.selectWorkflowVersion(db, 'EXPENSE_REPORT', facts as never)).toBeNull();
    });

    it('ignores a deactivated workflow', async () => {
      await clearWorkflows();
      await makeWorkflow({ key: 'inactive', active: false });
      expect(await engine.selectWorkflowVersion(db, 'EXPENSE_REPORT', facts as never)).toBeNull();
    });

    it('ignores a callable sub-flow', async () => {
      /**
       * A sub-flow is reachable only through a CallWorkflow node. Selecting one as a
       * top-level workflow would run a fragment with no terminal state.
       */
      await clearWorkflows();
      await makeWorkflow({ key: 'callable', callable: true });
      expect(await engine.selectWorkflowVersion(db, 'EXPENSE_REPORT', facts as never)).toBeNull();
    });

    it('ignores a workflow for another subject type', async () => {
      await clearWorkflows();
      await makeWorkflow({ key: 'travel-only', subjectType: 'TRAVEL_REQUEST' });
      expect(await engine.selectWorkflowVersion(db, 'EXPENSE_REPORT', facts as never)).toBeNull();
    });
  });

  // ── who may act on a task ───────────────────────────────────────────────────

  describe('who may decide a task', () => {
    /** A running instance parked on one manager-approver task. */
    const parkOnTask = async (
      submitterId: string,
    ): Promise<{ taskId: string; instanceId: string; reportId: string }> => {
      const reportId = await makeReport(submitterId);
      const result = await engine.startInstance(db, 'EXPENSE_REPORT', reportId);
      if (result.instanceId) instanceIds.push(result.instanceId);
      const task = await db.approvalTask.findFirstOrThrow({
        where: { instanceId: result.instanceId },
        select: { id: true },
      });
      return { taskId: task.id, instanceId: result.instanceId as string, reportId };
    };

    it('lets the resolved assignee decide', async () => {
      await clearWorkflows();
      await makeWorkflow({ key: 'assignee', isDefault: true });
      const manager = await makeUser();
      const submitter = await makeUser({ managerId: manager });
      const { taskId } = await parkOnTask(submitter);
      expect(await engine.canDecide(db, taskId, manager, false)).toBe(true);
    });

    it('lets an admin decide anything', async () => {
      /**
       * The break-glass path: an approver on leave should not strand a claim. It is a
       * permission, and every use of it is audited.
       */
      await clearWorkflows();
      await makeWorkflow({ key: 'admin', isDefault: true });
      const manager = await makeUser();
      const submitter = await makeUser({ managerId: manager });
      const { taskId } = await parkOnTask(submitter);
      const stranger = await makeUser();
      expect(await engine.canDecide(db, taskId, stranger, true)).toBe(true);
    });

    it('does not let a bystander decide somebody else’s task', async () => {
      await clearWorkflows();
      await makeWorkflow({ key: 'bystander', isDefault: true });
      const manager = await makeUser();
      const submitter = await makeUser({ managerId: manager });
      const { taskId } = await parkOnTask(submitter);
      const stranger = await makeUser();
      expect(await engine.canDecide(db, taskId, stranger, false)).toBe(false);
    });

    it('does not let the submitter approve their own claim', async () => {
      // The one rule no fallback may ever relax.
      await clearWorkflows();
      await makeWorkflow({ key: 'self', isDefault: true });
      const manager = await makeUser();
      const submitter = await makeUser({ managerId: manager });
      const { taskId } = await parkOnTask(submitter);
      expect(await engine.canDecide(db, taskId, submitter, false)).toBe(false);
    });

    it('does not let an ADMIN submitter approve their own claim', async () => {
      /**
       * The case the suite was missing, and the one that shipped. The self-approval rule
       * above was tested only with `isAdmin: false`, while `canDecide` opened with
       * `if (isAdmin) return true` — so the rule was never reachable for the people
       * best able to break it.
       *
       * Observed on DEV: a System Administrator submitted a report, was offered Approve
       * on the detail page, and it succeeded and was recorded as a real approval — while
       * the workflow assigned the decision to their direct manager and their own
       * approvals inbox showed nothing (GA readiness report F15 / F20, blocker B3).
       */
      await clearWorkflows();
      await makeWorkflow({ key: 'self-admin', isDefault: true });
      const manager = await makeUser();
      const submitter = await makeUser({ managerId: manager });
      const { taskId } = await parkOnTask(submitter);
      expect(await engine.canDecide(db, taskId, submitter, true)).toBe(false);
      // …and the override still works on somebody else's claim.
      const otherAdmin = await makeUser();
      expect(await engine.canDecide(db, taskId, otherAdmin, true)).toBe(true);
    });

    it('refuses a task that no longer exists', async () => {
      expect(
        await engine.canDecide(db, '00000000-0000-7000-8000-0000000000e1', approverRoleId, false),
      ).toBe(false);
    });
  });

  describe('simulateWorkflow — an amount-tiered graph', () => {
    /**
     * The simulator was reported as proving the shipped "Amount-tiered" workflow has no
     * tiers: run at 500,000 it returned one step, "1. Approval", and APPROVED (GA
     * readiness report F42).
     *
     * The graph is tiered. It routes by amount to ONE approver of the appropriate
     * seniority, so a single step is the DESIGNED output and the tier is the entire
     * difference between a small claim and a large one. What the simulator did not say
     * was WHICH approver it had resolved, so both answers looked identical.
     *
     * This is the coverage the function never had: it is stubbed in the router tests and
     * was not exercised anywhere.
     */
    const tieredGraph = (seniorLevelId: string) => ({
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 } },
        {
          id: 'route',
          type: 'switch',
          cases: [
            {
              id: 'small',
              label: '< $5,000',
              predicate: { field: 'amount', op: 'lt', value: 500_000 },
            },
          ],
          position: { x: 0, y: 1 },
        },
        { id: 'mgr', type: 'approval', approver: { kind: 'manager' }, position: { x: 0, y: 2 } },
        {
          id: 'senior',
          type: 'approval',
          approver: { kind: 'managerChain', minJobLevelId: seniorLevelId },
          position: { x: 1, y: 2 },
        },
        { id: 'approved', type: 'approved', position: { x: 0, y: 3 } },
      ],
      edges: [
        { id: 'e0', source: 'start', target: 'route' },
        { id: 'e1', source: 'route', sourceHandle: 'small', target: 'mgr' },
        { id: 'e2', source: 'route', sourceHandle: 'default', target: 'senior' },
        { id: 'e3', source: 'mgr', target: 'approved' },
        { id: 'e4', source: 'senior', target: 'approved' },
      ],
    });

    it('routes a small amount to the direct manager, and says so', async () => {
      await clearWorkflows();
      const senior = await db.jobLevel.findFirstOrThrow({ orderBy: { sortOrder: 'desc' } });
      await makeWorkflow({ key: 'sim-low', isDefault: true, graph: tieredGraph(senior.id) });

      const out = await engine.simulateWorkflow(db, 'EXPENSE_REPORT', { amount: 100_000 });

      expect(out.status).toBe('APPROVED');
      expect(out.steps).toHaveLength(1);
      expect(out.steps[0]?.approver).toEqual({ kind: 'manager', minJobLevelCode: null });
    });

    it('routes a large amount to a senior tier, naming the job level', async () => {
      await clearWorkflows();
      const senior = await db.jobLevel.findFirstOrThrow({ orderBy: { sortOrder: 'desc' } });
      await makeWorkflow({ key: 'sim-high', isDefault: true, graph: tieredGraph(senior.id) });

      // The auditor's input: 500,000 major units → 50,000,000 minor.
      const out = await engine.simulateWorkflow(db, 'EXPENSE_REPORT', { amount: 50_000_000 });

      expect(out.status).toBe('APPROVED');
      // Still ONE step — that is the design, not a missing ladder…
      expect(out.steps).toHaveLength(1);
      // …and this is what tells the two answers apart.
      expect(out.steps[0]?.approver).toEqual({
        kind: 'managerChain',
        minJobLevelCode: senior.code,
      });
    });

    it('reports no workflow rather than inventing steps', async () => {
      await clearWorkflows();
      const out = await engine.simulateWorkflow(db, 'EXPENSE_REPORT', { amount: 1 });
      expect(out.workflowName).toBeNull();
      expect(out.steps).toEqual([]);
    });
  });

  describe('claiming an unassigned relative-approver task', () => {
    /**
     * A subject id that resolves to no report, so `loadRequesterId` returns null and the
     * requester-relative narrowing (no claiming by the requester's own subordinates) has
     * nothing to compare against. These cases are about the POOL rule — permission, role
     * status, employment status — and pass the orphan id so exactly one rule is in play.
     * The narrowing gets its own tests, against a real report, in noManagerFallback.db.
     */
    const NO_SUBJECT = '00000000-0000-7000-8000-0000000000e0';
    it('admits somebody who holds the subject’s approve permission AND manages somebody', async () => {
      /**
       * The no-manager fallback. The node is `manager`, nobody resolved, so anyone who may
       * approve this KIND of subject — and is themselves a manager — can pick it up, and a
       * human still decides.
       *
       * The direct report is not incidental. Since Manager was folded into Employee, the
       * approve permission is held by everybody, so it can no longer be the bound on this
       * pool; having a report is. See `noManagerFallback.db.test.ts` for the pair of
       * assertions that isolate it.
       */
      const node = { id: 'a', type: 'approval', approver: { kind: 'manager' } };
      const actor = await makeUser({ roleId: approverRoleId });
      await makeUser({ roleId: noPermRoleId, managerId: actor });
      expect(
        await engine.canClaimUnresolvedApproval(
          db,
          node as never,
          'EXPENSE_REPORT',
          NO_SUBJECT,
          actor,
        ),
      ).toBe(true);
    });

    it('refuses somebody whose role does not grant it', async () => {
      const node = { id: 'a', type: 'approval', approver: { kind: 'manager' } };
      const actor = await makeUser({ roleId: noPermRoleId });
      expect(
        await engine.canClaimUnresolvedApproval(
          db,
          node as never,
          'EXPENSE_REPORT',
          NO_SUBJECT,
          actor,
        ),
      ).toBe(false);
    });

    it('refuses a deactivated employee', async () => {
      /**
       * A departed manager keeps their role row; the employee status is what says they
       * are gone, and an approval by a leaver is not one anybody can stand behind.
       */
      const node = { id: 'a', type: 'approval', approver: { kind: 'manager' } };
      const actor = await makeUser({ employeeStatus: 'DEACTIVATED' });
      expect(
        await engine.canClaimUnresolvedApproval(
          db,
          node as never,
          'EXPENSE_REPORT',
          NO_SUBJECT,
          actor,
        ),
      ).toBe(false);
    });

    it('refuses a soft-deleted user', async () => {
      const node = { id: 'a', type: 'approval', approver: { kind: 'manager' } };
      const actor = await makeUser({ deletedAt: new Date() });
      expect(
        await engine.canClaimUnresolvedApproval(
          db,
          node as never,
          'EXPENSE_REPORT',
          NO_SUBJECT,
          actor,
        ),
      ).toBe(false);
    });

    it('refuses somebody who does not exist', async () => {
      const node = { id: 'a', type: 'approval', approver: { kind: 'manager' } };
      expect(
        await engine.canClaimUnresolvedApproval(
          db,
          node as never,
          'EXPENSE_REPORT',
          NO_SUBJECT,
          '00000000-0000-7000-8000-0000000000e2',
        ),
      ).toBe(false);
    });

    it('never applies to a filter-approver node', async () => {
      /**
       * A filter task already has its own eligibility rule. Widening the fallback to it
       * would let anybody with the permission decide a task aimed at a specific pool.
       */
      const node = {
        id: 'a',
        type: 'approval',
        approver: { kind: 'filter', match: { all: [] } },
      };
      const actor = await makeUser({ roleId: approverRoleId });
      expect(
        await engine.canClaimUnresolvedApproval(
          db,
          node as never,
          'EXPENSE_REPORT',
          NO_SUBJECT,
          actor,
        ),
      ).toBe(false);
    });

    it('never applies to a node that is not an approval at all', async () => {
      const actor = await makeUser({ roleId: approverRoleId });
      expect(
        await engine.canClaimUnresolvedApproval(
          db,
          { id: 'n', type: 'notify' } as never,
          'EXPENSE_REPORT',
          NO_SUBJECT,
          actor,
        ),
      ).toBe(false);
    });

    it('refuses when the node is missing entirely', async () => {
      // A graph edited after an instance started; the node id no longer resolves.
      const actor = await makeUser({ roleId: approverRoleId });
      expect(
        await engine.canClaimUnresolvedApproval(db, undefined, 'EXPENSE_REPORT', NO_SUBJECT, actor),
      ).toBe(false);
    });
  });

  describe('eligibility for a filter-approver task', () => {
    it('admits an active user the filter matches', async () => {
      const actor = await makeUser({ roleId: approverRoleId });
      const node = {
        id: 'a',
        type: 'approval',
        approver: { kind: 'filter', match: { all: [{ field: 'userId', op: 'eq', value: actor }] } },
      };
      expect(await engine.isEligible(db, node as never, actor)).toBe(true);
    });

    it('refuses a user the filter does not match', async () => {
      const actor = await makeUser({ roleId: approverRoleId });
      const other = await makeUser({ roleId: approverRoleId });
      const node = {
        id: 'a',
        type: 'approval',
        approver: { kind: 'filter', match: { all: [{ field: 'userId', op: 'eq', value: other }] } },
      };
      expect(await engine.isEligible(db, node as never, actor)).toBe(false);
    });

    it('refuses a relative-approver node, which is assignee-gated instead', async () => {
      const actor = await makeUser({ roleId: approverRoleId });
      const node = { id: 'a', type: 'approval', approver: { kind: 'manager' } };
      expect(await engine.isEligible(db, node as never, actor)).toBe(false);
    });

    it('refuses a node that is not an approval', async () => {
      const actor = await makeUser({ roleId: approverRoleId });
      expect(await engine.isEligible(db, { id: 'n', type: 'notify' } as never, actor)).toBe(false);
    });

    it('refuses a soft-deleted user however well they match', async () => {
      const actor = await makeUser({ deletedAt: new Date() });
      const node = {
        id: 'a',
        type: 'approval',
        approver: { kind: 'filter', match: { all: [{ field: 'userId', op: 'eq', value: actor }] } },
      };
      expect(await engine.isEligible(db, node as never, actor)).toBe(false);
    });

    it('refuses somebody below the node’s minimum job level', async () => {
      /**
       * A tier exists to keep a $200k approval away from a junior who happens to match
       * the department filter.
       */
      const levels = await db.jobLevel.findMany({ orderBy: { sortOrder: 'asc' }, take: 2 });
      if (levels.length < 2) return;
      const actor = await makeUser({ roleId: approverRoleId, jobLevelId: levels[0].id });
      const node = {
        id: 'a',
        type: 'approval',
        approver: {
          kind: 'filter',
          match: { all: [{ field: 'userId', op: 'eq', value: actor }] },
          minJobLevelId: levels[1].id,
        },
      };
      expect(await engine.isEligible(db, node as never, actor)).toBe(false);
    });

    it('admits somebody at or above it', async () => {
      const levels = await db.jobLevel.findMany({ orderBy: { sortOrder: 'asc' }, take: 2 });
      if (levels.length < 2) return;
      const actor = await makeUser({ roleId: approverRoleId, jobLevelId: levels[1].id });
      const node = {
        id: 'a',
        type: 'approval',
        approver: {
          kind: 'filter',
          match: { all: [{ field: 'userId', op: 'eq', value: actor }] },
          minJobLevelId: levels[0].id,
        },
      };
      expect(await engine.isEligible(db, node as never, actor)).toBe(true);
    });

    it('refuses somebody with no job level when the node demands one', async () => {
      /**
       * Job level is optional on User, so "unclassified" is common — and it cannot be
       * read as "senior enough".
       */
      const levels = await db.jobLevel.findMany({ orderBy: { sortOrder: 'desc' }, take: 1 });
      if (levels.length < 1) return;
      const actor = await makeUser({ roleId: approverRoleId, jobLevelId: null });
      const node = {
        id: 'a',
        type: 'approval',
        approver: {
          kind: 'filter',
          match: { all: [{ field: 'userId', op: 'eq', value: actor }] },
          minJobLevelId: levels[0].id,
        },
      };
      expect(await engine.isEligible(db, node as never, actor)).toBe(false);
    });
  });

  // ── deciding, and what it writes back ───────────────────────────────────────

  describe('deciding a task', () => {
    const parkOnTask = async (): Promise<{
      taskId: string;
      instanceId: string;
      reportId: string;
      manager: string;
    }> => {
      const manager = await makeUser();
      const submitter = await makeUser({ managerId: manager });
      const reportId = await makeReport(submitter);
      const result = await engine.startInstance(db, 'EXPENSE_REPORT', reportId);
      if (result.instanceId) instanceIds.push(result.instanceId);
      const task = await db.approvalTask.findFirstOrThrow({
        where: { instanceId: result.instanceId },
        select: { id: true },
      });
      return { taskId: task.id, instanceId: result.instanceId as string, reportId, manager };
    };

    it('approves the subject, stamping when', async () => {
      await clearWorkflows();
      await makeWorkflow({ key: 'decide-approve', isDefault: true });
      const { taskId, reportId, manager } = await parkOnTask();
      await engine.decideTask(db, taskId, true, manager, null);
      const report = await db.expenseReport.findUniqueOrThrow({
        where: { id: reportId },
        select: { status: true, approvedAt: true },
      });
      expect(report.status).toBe('APPROVED');
      expect(report.approvedAt).not.toBeNull();
    });

    it('leaves approvedAt null on a rejection', async () => {
      /**
       * A rejected report that carried an approvedAt would read as approved to anything
       * that checks the stamp rather than the status.
       */
      await clearWorkflows();
      await makeWorkflow({ key: 'decide-reject', isDefault: true });
      const { taskId, reportId, manager } = await parkOnTask();
      await engine.decideTask(db, taskId, false, manager, 'not this quarter');
      const report = await db.expenseReport.findUniqueOrThrow({
        where: { id: reportId },
        select: { status: true, approvedAt: true },
      });
      expect(report.status).toBe('REJECTED');
      expect(report.approvedAt).toBeNull();
    });

    it('records the decider and their note on the task', async () => {
      await clearWorkflows();
      await makeWorkflow({ key: 'decide-note', isDefault: true });
      const { taskId, manager } = await parkOnTask();
      await engine.decideTask(db, taskId, false, manager, 'missing receipt');
      const task = await db.approvalTask.findUniqueOrThrow({
        where: { id: taskId },
        select: { status: true, decidedById: true, note: true, decidedAt: true },
      });
      expect(task).toMatchObject({
        status: 'REJECTED',
        decidedById: manager,
        note: 'missing receipt',
      });
      expect(task.decidedAt).not.toBeNull();
    });

    it('refuses to decide the same task twice', async () => {
      /**
       * The atomic claim, which is the real guard: a double-click, or an assignee and an
       * admin racing, would otherwise both advance the instance and duplicate every
       * downstream task.
       */
      await clearWorkflows();
      await makeWorkflow({ key: 'decide-twice', isDefault: true });
      const { taskId, manager } = await parkOnTask();
      await engine.decideTask(db, taskId, true, manager, null);
      await expect(engine.decideTask(db, taskId, true, manager, null)).rejects.toThrow(
        /already decided/,
      );
    });

    it('refuses a task that does not exist', async () => {
      await expect(
        engine.decideTask(db, '00000000-0000-7000-8000-0000000000e3', true, approverRoleId, null),
      ).rejects.toThrow(/not found/);
    });

    it('refuses once the instance is no longer running', async () => {
      /**
       * A sibling branch already failed the instance. Deciding a task on a finished
       * instance would move a token in a graph nothing is walking.
       */
      await clearWorkflows();
      await makeWorkflow({ key: 'decide-stopped', isDefault: true });
      const { taskId, instanceId, manager } = await parkOnTask();
      await db.approvalInstance.update({
        where: { id: instanceId },
        data: { status: 'REJECTED' },
      });
      await expect(engine.decideTask(db, taskId, true, manager, null)).rejects.toThrow(
        /not running/,
      );
    });

    it('refuses to REJECT an acknowledgement', async () => {
      /**
       * An acknowledge node has one exit. A reject would find no wired path and fail the
       * whole instance — so a "no" on a notice would decline the report.
       */
      await clearWorkflows();
      await makeWorkflow({
        key: 'ack',
        isDefault: true,
        graph: {
          nodes: [
            { id: 'start', type: 'start' },
            { id: 'ack-1', type: 'acknowledge', approver: { kind: 'manager' } },
            { id: 'done', type: 'approved' },
          ],
          edges: [
            { id: 'e1', source: 'start', target: 'ack-1' },
            { id: 'e2', source: 'ack-1', target: 'done' },
          ],
        },
      });
      const { taskId, manager } = await parkOnTask();
      await expect(engine.decideTask(db, taskId, false, manager, null)).rejects.toThrow(
        /cannot be rejected/,
      );
    });

    it('accepts the acknowledgement itself', async () => {
      await clearWorkflows();
      await makeWorkflow({
        key: 'ack-ok',
        isDefault: true,
        graph: {
          nodes: [
            { id: 'start', type: 'start' },
            { id: 'ack-1', type: 'acknowledge', approver: { kind: 'manager' } },
            { id: 'done', type: 'approved' },
          ],
          edges: [
            { id: 'e1', source: 'start', target: 'ack-1' },
            { id: 'e2', source: 'ack-1', target: 'done' },
          ],
        },
      });
      const { taskId, reportId, manager } = await parkOnTask();
      await engine.decideTask(db, taskId, true, manager, null);
      const report = await db.expenseReport.findUniqueOrThrow({
        where: { id: reportId },
        select: { status: true },
      });
      expect(report.status).toBe('APPROVED');
    });

    it('skips the sibling tasks a rejection makes moot', async () => {
      /**
       * Leaving them PENDING would keep the report in two people's queues after it has
       * already been declined.
       */
      await clearWorkflows();
      await makeWorkflow({
        key: 'parallel-reject',
        isDefault: true,
        graph: {
          nodes: [
            { id: 'start', type: 'start' },
            { id: 'par', type: 'parallel', join: { kind: 'all' } },
            { id: 'a', type: 'approval', approver: { kind: 'manager' } },
            { id: 'b', type: 'approval', approver: { kind: 'manager' } },
            { id: 'done', type: 'approved' },
          ],
          edges: [
            { id: 'e1', source: 'start', target: 'par' },
            { id: 'e2', source: 'par', target: 'a' },
            { id: 'e3', source: 'par', target: 'b' },
            { id: 'e4', source: 'a', target: 'done' },
            { id: 'e5', source: 'b', target: 'done' },
          ],
        },
      });
      const manager = await makeUser();
      const submitter = await makeUser({ managerId: manager });
      const reportId = await makeReport(submitter);
      const started = await engine.startInstance(db, 'EXPENSE_REPORT', reportId);
      if (started.instanceId) instanceIds.push(started.instanceId);
      const tasks = await db.approvalTask.findMany({
        where: { instanceId: started.instanceId },
        select: { id: true },
      });
      if (tasks.length < 2) return;
      await engine.decideTask(db, tasks[0].id, false, manager, 'no');
      const remaining = await db.approvalTask.findMany({
        where: { instanceId: started.instanceId, status: 'PENDING' },
      });
      expect(remaining).toHaveLength(0);
    });
  });

  // ── what a started instance looks like ──────────────────────────────────────

  describe('starting an instance', () => {
    it('reports NO_WORKFLOW rather than failing when nothing governs the subject', async () => {
      /**
       * The auto-approve path: a tenant that has authored no workflow still has to be
       * able to file a report.
       */
      await clearWorkflows();
      const submitter = await makeUser();
      const reportId = await makeReport(submitter);
      const result = await engine.startInstance(db, 'EXPENSE_REPORT', reportId);
      expect(result).toMatchObject({ instanceId: null, status: 'NO_WORKFLOW' });
    });

    it('parks on a task and records the instance', async () => {
      await clearWorkflows();
      await makeWorkflow({ key: 'start-park', isDefault: true });
      const manager = await makeUser();
      const submitter = await makeUser({ managerId: manager });
      const reportId = await makeReport(submitter);
      const result = await engine.startInstance(db, 'EXPENSE_REPORT', reportId);
      if (result.instanceId) instanceIds.push(result.instanceId);
      expect(result.instanceId).toBeTruthy();
      expect(result.createdTaskIds.length).toBeGreaterThan(0);
    });

    it('assigns the task to the requester’s own manager', async () => {
      // The whole meaning of a `manager` node: relative to whoever asked.
      await clearWorkflows();
      await makeWorkflow({ key: 'start-assign', isDefault: true });
      const manager = await makeUser();
      const submitter = await makeUser({ managerId: manager });
      const reportId = await makeReport(submitter);
      const result = await engine.startInstance(db, 'EXPENSE_REPORT', reportId);
      if (result.instanceId) instanceIds.push(result.instanceId);
      const task = await db.approvalTask.findFirstOrThrow({
        where: { instanceId: result.instanceId },
        select: { assigneeUserId: true },
      });
      expect(task.assigneeUserId).toBe(manager);
    });

    it('refuses a subject that does not exist', async () => {
      /**
       * Better a loud failure than an instance routed on empty facts, which would take
       * whichever branch a null amount happens to satisfy.
       */
      await expect(
        engine.startInstance(db, 'EXPENSE_REPORT', '00000000-0000-7000-8000-0000000000e4'),
      ).rejects.toThrow(/not found/);
    });
  });

  // ── every subject type the engine adopts ────────────────────────────────────

  describe('the other subjects it routes', () => {
    /**
     * Each subject type has its own adapter — the facts it offers a predicate, and what
     * a decision writes back. They are separate code paths with separate meanings, and
     * the write-back is the half that changes the world:
     *
     *   · a card REQUEST records who decided it,
     *   · a LIMIT INCREASE applies the new ceiling to the card, but only on approval,
     *   · a TRAVEL request snapshots its total at approval, so a fare that moves next
     *     week does not restate what was authorised.
     */
    const cardIds: string[] = [];
    const requestIds: string[] = [];
    const increaseIds: string[] = [];
    const travelIds: string[] = [];

    const makeCard = async (userId: string, spendLimitMinor = 100_000n): Promise<string> => {
      const card = await db.virtualCard.create({
        data: {
          userId,
          last4: '4242',
          cardholderName: 'QA Engine',
          alias: `${TAG}-card-${cardIds.length}`,
          status: 'ACTIVE',
          currencyId,
          spendLimitMinor,
        },
        select: { id: true },
      });
      cardIds.push(card.id);
      return card.id;
    };

    const parkOn = async (
      subjectType: 'VIRTUAL_CARD_REQUEST' | 'VIRTUAL_CARD_LIMIT_INCREASE' | 'TRAVEL_REQUEST',
      subjectId: string,
    ): Promise<{ taskId: string; assignee: string | null }> => {
      const started = await engine.startInstance(db, subjectType as never, subjectId);
      if (started.instanceId) instanceIds.push(started.instanceId);
      const task = await db.approvalTask.findFirstOrThrow({
        where: { instanceId: started.instanceId },
        select: { id: true, assigneeUserId: true },
      });
      return { taskId: task.id, assignee: task.assigneeUserId };
    };

    afterAll(async () => {
      await db.travelRequest.deleteMany({ where: { id: { in: travelIds } } }).catch(() => {});
      await db.virtualCardLimitIncrease
        .deleteMany({ where: { id: { in: increaseIds } } })
        .catch(() => {});
      await db.virtualCardRequest.deleteMany({ where: { id: { in: requestIds } } }).catch(() => {});
      await db.virtualCard.deleteMany({ where: { id: { in: cardIds } } }).catch(() => {});
    });

    // VeloExpense: virtual-card subjects are out of scope (d50).
    describe.skip('a virtual-card request', () => {
      const makeRequest = async (
        userId: string,
        over: Record<string, unknown> = {},
      ): Promise<string> => {
        const r = await db.virtualCardRequest.create({
          data: {
            userId,
            purpose: 'QA engine',
            alias: `${TAG}-req-${requestIds.length}`,
            currencyId,
            requestedLimitMinor: 250_000n,
            ...over,
          },
          select: { id: true },
        });
        requestIds.push(r.id);
        return r.id;
      };

      it('routes on the requested limit', async () => {
        /**
         * The limit is the amount an amount-tiered workflow compares — normalized to
         * the org's base currency, so a card asked for in euros lands in the same tier
         * as the equivalent in dollars.
         */
        await clearWorkflows();
        await makeWorkflow({
          key: 'vcc-tier',
          subjectType: 'VIRTUAL_CARD_REQUEST',
          matchCondition: { all: [{ field: 'amount', op: 'gte', value: 200_000 }] },
        });
        const manager = await makeUser();
        const requester = await makeUser({ managerId: manager });
        const id = await makeRequest(requester);
        const started = await engine.startInstance(db, 'VIRTUAL_CARD_REQUEST' as never, id);
        if (started.instanceId) instanceIds.push(started.instanceId);
        expect(started.instanceId).toBeTruthy();
      });

      it('routes a request with no limit at all', async () => {
        /**
         * The limit is nullable — a request can be filed asking the issuer to decide —
         * and a null amount must not throw on the way into the predicate.
         */
        await clearWorkflows();
        await makeWorkflow({
          key: 'vcc-any',
          subjectType: 'VIRTUAL_CARD_REQUEST',
          isDefault: true,
        });
        const manager = await makeUser();
        const requester = await makeUser({ managerId: manager });
        const id = await makeRequest(requester, { requestedLimitMinor: null });
        const started = await engine.startInstance(db, 'VIRTUAL_CARD_REQUEST' as never, id);
        if (started.instanceId) instanceIds.push(started.instanceId);
        expect(started.instanceId).toBeTruthy();
      });

      it('records who decided it', async () => {
        await clearWorkflows();
        await makeWorkflow({
          key: 'vcc-decide',
          subjectType: 'VIRTUAL_CARD_REQUEST',
          isDefault: true,
        });
        const manager = await makeUser();
        const requester = await makeUser({ managerId: manager });
        const id = await makeRequest(requester);
        const { taskId } = await parkOn('VIRTUAL_CARD_REQUEST', id);
        await engine.decideTask(db, taskId, true, manager, null);
        const row = await db.virtualCardRequest.findUniqueOrThrow({
          where: { id },
          select: { status: true, decidedById: true, decidedAt: true },
        });
        expect(row.status).toBe('APPROVED');
        expect(row.decidedById).toBe(manager);
        expect(row.decidedAt).not.toBeNull();
      });

      it('records a refusal the same way', async () => {
        // Who said no, and when, is the part somebody asks about afterwards.
        await clearWorkflows();
        await makeWorkflow({
          key: 'vcc-reject',
          subjectType: 'VIRTUAL_CARD_REQUEST',
          isDefault: true,
        });
        const manager = await makeUser();
        const requester = await makeUser({ managerId: manager });
        const id = await makeRequest(requester);
        const { taskId } = await parkOn('VIRTUAL_CARD_REQUEST', id);
        await engine.decideTask(db, taskId, false, manager, 'no need');
        const row = await db.virtualCardRequest.findUniqueOrThrow({
          where: { id },
          select: { status: true, decidedById: true },
        });
        expect(row.status).toBe('REJECTED');
        expect(row.decidedById).toBe(manager);
      });

      it('names the requester, so they cannot approve their own card', async () => {
        const requester = await makeUser();
        const id = await makeRequest(requester);
        expect(await engine.loadRequesterId(db, 'VIRTUAL_CARD_REQUEST' as never, id)).toBe(requester);
      });

      it('refuses to start on a request that does not exist', async () => {
        await expect(
          engine.startInstance(db, 'VIRTUAL_CARD_REQUEST' as never, '00000000-0000-7000-8000-0000000000f1'),
        ).rejects.toThrow(/not found/);
      });
    });

    // VeloExpense: virtual-card subjects are out of scope (d50).
    describe.skip('a limit increase', () => {
      const makeIncrease = async (
        requestedById: string,
        cardId: string,
        requestedLimitMinor = 500_000n,
      ): Promise<string> => {
        const r = await db.virtualCardLimitIncrease.create({
          data: {
            cardId,
            requestedById,
            requestedLimitMinor,
            reason: 'QA engine',
          },
          select: { id: true },
        });
        increaseIds.push(r.id);
        return r.id;
      };

      it('applies the new ceiling to the card on approval', async () => {
        /**
         * The whole point of the subject. An approval that recorded a decision without
         * moving the limit would read as granted while the card still declined.
         */
        await clearWorkflows();
        await makeWorkflow({
          key: 'li-approve',
          subjectType: 'VIRTUAL_CARD_LIMIT_INCREASE',
          isDefault: true,
        });
        const manager = await makeUser();
        const holder = await makeUser({ managerId: manager });
        const cardId = await makeCard(holder, 100_000n);
        const id = await makeIncrease(holder, cardId, 500_000n);
        const { taskId } = await parkOn('VIRTUAL_CARD_LIMIT_INCREASE', id);
        await engine.decideTask(db, taskId, true, manager, null);
        const card = await db.virtualCard.findUniqueOrThrow({
          where: { id: cardId },
          select: { spendLimitMinor: true },
        });
        expect(card.spendLimitMinor?.toString()).toBe('500000');
      });

      it('leaves the card untouched on a refusal', async () => {
        // A declined increase that had already raised the limit would be a hole.
        await clearWorkflows();
        await makeWorkflow({
          key: 'li-reject',
          subjectType: 'VIRTUAL_CARD_LIMIT_INCREASE',
          isDefault: true,
        });
        const manager = await makeUser();
        const holder = await makeUser({ managerId: manager });
        const cardId = await makeCard(holder, 100_000n);
        const id = await makeIncrease(holder, cardId, 500_000n);
        const { taskId } = await parkOn('VIRTUAL_CARD_LIMIT_INCREASE', id);
        await engine.decideTask(db, taskId, false, manager, 'not now');
        const card = await db.virtualCard.findUniqueOrThrow({
          where: { id: cardId },
          select: { spendLimitMinor: true },
        });
        expect(card.spendLimitMinor?.toString()).toBe('100000');
        const row = await db.virtualCardLimitIncrease.findUniqueOrThrow({
          where: { id },
          select: { status: true },
        });
        expect(row.status).toBe('REJECTED');
      });

      it('routes on the REQUESTER’s own attributes, not the cardholder’s', async () => {
        /**
         * A manager can ask for an increase on somebody else's card. The approval chain
         * is the asker's, because they are the one making the request.
         */
        await clearWorkflows();
        await makeWorkflow({
          key: 'li-route',
          subjectType: 'VIRTUAL_CARD_LIMIT_INCREASE',
          isDefault: true,
        });
        const askerManager = await makeUser();
        const asker = await makeUser({ managerId: askerManager });
        const otherManager = await makeUser();
        const holder = await makeUser({ managerId: otherManager });
        const cardId = await makeCard(holder);
        const id = await makeIncrease(asker, cardId);
        const { assignee } = await parkOn('VIRTUAL_CARD_LIMIT_INCREASE', id);
        expect(assignee).toBe(askerManager);
      });

      it('names the asker as the requester', async () => {
        const asker = await makeUser();
        const cardId = await makeCard(asker);
        const id = await makeIncrease(asker, cardId);
        expect(await engine.loadRequesterId(db, 'VIRTUAL_CARD_LIMIT_INCREASE' as never, id)).toBe(asker);
      });

      it('refuses to start on one that does not exist', async () => {
        await expect(
          engine.startInstance(
            db,
            'VIRTUAL_CARD_LIMIT_INCREASE' as never,
            '00000000-0000-7000-8000-0000000000f2',
          ),
        ).rejects.toThrow(/not found/);
      });
    });

    // VeloExpense: travel requests arrive with their own wave; no travel table yet.
    describe.skip('a travel request', () => {
      let categoryId: string;

      const makeTravel = async (
        submitterId: string,
        lineAmounts: bigint[] = [200_000n],
        over: Record<string, unknown> = {},
      ): Promise<string> => {
        /**
         * A TRAVEL category, not an expense one.
         *
         * `TravelBudgetLine.categoryId` was re-pointed to `TravelCategory` when travel
         * got its own taxonomy — an expense id here fails the FK. This file had been
         * failing on it since, invisibly, because CI runs no `db` project (it has no
         * DATABASE_URL) and the whole describe was therefore never green anywhere.
         */
        categoryId ??= (await db.travelCategory.findFirstOrThrow({ select: { id: true } })).id;
        const r = await db.travelRequest.create({
          data: {
            submitterId,
            purpose: 'QA engine trip',
            destinationLabel: 'Toronto',
            departDate: new Date('2026-09-01T12:00:00Z'),
            currencyId,
            status: 'SUBMITTED',
            ...over,
            budgetLines: {
              create: lineAmounts.map((amountMinor) => ({
                categoryId,
                amountMinor,
                basis: 'MANUAL',
              })),
            },
          },
          select: { id: true },
        });
        travelIds.push(r.id);
        return r.id;
      };

      it('routes on the trip’s budget total', async () => {
        /**
         * Approved on its TOTAL, like a report — the sum of its budget lines, not any
         * single fare.
         */
        await clearWorkflows();
        await makeWorkflow({
          key: 'trv-tier',
          subjectType: 'TRAVEL_REQUEST',
          matchCondition: { all: [{ field: 'amount', op: 'gte', value: 300_000 }] },
        });
        const manager = await makeUser();
        const submitter = await makeUser({ managerId: manager });
        const id = await makeTravel(submitter, [200_000n, 150_000n]);
        const started = await engine.startInstance(db, 'TRAVEL_REQUEST', id);
        if (started.instanceId) instanceIds.push(started.instanceId);
        expect(started.instanceId).toBeTruthy();
      });

      it('snapshots the total at approval', async () => {
        /**
         * A fare that moves next week, or a per-diem an admin edits next month, must
         * not restate what was authorised.
         */
        await clearWorkflows();
        await makeWorkflow({ key: 'trv-approve', subjectType: 'TRAVEL_REQUEST', isDefault: true });
        const manager = await makeUser();
        const submitter = await makeUser({ managerId: manager });
        const id = await makeTravel(submitter, [200_000n, 50_000n]);
        const { taskId } = await parkOn('TRAVEL_REQUEST', id);
        await engine.decideTask(db, taskId, true, manager, null);
        const row = await db.travelRequest.findUniqueOrThrow({
          where: { id },
          select: { status: true, approvedAt: true, approvedTotalMinor: true },
        });
        expect(row.status).toBe('APPROVED');
        expect(row.approvedTotalMinor?.toString()).toBe('250000');
        expect(row.approvedAt).not.toBeNull();
      });

      it('snapshots nothing on a refusal', async () => {
        // An approvedTotal on a declined trip would read as an authorised budget.
        await clearWorkflows();
        await makeWorkflow({ key: 'trv-reject', subjectType: 'TRAVEL_REQUEST', isDefault: true });
        const manager = await makeUser();
        const submitter = await makeUser({ managerId: manager });
        const id = await makeTravel(submitter);
        const { taskId } = await parkOn('TRAVEL_REQUEST', id);
        await engine.decideTask(db, taskId, false, manager, 'defer');
        const row = await db.travelRequest.findUniqueOrThrow({
          where: { id },
          select: { status: true, approvedAt: true, approvedTotalMinor: true },
        });
        expect(row.status).toBe('REJECTED');
        expect(row.approvedTotalMinor).toBeNull();
        expect(row.approvedAt).toBeNull();
      });

      it('prefers an existing approved snapshot over the live lines', async () => {
        /**
         * Re-running the engine on an already-approved trip — an amendment — must route
         * on what was authorised, not on lines that have since been edited.
         */
        await clearWorkflows();
        await makeWorkflow({ key: 'trv-snap', subjectType: 'TRAVEL_REQUEST', isDefault: true });
        const manager = await makeUser();
        const submitter = await makeUser({ managerId: manager });
        const id = await makeTravel(submitter, [10_000n], { approvedTotalMinor: 900_000n });
        const started = await engine.startInstance(db, 'TRAVEL_REQUEST', id);
        if (started.instanceId) instanceIds.push(started.instanceId);
        expect(started.instanceId).toBeTruthy();
      });

      it('routes a trip with no budget lines at all', async () => {
        // A trip priced later; the total is zero rather than undefined.
        await clearWorkflows();
        await makeWorkflow({ key: 'trv-empty', subjectType: 'TRAVEL_REQUEST', isDefault: true });
        const manager = await makeUser();
        const submitter = await makeUser({ managerId: manager });
        const id = await makeTravel(submitter, []);
        const started = await engine.startInstance(db, 'TRAVEL_REQUEST', id);
        if (started.instanceId) instanceIds.push(started.instanceId);
        expect(started.instanceId).toBeTruthy();
      });

      it('names the submitter as the requester', async () => {
        const submitter = await makeUser();
        const id = await makeTravel(submitter);
        expect(await engine.loadRequesterId(db, 'TRAVEL_REQUEST', id)).toBe(submitter);
      });

      it('refuses to start on a trip that does not exist', async () => {
        await expect(
          engine.startInstance(db, 'TRAVEL_REQUEST', '00000000-0000-7000-8000-0000000000f3'),
        ).rejects.toThrow(/not found/);
      });
    });

    describe('the requester lookup', () => {
      it('answers null for a subject that is gone', async () => {
        /**
         * Used by the expiry sweep, which runs long after a subject may have been
         * deleted — a throw there would stop the whole sweep.
         */
        expect(
          await engine.loadRequesterId(
            db,
            'EXPENSE_REPORT',
            '00000000-0000-7000-8000-0000000000f4',
          ),
        ).toBeNull();
      });
    });
  });
});
