// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- ported suite: the harness reads rows untyped. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { createTenantHarness, type TenantHarness } from '../../../server/__test-helpers__/tenantHarness';

/*
 * VeloExpense (w4-00b): ExpenseOS's suite (550b2945), run against one tenant, as
 * engine.db.test.ts is (see its note: the harness tenant, the engine inside its transaction).
 *
 * Roles. ExpenseOS's suite needs two roles that differ, and it uses them two ways: as the
 * role a `role` fallback names, and as "holds the approve permission" vs "does not".
 * VeloExpense's people carry a text role that stands for an ExpenseOS SYSTEM role
 * (`systemRoleFor`): EMPLOYEE → Employee, ADMIN → System Administrator. So here the two ids
 * are those two system roles' ids, and a person is made with the matching text role.
 *   · As two DIFFERENT roles they work exactly as ExpenseOS's do — a role fallback naming
 *     one admits its holders and refuses the other's.
 *   · As "lacks the approve permission" they cannot: both grant it. The one case that turns
 *     on that alone is skipped, marked. Elsewhere `noPermRoleId` names a submitter or an
 *     incidental report, where the permission plays no part.
 * Offboarding is VeloExpense's DEACTIVATED (ExpenseOS: TERMINATED).
 */
vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

/**
 * What happens to an approval whose requester has NO MANAGER.
 *
 * The behaviour this replaces was measured, not guessed. A `manager` node whose
 * requester has no manager created a task with `assigneeUserId = null`;
 * `isEligible` returns false for non-filter approver kinds, so:
 *
 *     canDecide(submitter) = false
 *     canDecide(admin)     = false     ← not even a system administrator
 *     isEligible(admin)    = false
 *     expireTask outcome   = REJECTED
 *     FINAL report status  = REJECTED
 *
 * The claim was invisible in every queue and auto-rejected five business days
 * later, so the employee was told their expense was declined — by nobody, because
 * of a gap in the HR feed. On dev this affects 80 of 703 active users (11%).
 *
 * There are now THREE answers, chosen by the node the author wrote, and this file
 * is where the difference between them is pinned:
 *
 *   · no fallback   — the legacy approver POOL, kept because a stranded task is
 *                     worse, and narrowed so the requester's own subordinates are
 *                     not in it;
 *   · user fallback — assigned to that person, and to nobody else;
 *   · role fallback — unassigned, claimable by active holders of THAT role and by
 *                     nobody else.
 *
 * The tests that matter most are the negatives. "The named approver can decide it"
 * passes just as happily on a build where EVERYONE can decide it, so it says
 * nothing on its own; what gives it meaning is the unrelated approver — someone
 * holding the very same approve permission — being refused alongside it. Every
 * positive here is paired with that control.
 *
 * Gated on DATABASE_URL like every `*.db.test.ts`.
 */

