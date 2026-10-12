// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the harness reads rows untyped. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { createTenantHarness, type TenantHarness } from '../../server/__test-helpers__/tenantHarness';

/**
 * VeloExpense (w4-00c-1, d54 / d56 / d59): the approval flow every tenant starts on, against a real
 * Postgres and ExpenseOS's engine.
 *
 *   · provisioning gives a new tenant the default workflow, published, the default for
 *     expense reports — because the engine APPROVES a report no workflow governs;
 *   · it routes to the submitter's manager, and with no manager to the administrators
 *     (d59): any of them may take it but the submitter, and nobody else may;
 *   · it sets no deadline (d56): the task's `expiresAt` is null, while a step an admin gives
 *     a deadline still gets one;
 *   · migrations 0059 and 0060, run in order, write the same workflow for a tenant that has
 *     none, and leave a tenant that has one alone; 0060 leaves an admin's edit alone.
 *
 * Gated on DATABASE_URL; the hermetic CI run skips it.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

describe.skipIf(!process.env.DATABASE_URL)('the default approval workflow (integration)', () => {
  let h: TenantHarness;
  let engine: typeof import('@expenseos/approvals/engine');
  let founder: string;
  let manager: string;
  let employee: string;
  let topLevel: string;
  let secondAdmin: string;
  const inTx = <T>(fn: (tx: any) => Promise<T>): Promise<T> => h.db.$transaction(fn);

  const makeReport = async (submitterId: string) =>
    (
      await h.db.expenseReport.create({
        data: { title: 'Default flow', submitterId, currencyId: 'CAD', status: 'SUBMITTED', totalMinor: 5_000n },
        select: { id: true },
      })
    ).id as string;

  const taskFor = async (reportId: string) => {
    const started = await inTx((tx) => engine.startInstance(tx, 'EXPENSE_REPORT', reportId));
    expect(started.status).toBe('RUNNING');
    return (
      await h.admin.query(
        `SELECT id, assignee_user_id, expires_at FROM approval_instance_task WHERE instance_id = $1`,
        [started.instanceId],
      )
    ).rows;
  };
  const mayDecide = (taskId: string, actorId: string) =>
    inTx((tx) => engine.canDecide(tx, taskId, actorId, false));

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'default-flow',
      name: 'Default Flow',
      people: [
        { email: 'manager@default-flow.example', name: 'Manager' },
        { email: 'employee@default-flow.example', name: 'Employee' },
        { email: 'top@default-flow.example', name: 'No Manager' },
        { email: 'admin2@default-flow.example', name: 'Second Admin', role: 'ADMIN' },
      ],
    });
    [founder, manager, employee, topLevel, secondAdmin] = h.people.map((p) => p.id);
    await h.admin.query(`UPDATE app_user SET manager_id = $1 WHERE id = $2`, [manager, employee]);
    engine = await import('@expenseos/approvals/engine');
  });

  afterAll(async () => {
    await h?.end();
  });

  it('is created with the tenant: published, the default for expense reports', async () => {
    const rows = (
      await h.admin.query(
        `SELECT w.key, w.subject_type, w.is_default, w.active, v.status, v.graph
           FROM approval_workflow w JOIN approval_workflow_version v ON v.id = w.current_version_id
          WHERE w.organization_id = $1`,
        [h.orgId],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'expense-report-default',
      subject_type: 'EXPENSE_REPORT',
      is_default: true,
      active: true,
      status: 'PUBLISHED',
    });
    const approval = rows[0].graph.nodes.find((n: any) => n.type === 'approval');
    // d59: the no-manager fallback is the Admin system role, not a person.
    expect(approval.approver).toEqual({
      kind: 'manager',
      fallback: { kind: 'role', roleId: SYSTEM_ROLE_IDS.admin },
    });
    // d56: no deadline and no expiry policy on the step.
    expect(approval.ttlBusinessDays).toBeUndefined();
    expect(approval.onExpire).toBeUndefined();
  });

  it("routes to the submitter's manager, with no deadline", async () => {
    const tasks = await taskFor(await makeReport(employee));
    expect(tasks).toMatchObject([{ assignee_user_id: manager, expires_at: null }]);
  });

  it('routes a submitter with no manager to the administrators, and only to them', async () => {
    const [task] = await taskFor(await makeReport(topLevel));
    expect(task).toMatchObject({ assignee_user_id: null, expires_at: null });
    expect(await mayDecide(task.id, founder)).toBe(true);
    expect(await mayDecide(task.id, secondAdmin)).toBe(true);
    expect(await mayDecide(task.id, manager)).toBe(false);
    expect(await mayDecide(task.id, employee)).toBe(false);
  });

  it("never lets an administrator with no manager take their own report", async () => {
    // The case d59 is for: with a named first admin as the fallback, the founder's own
    // report went back to the founder, and nobody may approve their own expenses.
    const [task] = await taskFor(await makeReport(founder));
    expect(task.assignee_user_id).toBeNull();
    expect(await mayDecide(task.id, founder)).toBe(false);
    expect(await mayDecide(task.id, secondAdmin)).toBe(true);
  });

  it('still stamps a deadline on a step an admin gave one', async () => {
    // A second workflow, more specific than the default, with a 3-business-day step.
    const wf = (
      await h.admin.query(
        `INSERT INTO approval_workflow (organization_id, key, name, subject_type, priority)
         VALUES ($1, 'with-deadline', 'With deadline', 'EXPENSE_REPORT', 10) RETURNING id`,
        [h.orgId],
      )
    ).rows[0].id;
    const graph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'a', type: 'approval', approver: { kind: 'manager' }, ttlBusinessDays: 3 },
        { id: 'done', type: 'approved' },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'a', target: 'done' },
      ],
    };
    const v = (
      await h.admin.query(
        `INSERT INTO approval_workflow_version (organization_id, workflow_id, version, match_condition, graph, status)
         VALUES ($1, $2, 1, '{"always": true}', $3::jsonb, 'PUBLISHED') RETURNING id`,
        [h.orgId, wf, JSON.stringify(graph)],
      )
    ).rows[0].id;
    await h.admin.query(`UPDATE approval_workflow SET current_version_id = $1 WHERE id = $2`, [v, wf]);
    try {
      const tasks = await taskFor(await makeReport(employee));
      expect(tasks[0].assignee_user_id).toBe(manager);
      expect(tasks[0].expires_at).not.toBeNull();
    } finally {
      await h.admin.query(`UPDATE approval_workflow SET active = false WHERE id = $1`, [wf]);
    }
  });

  describe('migrations 0059 and 0060, for a tenant that existed before them', () => {
    /** One migration's per-tenant block, run again as it ran at deploy. */
    const runBlock = async (dir: string) => {
      const sql = readFileSync(join(process.cwd(), 'prisma/migrations', dir, 'migration.sql'), 'utf8');
      await h.admin.query(sql.slice(sql.indexOf('DO $$')));
    };
    /** Both, in deploy order: 0059 writes the flow, 0060 gives it the d59 fallback. */
    const runBackfill = async () => {
      await runBlock('0059_default_approval_workflow');
      await runBlock('0060_default_flow_any_admin');
    };
    const defaults = async () =>
      (
        await h.admin.query(
          `SELECT w.id, w.current_version_id, w.created_by, v.graph
             FROM approval_workflow w JOIN approval_workflow_version v ON v.id = w.current_version_id
            WHERE w.organization_id = $1 AND w.key = 'expense-report-default'`,
          [h.orgId],
        )
      ).rows;

    it('writes the same workflow for a tenant that has none', async () => {
      const before = await defaults();
      await h.admin.query(`DELETE FROM approval_instance WHERE organization_id = $1`, [h.orgId]);
      await h.admin.query(
        `DELETE FROM approval_workflow WHERE organization_id = $1 AND key = 'expense-report-default'`,
        [h.orgId],
      );
      await runBackfill();
      const after = await defaults();
      expect(after).toHaveLength(1);
      expect(after[0].id).not.toBe(before[0].id);
      expect(after[0].created_by).toBe(founder);
      // The SQL's graph is the provisioning code's graph.
      expect(after[0].graph).toEqual(before[0].graph);
    });

    it('leaves a tenant that has one alone', async () => {
      const before = await defaults();
      await runBackfill();
      expect(await defaults()).toEqual(before);
    });

    it("0059 alone names the first admin, and 0060 turns that into the Admin role", async () => {
      await h.admin.query(`DELETE FROM approval_instance WHERE organization_id = $1`, [h.orgId]);
      await h.admin.query(
        `DELETE FROM approval_workflow WHERE organization_id = $1 AND key = 'expense-report-default'`,
        [h.orgId],
      );
      await runBlock('0059_default_approval_workflow');
      const managerStep = async () =>
        (await defaults())[0].graph.nodes.find((n: any) => n.id === 'manager').approver;
      expect(await managerStep()).toEqual({
        kind: 'manager',
        fallback: { kind: 'user', userId: founder },
      });
      await runBlock('0060_default_flow_any_admin');
      expect(await managerStep()).toEqual({
        kind: 'manager',
        fallback: { kind: 'role', roleId: SYSTEM_ROLE_IDS.admin },
      });
    });

    it('0060 leaves a default flow an admin has changed alone', async () => {
      const [wf] = await defaults();
      const edited = {
        ...wf.graph,
        nodes: wf.graph.nodes.map((n: any) =>
          n.id === 'manager'
            ? { ...n, approver: { kind: 'manager', fallback: { kind: 'user', userId: secondAdmin } } }
            : n,
        ),
      };
      const v2 = (
        await h.admin.query(
          `INSERT INTO approval_workflow_version (organization_id, workflow_id, version, match_condition, graph, status)
           VALUES ($1, $2, 2, '{"always": true}', $3::jsonb, 'PUBLISHED') RETURNING id`,
          [h.orgId, wf.id, JSON.stringify(edited)],
        )
      ).rows[0].id;
      await h.admin.query(`UPDATE approval_workflow SET current_version_id = $1 WHERE id = $2`, [v2, wf.id]);
      await runBlock('0060_default_flow_any_admin');
      expect((await defaults())[0].graph).toEqual(edited);
    });
  });
});
