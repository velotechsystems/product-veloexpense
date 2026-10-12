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
 *   · a report the deploy left SUBMITTED on the retired ladder goes back to DRAFT with a note
 *     (d52), its ladder run cancelled, once — a second sweep finds nothing;
 *   · a flow that decides on submit (no approval on its path) is recorded as the flow's
 *     decision, with the ledger post queued;
 *   · migration 0061: a history row names a person or says what made it, and an approve link
 *     names an engine task.
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

  describe('the cutover recall (d52)', () => {
    /** A report as the ladder left it: SUBMITTED, no instance, a running ladder run. */
    const ladderLeftover = async (title: string) => {
      const id = await draft(title);
      await h.admin.query(
        `UPDATE expense_report SET status = 'SUBMITTED', submitted_at = now() WHERE id = $1`,
        [id],
      );
      const run = (
        await h.admin.query(
          `INSERT INTO approval_request (organization_id, report_id, policy_snapshot, status, total_steps,
                                         subject_total_minor, subject_currency_code, opened_by_id)
           VALUES ($1, $2, '[]'::jsonb, 'RUNNING', 1, 4200, 'CAD', $3) RETURNING id`,
          [h.orgId, id, employee],
        )
      ).rows[0].id;
      await h.admin.query(
        `INSERT INTO approval_task (organization_id, request_id, step, assignee_id)
         VALUES ($1, $2, 1, $3)`,
        [h.orgId, run, manager],
      );
      return { id, run };
    };

    it('puts it back to DRAFT with a note, as the system, and cancels its ladder run', async () => {
      const { id, run } = await ladderLeftover('Ladder leftover');
      await sweep();

      const [report] = await row(
        `SELECT status, submitted_at, approval_instance_id FROM expense_report WHERE id = $1`,
        [id],
      );
      expect(report).toMatchObject({ status: 'DRAFT', submitted_at: null, approval_instance_id: null });
      const [event] = await row(
        `SELECT actor_id, note, context FROM expense_report_event WHERE report_id = $1 AND action = 'RECALL'`,
        [id],
      );
      expect(event).toMatchObject({
        actor_id: null,
        note: lifecycle.LADDER_RECALL_NOTE,
        context: { system: 'approval.cutover', cancelledTasks: 1 },
      });
      expect((await row(`SELECT status FROM approval_request WHERE id = $1`, [run]))[0].status).toBe(
        'CANCELLED',
      );
      const [audit] = await row(
        `SELECT actor_name FROM audit_entry WHERE entity_id = $1 AND action = 'REPORT_RECALLED'`,
        [id],
      );
      expect(audit.actor_name).toBe('system:approval.cutover');
      // The submitter submits it again, on the engine.
      await submit(id);
      expect((await row(`SELECT status FROM expense_report WHERE id = $1`, [id]))[0].status).toBe(
        'SUBMITTED',
      );
    });

    it('does it once — a second sweep finds nothing, and an engine submission is never touched', async () => {
      const { id } = await ladderLeftover('Once only');
      const onEngine = await draft('On the engine');
      await submit(onEngine);
      await sweep();
      await sweep();
      const recalls = await row(
        `SELECT count(*)::int AS n FROM expense_report_event WHERE report_id = $1 AND action = 'RECALL'`,
        [id],
      );
      expect(recalls[0].n).toBe(1);
      expect(
        (await row(`SELECT status FROM expense_report WHERE id = $1`, [onEngine]))[0].status,
      ).toBe('SUBMITTED');
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

  describe('migration 0061', () => {
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

    it('refuses an approve link that names no task, or both kinds', async () => {
      const insert = (task: string | null, instanceTask: string | null) =>
        h.admin.query(
          `INSERT INTO action_token (organization_id, token_hash, task_id, instance_task_id, action, recipient_id, expires_at)
           VALUES ($1, repeat('a', 64), $2, $3, 'APPROVE', $4, now() + interval '1 day')`,
          [h.orgId, task, instanceTask, founder],
        );
      await expect(insert(null, null)).rejects.toThrow(/action_token_one_task/);
    });
  });
});