describe.skipIf(!process.env.DATABASE_URL)('no-manager approval fallback (integration)', () => {
  let db: any;
  let h: TenantHarness;
  let engine: typeof import('./engine');
  const userIds: string[] = [];
  const reportIds: string[] = [];
  const instanceIds: string[] = [];
  const workflowIds: string[] = [];
  /** Seeded workflows this suite parks for its duration, then puts back. */
  const parkedWorkflowIds: string[] = [];
  let currencyId: string;
  let approverRoleId: string;
  let noPermRoleId: string;

  const makeUser = async (tag: string, roleId: string, managerId: string | null) => {
    // VeloExpense: one display name, and the text role that stands for `roleId`.
    const u = await db.user.create({
      data: {
        email: `nomgr-${tag}-${userIds.length}-${process.pid}@example.test`,
        name: `QA ${tag}`,
        role: roleId === SYSTEM_ROLE_IDS.admin ? 'ADMIN' : 'EMPLOYEE',
        managerId,
        employeeStatus: 'ACTIVE',
      },
      select: { id: true },
    });
    userIds.push(u.id);
    return u.id;
  };

  /**
   * Publish a one-approval-node workflow with the given approver, and make it the
   * only thing that can govern an expense report.
   *
   * The suite used to lean on the SEEDED `expense-report-default` graph, and that
   * stopped being a way to test the pool the moment the seed started naming a
   * fallback approver of its own: every assertion here would have been reading the
   * seed's routing decision rather than the rule under test. Owning the graph is
   * also what lets one file cover BOTH worlds — a node with a fallback and a node
   * without — which is the whole comparison this change turns on.
   */
  const publishWorkflow = async (
    approver: unknown,
    nodeType: 'approval' | 'acknowledge' = 'approval',
  ) => {
    // Deactivated, not deleted: earlier tests' instances still point at these
    // versions, and dropping a workflow out from under a running instance is a
    // fixture failure that would read as an engine one.
    await db.approvalWorkflow
      .updateMany({ where: { id: { in: workflowIds } }, data: { active: false } })
      .catch(() => {});
    const wf = await db.approvalWorkflow.create({
      data: {
        key: `nomgr-${process.pid}-${Date.now()}`,
        name: 'QA no-manager fallback',
        subjectType: 'EXPENSE_REPORT',
        isDefault: true,
        priority: 100,
        active: true,
      },
      select: { id: true },
    });
    workflowIds.push(wf.id);
    const version = await db.approvalWorkflowVersion.create({
      data: {
        workflowId: wf.id,
        version: 1,
        matchCondition: { always: true },
        graph: {
          nodes: [
            { id: 'start', type: 'start' },
            { id: 'mgr', type: nodeType, approver, ttlBusinessDays: 5, onExpire: 'ESCALATE' },
            { id: 'approved', type: 'approved' },
          ],
          edges: [
            { id: 'e1', source: 'start', target: 'mgr' },
            { id: 'e2', source: 'mgr', target: 'approved' },
          ],
        },
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
      select: { id: true },
    });
    await db.approvalWorkflow.update({
      where: { id: wf.id },
      data: { currentVersionId: version.id },
    });
  };

  /** A submitted report routed through whatever `publishWorkflow` last installed. */
  const submitUnderFirstTier = async (submitterId: string) => {
    const r = await db.expenseReport.create({
      data: {
        title: 'QA no-manager report',
        submitterId,
        currencyId,
        status: 'SUBMITTED',
        totalMinor: 100_000n, // $1,000 — the "< $5k → direct manager" tier
      },
      select: { id: true },
    });
    reportIds.push(r.id);
    const res = await engine.startInstance(db, 'EXPENSE_REPORT', r.id);
    const insts = await db.approvalInstance.findMany({
      where: { subjectId: r.id },
      select: { id: true },
    });
    instanceIds.push(...insts.map((i: any) => i.id));
    return { reportId: r.id, ...res };
  };

  beforeAll(async () => {
    // VeloExpense: the harness tenant, and the engine run inside its transaction.
    h = await createTenantHarness({ slug: 'no-manager', name: 'No Manager' });
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
    // A role that grants expense.report.approve, and one that does not — the
    // fallback must distinguish them.
    // VeloExpense: two different system roles, both of which grant it (see the note above).
    approverRoleId = SYSTEM_ROLE_IDS.employee;
    noPermRoleId = SYSTEM_ROLE_IDS.admin;

    // Workflow selection is global by subject type, so the seeded expense workflow
    // would win every test here — including the ones that exist to describe a node
    // it no longer contains. Parked for the file, restored in afterAll; the db
    // project runs files one at a time, so nothing else is reading these rows.
    const seeded = await db.approvalWorkflow.findMany({
      where: { active: true, subjectType: 'EXPENSE_REPORT' },
      select: { id: true },
    });
    parkedWorkflowIds.push(...seeded.map((w: { id: string }) => w.id));
    await db.approvalWorkflow.updateMany({
      where: { id: { in: parkedWorkflowIds } },
      data: { active: false },
    });
  });

  beforeEach(async () => {
    // The default world for this suite: a relative approver with NO fallback, i.e.
    // every workflow published before this feature existed.
    await publishWorkflow({ kind: 'manager' });
  });

  afterAll(async () => {
    await db.approvalTask
      .deleteMany({ where: { instanceId: { in: instanceIds } } })
      .catch(() => {});
    await db.approvalInstance.deleteMany({ where: { id: { in: instanceIds } } }).catch(() => {});
    await db.expenseReport.deleteMany({ where: { id: { in: reportIds } } }).catch(() => {});
    await db.approvalWorkflow.deleteMany({ where: { id: { in: workflowIds } } }).catch(() => {});
    await db.approvalWorkflow
      .updateMany({ where: { id: { in: parkedWorkflowIds } }, data: { active: true } })
      .catch(() => {});
    await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await h?.end();
  });

  it('still parks an unassigned task when the requester has no manager', async () => {
    // Unchanged and deliberate: the engine does not invent an assignee. What
    // changes is who may claim it.
    const submitter = await makeUser('submitter', noPermRoleId, null);
    const { createdTaskIds, status } = await submitUnderFirstTier(submitter);
    expect(status).toBe('RUNNING');
    expect(createdTaskIds).toHaveLength(1);
    const t = await db.approvalTask.findUniqueOrThrow({
      where: { id: createdTaskIds[0] },
      select: { assigneeUserId: true, status: true },
    });
    expect(t).toMatchObject({ assigneeUserId: null, status: 'PENDING' });
  });

  it('lets an approver-pool member decide it', async () => {
    // The fix. Before this, canDecide was false for every user in the system.
    // The approver needs a report of their own — see the next test for why.
    const submitter = await makeUser('submitter2', noPermRoleId, null);
    const approver = await makeUser('approver', approverRoleId, null);
    await makeUser('approvers-report', noPermRoleId, approver);
    const { createdTaskIds } = await submitUnderFirstTier(submitter);
    expect(await engine.canDecide(db, createdTaskIds[0], approver, false)).toBe(true);
  });

  it('refuses a permission-holder who manages NOBODY', async () => {
    /**
     * The bound that keeps the fold of Manager into Employee from widening this pool to the
     * whole company.
     *
     * Until the fold, `expense.report.approve` WAS the bound: only the handful of people
     * holding the Manager role could claim an unresolved relative-approver task. Employee
     * now carries that permission — the engine, not the role, is what authorizes a decision
     * — so on the seeded directory this pool would have gone from 135 people to 907 without
     * the check.
     *
     * Having at least one direct report is the honest test of the thing the Manager role was
     * standing in for, and it is the definition the fold is built on.
     */
    const submitter = await makeUser('nobound-submitter', noPermRoleId, null);
    const managesNobody = await makeUser('nobound-approver', approverRoleId, null);
    const { createdTaskIds } = await submitUnderFirstTier(submitter);
    expect(await engine.canDecide(db, createdTaskIds[0], managesNobody, false)).toBe(false);

    // The SAME user, once somebody reports to them, may claim it. Nothing else about them
    // changes, so nothing but the report count can be producing the difference.
    await makeUser('nobound-report', noPermRoleId, managesNobody);
    expect(await engine.canDecide(db, createdTaskIds[0], managesNobody, false)).toBe(true);
  });

  it('lets the pool decide an ACKNOWLEDGE node too, not only an approval', async () => {
    /**
     * The node shape nobody checked, and the one where the lapse is quietest.
     *
     * `approverFallbackOf` and `resolveApprover` both accept `approval` and `acknowledge`.
     * `isRelativeApprover` — which gates the claim pool — accepted only `approval`. So an
     * acknowledge node routed to a manager-less person resolved to nobody and then admitted
     * nobody: `canDecide` was false for every user in the system, and the task sat until its
     * TTL expired.
     *
     * That is exactly the silent lapse #224 removed, still alive in this one shape. It is
     * worse here than on an approval, because an acknowledgement that expires
     * unacknowledged leaves nothing about the subject looking wrong afterwards.
     */
    await publishWorkflow({ kind: 'manager' }, 'acknowledge');
    const submitter = await makeUser('ack-submitter', noPermRoleId, null);
    const approver = await makeUser('ack-approver', approverRoleId, null);
    await makeUser('ack-approvers-report', noPermRoleId, approver);
    const { createdTaskIds } = await submitUnderFirstTier(submitter);
    expect(createdTaskIds).toHaveLength(1);
    const t = await db.approvalTask.findUniqueOrThrow({
      where: { id: createdTaskIds[0] },
      select: { assigneeUserId: true },
    });
    // Unassigned, exactly as the approval case — the pool is what has to catch it.
    expect(t.assigneeUserId).toBeNull();
    expect(await engine.canDecide(db, createdTaskIds[0], approver, false)).toBe(true);
  });

  // VeloExpense: every VeloExpense role grants the approve permission (see the note above).
  it.skip('does not let somebody without the approve permission decide it', async () => {
    // "Claimable by a pool" has to mean a pool, not everybody.
    const submitter = await makeUser('submitter3', noPermRoleId, null);
    const bystander = await makeUser('bystander', noPermRoleId, null);
    const { createdTaskIds } = await submitUnderFirstTier(submitter);
    expect(await engine.canDecide(db, createdTaskIds[0], bystander, false)).toBe(false);
  });

  it('never lets the submitter approve their own claim', async () => {
    // The whole point of an approval. Note the submitter here HOLDS the approve
    // permission, so only the self-approval block stops them — exactly the case
    // a pool fallback could have opened up.
    const submitter = await makeUser('selfapprover', approverRoleId, null);
    const { createdTaskIds } = await submitUnderFirstTier(submitter);
    expect(await engine.canDecide(db, createdTaskIds[0], submitter, false)).toBe(false);
  });

  it('does NOT widen an assigned task to the pool', async () => {
    // The privilege-escalation guard. A task parked on a specific manager must
    // stay theirs; if the fallback ignored the assignee, any approver in the
    // company could decide anyone else's routed approval.
    const manager = await makeUser('realmgr', approverRoleId, null);
    const submitter = await makeUser('hasmgr', noPermRoleId, manager);
    const other = await makeUser('otherapprover', approverRoleId, null);
    const { createdTaskIds } = await submitUnderFirstTier(submitter);
    const t = await db.approvalTask.findUniqueOrThrow({
      where: { id: createdTaskIds[0] },
      select: { assigneeUserId: true },
    });
    expect(t.assigneeUserId).toBe(manager);
    expect(await engine.canDecide(db, createdTaskIds[0], manager, false)).toBe(true);
    expect(await engine.canDecide(db, createdTaskIds[0], other, false)).toBe(false);
  });

  it("escalates an unassigned task to the REQUESTER's manager instead of rejecting it", async () => {
    /**
     * The other half of the no-manager story. `expireTask`'s ESCALATE branch used
     * to require a truthy assignee, so an unassigned task that lapsed fell straight
     * through to REJECT — conflating "your approver ignored this" with "we never
     * found you an approver", and punishing the claimant for the second.
     *
     * Here the submitter HAS a manager but the task is unassigned (the pool case).
     * Escalation should reach that manager rather than auto-rejecting.
     */
    const manager = await makeUser('escmgr', approverRoleId, null);
    const submitter = await makeUser('escsub', noPermRoleId, manager);
    const { createdTaskIds } = await submitUnderFirstTier(submitter);
    // Force the unassigned-pool shape the fallback exists for.
    await db.approvalTask.update({
      where: { id: createdTaskIds[0] },
      data: { assigneeUserId: null },
    });

    const res = await engine.expireTask(db, createdTaskIds[0]);
    expect(res.outcome).toBe('ESCALATED');
    const after = await db.approvalTask.findUniqueOrThrow({
      where: { id: createdTaskIds[0] },
      select: { assigneeUserId: true, status: true, escalationLevel: true },
    });
    expect(after).toMatchObject({
      assigneeUserId: manager,
      status: 'PENDING',
      escalationLevel: 1,
    });
  });

  it('still auto-rejects an unassigned task when nobody is above the requester', async () => {
    // The genuine top of the chain. Escalation has nowhere to go, so rejecting is
    // correct — and must stay correct, or a lapsed claim would hang forever.
    const submitter = await makeUser('esctop', noPermRoleId, null);
    const { reportId, createdTaskIds } = await submitUnderFirstTier(submitter);
    await db.approvalTask.update({
      where: { id: createdTaskIds[0] },
      data: { assigneeUserId: null },
    });
    const res = await engine.expireTask(db, createdTaskIds[0]);
    expect(res.outcome).toBe('REJECTED');
    const report = await db.expenseReport.findUniqueOrThrow({
      where: { id: reportId },
      select: { status: true },
    });
    expect(report.status).toBe('REJECTED');
  });

  it('never applies to a filter-approver node', async () => {
    /**
     * The over-broad case, and the one the other tests missed: a `filter` node is
     * ALREADY unassigned by design — that is how pools work — and its authored
     * predicate is the authorization. If the fallback treated it as "unresolved",
     * any approve-permission holder could claim a pool task whose predicate
     * deliberately excludes them, silently overriding the workflow the admin wrote.
     *
     * Asserted against `canClaimUnresolvedApproval` directly, with a node whose
     * predicate matches nobody, because constructing a published filter workflow
     * would test the fixture more than the rule.
     */
    const approver = await makeUser('filterprobe', approverRoleId, null);
    const filterNode = {
      id: 'n-filter',
      type: 'approval' as const,
      approver: {
        kind: 'filter' as const,
        // Matches no one: a department nobody belongs to.
        match: { field: 'departmentId', op: 'eq', value: '00000000-0000-0000-0000-000000000000' },
      },
    };
    expect(
      await engine.canClaimUnresolvedApproval(
        db,
        filterNode as never,
        'EXPENSE_REPORT',
        '00000000-0000-7000-8000-0000000000e0',
        approver,
      ),
    ).toBe(false);
  });

  it('refuses a deactivated or terminated pool member', async () => {
    const submitter = await makeUser('submitter4', noPermRoleId, null);
    const gone = await makeUser('terminated', approverRoleId, null);
    await db.user.update({ where: { id: gone }, data: { employeeStatus: 'DEACTIVATED' } /* VeloExpense: ExpenseOS's TERMINATED */ });
    const { createdTaskIds } = await submitUnderFirstTier(submitter);
    expect(await engine.canDecide(db, createdTaskIds[0], gone, false)).toBe(false);
  });

  it('approves through the pool rather than auto-approving', async () => {
    // End to end: the report reaches APPROVED because a HUMAN decided, and the
    // task records who. Auto-approval would leave decidedById null.
    const submitter = await makeUser('submitter5', noPermRoleId, null);
    const approver = await makeUser('approver2', approverRoleId, null);
    const { reportId, createdTaskIds } = await submitUnderFirstTier(submitter);
    await engine.decideTask(db, createdTaskIds[0], true, approver, null);
    const [report, task] = await Promise.all([
      db.expenseReport.findUniqueOrThrow({ where: { id: reportId }, select: { status: true } }),
      db.approvalTask.findUniqueOrThrow({
        where: { id: createdTaskIds[0] },
        select: { status: true, decidedById: true },
      }),
    ]);
    expect(report.status).toBe('APPROVED');
    expect(task.status).toBe('APPROVED');
    expect(task.decidedById).toBe(approver);
  });

  it('keeps the requester’s own SUBORDINATES out of the pool', async () => {
    /**
     * The narrowing, and the reason the pool was never merely "unrouted".
     *
     * A manager-less requester is by definition senior, so "anyone with the approve
     * permission" included the people who report to them: someone whose job the
     * submitter controls, signing off on the submitter's spend. That is the
     * self-approval failure one hop removed, and `canDecide`'s self-block did not
     * reach it.
     *
     * Both users here hold the SAME approve permission and differ in exactly one
     * fact — one reports up to the submitter — so nothing but the narrowing can be
     * producing the difference.
     */
    const submitter = await makeUser('ceo', approverRoleId, null);
    const directReport = await makeUser('theirvp', approverRoleId, submitter);
    const grandchild = await makeUser('theirdir', approverRoleId, directReport);
    const unrelated = await makeUser('otherline', approverRoleId, null);
    // A pool member must manage somebody (see 'refuses a permission-holder who manages
    // NOBODY'). `directReport` and `grandchild` already do, by virtue of the chain below
    // them; `unrelated` needs one so that the ONLY difference between them stays the
    // reporting line.
    await makeUser('otherlines-report', noPermRoleId, unrelated);
    const { createdTaskIds } = await submitUnderFirstTier(submitter);

    expect(await engine.canDecide(db, createdTaskIds[0], unrelated, false)).toBe(true);
    expect(await engine.canDecide(db, createdTaskIds[0], directReport, false)).toBe(false);
    // Two levels down is the same problem with an extra hop in it.
    expect(await engine.canDecide(db, createdTaskIds[0], grandchild, false)).toBe(false);
  });

  describe('a node that names a USER fallback', () => {
    it('assigns the task to that person instead of parking it', async () => {
      const cfo = await makeUser('cfo', noPermRoleId, null);
      await publishWorkflow({ kind: 'manager', fallback: { kind: 'user', userId: cfo } });
      const submitter = await makeUser('ceo2', noPermRoleId, null);
      const { createdTaskIds } = await submitUnderFirstTier(submitter);
      const t = await db.approvalTask.findUniqueOrThrow({
        where: { id: createdTaskIds[0] },
        select: { assigneeUserId: true, status: true },
      });
      // Assignment is what puts it in a queue, notifies, escalates and delegates.
      expect(t).toMatchObject({ assigneeUserId: cfo, status: 'PENDING' });
      expect(await engine.canDecide(db, createdTaskIds[0], cfo, false)).toBe(true);
    });

    it('shuts the pool: an unrelated approver can no longer claim it', async () => {
      /**
       * THE test. Without it, the one above passes on a build where every line
       * manager in the company can also decide the CEO's expense report — which is
       * exactly the build this change replaces.
       */
      const cfo = await makeUser('cfo2', noPermRoleId, null);
      await publishWorkflow({ kind: 'manager', fallback: { kind: 'user', userId: cfo } });
      const submitter = await makeUser('ceo3', noPermRoleId, null);
      const otherManager = await makeUser('linemgr', approverRoleId, null);
      const { createdTaskIds } = await submitUnderFirstTier(submitter);
      expect(await engine.canDecide(db, createdTaskIds[0], otherManager, false)).toBe(false);
    });

    it('shuts the pool even if the task somehow parks unassigned', async () => {
      /**
       * The test above is satisfied by the ASSIGNMENT alone — the pool branch is
       * never reached while a real assignee exists — so it says nothing about the
       * rule that a user fallback is exclusive. This forces the unassigned shape
       * (a graph edited after the instance started, a hand-fixed row) and asserts
       * that the pool is still shut: a named approver stays named.
       */
      const cfo = await makeUser('cfo5', noPermRoleId, null);
      await publishWorkflow({ kind: 'manager', fallback: { kind: 'user', userId: cfo } });
      const submitter = await makeUser('ceo9', noPermRoleId, null);
      const otherManager = await makeUser('linemgr2', approverRoleId, null);
      const { createdTaskIds } = await submitUnderFirstTier(submitter);
      await db.approvalTask.update({
        where: { id: createdTaskIds[0] },
        data: { assigneeUserId: null },
      });
      expect(await engine.canDecide(db, createdTaskIds[0], otherManager, false)).toBe(false);
    });

    it('is ignored when the requester HAS a manager', async () => {
      // A fallback is a fallback. If it ever outranked a real manager, every
      // ordinary approval in the org would be re-routed to one person.
      const cfo = await makeUser('cfo3', approverRoleId, null);
      await publishWorkflow({ kind: 'manager', fallback: { kind: 'user', userId: cfo } });
      const manager = await makeUser('realmgr2', approverRoleId, null);
      const submitter = await makeUser('hasmgr2', noPermRoleId, manager);
      const { createdTaskIds } = await submitUnderFirstTier(submitter);
      const t = await db.approvalTask.findUniqueOrThrow({
        where: { id: createdTaskIds[0] },
        select: { assigneeUserId: true },
      });
      expect(t.assigneeUserId).toBe(manager);
      expect(await engine.canDecide(db, createdTaskIds[0], cfo, false)).toBe(false);
    });

    it('covers a managerChain approver too, not just a direct manager', async () => {
      /**
       * `resolveManagerChain` returns the most senior ancestor it found and null
       * only when there is no manager at all — the same person falls through both
       * kinds. The seeded expense workflow routes everything over $5k through
       * managerChain nodes, so a fallback that only worked on `manager` would have
       * covered the CEO's lunch and stranded their offsite.
       */
      const cfo = await makeUser('cfo4', noPermRoleId, null);
      await publishWorkflow({
        kind: 'managerChain',
        minJobLevelId: null,
        fallback: { kind: 'user', userId: cfo },
      });
      const submitter = await makeUser('ceo4', noPermRoleId, null);
      const { createdTaskIds } = await submitUnderFirstTier(submitter);
      const t = await db.approvalTask.findUniqueOrThrow({
        where: { id: createdTaskIds[0] },
        select: { assigneeUserId: true },
      });
      expect(t.assigneeUserId).toBe(cfo);
    });
  });

  describe('a node that names a ROLE fallback', () => {
    it('leaves the task unassigned and lets a holder of that role decide it', async () => {
      /**
       * Deliberately NOT assigned, even when the role has exactly one holder.
       * Resolving a role to a person at task-creation time would make the same
       * authored workflow behave differently the day somebody else is given the
       * role — a flip that is invisible in the editor.
       */
      await publishWorkflow({
        kind: 'manager',
        fallback: { kind: 'role', roleId: approverRoleId },
      });
      const submitter = await makeUser('ceo5', noPermRoleId, null);
      const holder = await makeUser('financeteam', approverRoleId, null);
      const { createdTaskIds } = await submitUnderFirstTier(submitter);
      const t = await db.approvalTask.findUniqueOrThrow({
        where: { id: createdTaskIds[0] },
        select: { assigneeUserId: true },
      });
      expect(t.assigneeUserId).toBeNull();
      expect(await engine.canDecide(db, createdTaskIds[0], holder, false)).toBe(true);
    });

    it('refuses somebody outside the role who holds the approve permission', async () => {
      /**
       * The negative that makes the role fallback mean anything. The named role here
       * is one WITHOUT the approve permission, and the outsider HAS it — so a build
       * that quietly fell back to "anyone who may approve" would let the outsider
       * through and this is the only assertion that would notice.
       */
      await publishWorkflow({
        kind: 'manager',
        fallback: { kind: 'role', roleId: noPermRoleId },
      });
      const submitter = await makeUser('ceo6', approverRoleId, null);
      const holder = await makeUser('namedrole', noPermRoleId, null);
      const outsider = await makeUser('permholder', approverRoleId, null);
      const { createdTaskIds } = await submitUnderFirstTier(submitter);
      expect(await engine.canDecide(db, createdTaskIds[0], holder, false)).toBe(true);
      expect(await engine.canDecide(db, createdTaskIds[0], outsider, false)).toBe(false);
    });

    it('refuses a holder who has left', async () => {
      await publishWorkflow({
        kind: 'manager',
        fallback: { kind: 'role', roleId: approverRoleId },
      });
      const submitter = await makeUser('ceo7', noPermRoleId, null);
      const gone = await makeUser('exholder', approverRoleId, null);
      await db.user.update({ where: { id: gone }, data: { employeeStatus: 'DEACTIVATED' } /* VeloExpense: ExpenseOS's TERMINATED */ });
      const { createdTaskIds } = await submitUnderFirstTier(submitter);
      expect(await engine.canDecide(db, createdTaskIds[0], gone, false)).toBe(false);
    });

    it('never lets the submitter decide, even holding the named role', async () => {
      // The one rule no fallback may relax.
      await publishWorkflow({
        kind: 'manager',
        fallback: { kind: 'role', roleId: approverRoleId },
      });
      const submitter = await makeUser('ceo8', approverRoleId, null);
      const { createdTaskIds } = await submitUnderFirstTier(submitter);
      expect(await engine.canDecide(db, createdTaskIds[0], submitter, false)).toBe(false);
    });
  });
});
