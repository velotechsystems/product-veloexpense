// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the harness reads rows untyped. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../../../server/__test-helpers__/tenantHarness';

/**
 * VeloExpense (w4-00c): the approval sweep, and what the cutover leaves it to do, against a
 * real Postgres and ExpenseOS's engine — as the worker runs it, one tenant, statement at a time.
 *
 *   · a lapsed deadline decides a report through VeloExpense's outcome — the history row (no
 *     person: `context.system`), the audit row as the sweep, the budgets, and on APPROVE the
 *     ledger post — and the submitter is told (TASK_EXPIRED);
 *   · migration 0062 will not drop the ladder under a report still waiting on it (d61);
 *   · a flow that decides on submit (no approval on its path) is recorded as the flow's
 *     decision, with the ledger post queued;
 *   · migrations 0061/0062: a history row names a person or says what made it, and an approve
 *     link names an engine task.
 *
 * Gated on DATABASE_URL; the hermetic CI run skips it.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

describe.skipIf(!process.env.DATABASE_URL)('approval.sweepExpired (integration)', () => {
  let h: TenantHarness;
  let founder: string;
  let manager: string;
  let employee: string;
  let categoryId: string;
  let sweep: () => Promise<void>;
  let lifecycle: typeof import('@/lib/expenses/lifecycle');
  let withTenantTx: typeof import('../../../test/support/tenant-tx').withTenantTx;
  let publishFlow: typeof import('../../../test/support/tenant-tx').publishFlow;

  /** A dated, coded report, as the employee, still a DRAFT. */
  const draft = async (title: string, amountMinor = 4_200) =>
    withTenantTx(h.orgId, async (_tx, db) => {
      const r = await db.expenseReport.create({
        data: { title, submitterId: employee, currencyId: 'CAD', status: 'DRAFT' },
        select: { id: true },
      });
      const e = await db.expense.create({
        data: {
          reportId: r.id,
          ownerId: employee,
          date: new Date(),
          amountMinor: BigInt(amountMinor),
          currencyId: 'CAD',
          merchant: 'Cafe',
        },
        select: { id: true },
      });
      await db.expenseLineItem.create({
        data: { expenseId: e.id, categoryId, amountMinor: BigInt(amountMinor) },
      });
      await db.expenseReport.update({
        where: { id: r.id },
        data: { totalMinor: BigInt(amountMinor) },
      });
      return r.id as string;
    });

  const submit = (reportId: string) =>
    withTenantTx(h.orgId, (tx) => lifecycle.submitReport(tx, reportId, employee));

  const row = async (sql: string, params: unknown[]) => (await h.admin.query(sql, params)).rows;

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'approval-sweep',
      name: 'Approval Sweep',
      people: [
        { email: 'manager@approval-sweep.example', name: 'Manager' },
        { email: 'employee@approval-sweep.example', name: 'Employee' },
      ],
    });
    [founder, manager, employee] = h.people.map((p) => p.id);
    await h.admin.query(`UPDATE app_user SET manager_id = $1 WHERE id = $2`, [manager, employee]);
    categoryId = (
      await h.admin.query(
        `INSERT INTO expense_category (organization_id, code, label)
         VALUES ($1, 'sweep-meals', '{"en":"Meals"}') RETURNING id`,
        [h.orgId],
      )
    ).rows[0].id;
    lifecycle = await import('@/lib/expenses/lifecycle');
    ({ withTenantTx, publishFlow } = await import('../../../test/support/tenant-tx'));
    const { handleApprovalSweep } = await import('./approval-sweep');
    const { withTenantStatements } = await import('@/lib/db/prisma');
    // As the worker runs it — the job's tenant, statement at a time.
    sweep = () =>
      withTenantStatements(h.orgId, () => handleApprovalSweep({ trigger: 'manual' } as never));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(async () => {
    await h?.end();
  });

  describe('a lapsed deadline', () => {
    it('rejects the report as the sweep, with its outcome, and tells the submitter', async () => {
      const id = await draft('Lapsed');
      await submit(id);
      // The default flow sets no deadline (d56); one an admin gave a step has passed.
      await h.admin.query(
        `UPDATE approval_instance_task t SET expires_at = now() - interval '1 hour'
           FROM approval_instance i WHERE i.id = t.instance_id AND i.subject_id = $1`,
        [id],
      );
      // At the top of the chain (the manager has no manager), escalation rejects.
      await sweep();

      expect((await row(`SELECT status FROM expense_report WHERE id = $1`, [id]))[0].status).toBe(
        'REJECTED',
      );
      const [event] = await row(
        `SELECT action, actor_id, context FROM expense_report_event
          WHERE report_id = $1 AND action = 'REJECT'`,
        [id],
      );
      expect(event).toMatchObject({ actor_id: null, context: { system: 'approval.sweepExpired' } });
      const [audit] = await row(
        `SELECT actor_id, actor_name, actor_role FROM audit_entry
          WHERE entity_id = $1 AND action = 'REPORT_REJECTED'`,
        [id],
      );
      expect(audit).toMatchObject({
        actor_id: null,
        actor_name: 'system:approval.sweepExpired',
        actor_role: 'SYSTEM',
      });
      const told = await row(
        `SELECT n.recipient_id FROM notification n JOIN activity a ON a.id = n.activity_id
          WHERE a.subject_id = $1 AND a.event_type = 'TASK_EXPIRED'`,
        [id],
      );
      expect(told.map((r) => r.recipient_id)).toEqual([employee]);
    });

    it('approves under onExpire APPROVE, and queues the ledger post on the transition', async () => {
      const wf = await publishFlow(h.orgId, 'expire-approves', {
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'a',
            type: 'approval',
            approver: { kind: 'manager' },
            ttlBusinessDays: 1,
            onExpire: 'APPROVE',
          },
          { id: 'done', type: 'approved' },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'a' },
          { id: 'e2', source: 'a', target: 'done' },
        ],
      });
      try {
        const id = await draft('Auto on expiry');
        await submit(id);
        await h.admin.query(
          `UPDATE approval_instance_task t SET expires_at = now() - interval '1 hour'
             FROM approval_instance i WHERE i.id = t.instance_id AND i.subject_id = $1`,
          [id],
        );
        await sweep();
        expect((await row(`SELECT status FROM expense_report WHERE id = $1`, [id]))[0].status).toBe(
          'APPROVED',
        );
        expect(await row(`SELECT 1 FROM integration_post WHERE report_id = $1`, [id])).toHaveLength(1);
      } finally {
        await h.admin.query(`UPDATE approval_workflow SET active = false WHERE id = $1`, [wf]);
      }
    });

    it('leaves a task with no deadline alone', async () => {
      const id = await draft('No deadline');
      await submit(id);
      await sweep();
      expect((await row(`SELECT status FROM expense_report WHERE id = $1`, [id]))[0].status).toBe(
        'SUBMITTED',
      );
    });
  });

  describe('migration 0062, which drops the ladder', () => {
    // d61. The cutover's recall (d52) put every report the ladder left SUBMITTED back to DRAFT;
    // one still SUBMITTED with no approval instance is a tenant the sweep never reached, and
    // dropping the ladder under it would strand it. The migration refuses, naming the tenant.
    it('refuses while a report is still SUBMITTED with no approval instance, naming the tenant', async () => {
      const id = await draft('Stranded on the ladder');
      await h.admin.query(
        `UPDATE expense_report SET status = 'SUBMITTED', submitted_at = now() WHERE id = $1`,
        [id],
      );
      try {
        const { readFileSync } = await import('node:fs');
        const sql = readFileSync(
          'prisma/migrations/0062_drop_approval_ladder/migration.sql',
          'utf8',
        );
        const guard = sql.slice(sql.indexOf('DO $$'), sql.indexOf('END $$;') + 'END $$;'.length);
        await expect(h.admin.query(guard)).rejects.toThrow(
          /tenant approval-sweep still has 1 report\(s\) SUBMITTED on the approval ladder/,
        );
      } finally {
        await h.admin.query(`UPDATE expense_report SET status = 'DRAFT' WHERE id = $1`, [id]);
      }
    });
  });

  describe('a flow that decides on submit', () => {
    it('is recorded as the flow’s decision, with the ledger post queued', async () => {
      // No approval on the path: Start → Approved, more specific than the default.
      const wf = await publishFlow(h.orgId, 'straight-through', {
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'done', type: 'approved' },
        ],
        edges: [{ id: 'e1', source: 'start', target: 'done' }],
      });
      try {
        const id = await draft('Straight through');
        const res = await submit(id);
        expect(res.report.status).toBe('APPROVED');
        expect(res.approval.status).toBe('APPROVED');
        const [event] = await row(
          `SELECT actor_id, context FROM expense_report_event WHERE report_id = $1 AND action = 'APPROVE'`,
          [id],
        );
        expect(event).toMatchObject({ actor_id: null, context: { system: 'approval.workflow' } });
        expect(await row(`SELECT 1 FROM integration_post WHERE report_id = $1`, [id])).toHaveLength(1);
      } finally {
        await h.admin.query(`UPDATE approval_workflow SET active = false WHERE id = $1`, [wf]);
      }
    });
  });

  describe('migrations 0061 and 0062', () => {
    it('refuses a history row that names nobody and no system', async () => {
      const id = await draft('Nobody');
      await expect(
        h.admin.query(
          `INSERT INTO expense_report_event (organization_id, report_id, action, from_status, to_status, actor_id, context)
           VALUES ($1, $2, 'SUBMIT', 'DRAFT', 'SUBMITTED', NULL, '{}')`,
          [h.orgId, id],
        ),
      ).rejects.toThrow(/expense_report_event_actor_or_system/);
    });

    it('refuses an approve link that names no engine task (0062: the ladder column is gone)', async () => {
      await expect(
        h.admin.query(
          `INSERT INTO action_token (organization_id, token_hash, instance_task_id, action, recipient_id, expires_at)
           VALUES ($1, repeat('a', 64), NULL, 'APPROVE', $2, now() + interval '1 day')`,
          [h.orgId, founder],
        ),
      ).rejects.toThrow(/instance_task_id/);
    });
  });
});
