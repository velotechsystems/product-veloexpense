// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the harness reads rows untyped. */
import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../../../server/__test-helpers__/tenantHarness';

/**
 * VeloExpense (w4-00b): the plumbing the port changed in ExpenseOS's engine, against a real
 * Postgres. ExpenseOS's own suites (engine.db / noManagerFallback.db) cover its rules; these
 * cover what VeloExpense put underneath them, each of which a suite written for ExpenseOS's
 * tables could not reach:
 *
 *   · the tenant: a workflow published by another organization never governs this one's
 *     reports (RLS, since the engine names no organization);
 *   · the policy currency is `organization.policy_currency_code`, not a system flag;
 *   · `hasPolicyViolation` reads `policy_violation`;
 *   · delegation reads VeloExpense's `delegation` table — inclusive dates, `revoked_at`;
 *   · the expiry sweep keeps ExpenseOS's "one task's failure does not stop the rest" inside
 *     a single tenant transaction, by savepoint.
 *
 * Gated on DATABASE_URL; the hermetic CI run skips it.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const ONE_APPROVAL = {
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

describe.skipIf(!process.env.DATABASE_URL)('approval engine on VeloExpense tables (integration)', () => {
  let h: TenantHarness;
  let engine: typeof import('./engine');
  /** Run engine code the way every caller will: inside the tenant's transaction. */
  const inTx = <T>(fn: (tx: any) => Promise<T>): Promise<T> => h.db.$transaction(fn);
  let n = 0;

  const makeUser = async (over: Record<string, unknown> = {}): Promise<string> =>
    (
      await h.db.user.create({
        // w4-10a: a person names their role (0068); Employee unless the case says otherwise.
        data: { email: `velo-${++n}@engine.example`, name: `Person ${n}`, roleId: SYSTEM_ROLE_IDS.employee, ...over },
        select: { id: true },
      })
    ).id;

  const makeReport = async (submitterId: string, currencyId = 'CAD', totalMinor = 10_000n) =>
    (
      await h.db.expenseReport.create({
        data: { title: 'Engine report', submitterId, currencyId, status: 'SUBMITTED', totalMinor },
        select: { id: true },
      })
    ).id as string;

  const publish = async (
    key: string,
    opts: { matchCondition?: unknown; isDefault?: boolean; priority?: number; graph?: unknown } = {},
  ): Promise<string> => {
    const wf = await h.db.approvalWorkflow.create({
      data: {
        key,
        name: key,
        subjectType: 'EXPENSE_REPORT',
        isDefault: opts.isDefault ?? false,
        priority: opts.priority ?? 0,
      },
      select: { id: true },
    });
    const v = await h.db.approvalWorkflowVersion.create({
      data: {
        workflowId: wf.id,
        version: 1,
        matchCondition: opts.matchCondition ?? { all: [] },
        graph: opts.graph ?? ONE_APPROVAL,
        status: 'PUBLISHED',
      },
      select: { id: true },
    });
    await h.db.approvalWorkflow.update({ where: { id: wf.id }, data: { currentVersionId: v.id } });
    return v.id as string;
  };

  const versionOf = async (instanceId: string | null) =>
    (
      await h.db.approvalInstance.findUniqueOrThrow({
        where: { id: instanceId },
        select: { workflowVersionId: true },
      })
    ).workflowVersionId;

  beforeAll(async () => {
    h = await createTenantHarness({ slug: 'engine-velo', name: 'Engine Velo' });
    engine = await import('./engine');
  });

  beforeEach(async () => {
    for (const t of ['approval_instance_task', 'approval_instance', 'approval_workflow', 'delegation', 'policy_violation', 'fx_rate']) {
      await h.admin.query(`DELETE FROM ${t} WHERE organization_id = $1`, [h.orgId]);
    }
    await h.admin.query(`UPDATE organization SET policy_currency_code = 'CAD' WHERE id = $1`, [h.orgId]);
  });

  afterAll(async () => {
    await h?.end();
  });

  describe('the tenant', () => {
    it("never routes a report through another organization's workflow", async () => {
      const { createOrganization } = await import('@/lib/onboarding/provision');
      const other = (
        await createOrganization({
          name: 'Other Org',
          slug: 'engine-velo-other',
          adminEmail: 'founder@engine-velo-other.example',
          adminName: 'Founder',
        })
      ).organizationId;
      // A published catch-all in the OTHER tenant, written past RLS as the admin connection —
      // the shape that WOULD govern this report if the engine could see it.
      const wf = (
        await h.admin.query(
          `INSERT INTO approval_workflow (organization_id, key, name, subject_type, is_default)
           VALUES ($1, 'theirs', 'Theirs', 'EXPENSE_REPORT', true) RETURNING id`,
          [other],
        )
      ).rows[0].id as string;
      const v = (
        await h.admin.query(
          `INSERT INTO approval_workflow_version (organization_id, workflow_id, version, match_condition, graph, status)
           VALUES ($1, $2, 1, '{"all": []}'::jsonb, $3::jsonb, 'PUBLISHED') RETURNING id`,
          [other, wf, JSON.stringify(ONE_APPROVAL)],
        )
      ).rows[0].id as string;
      await h.admin.query(`UPDATE approval_workflow SET current_version_id = $1 WHERE id = $2`, [v, wf]);
      const submitter = await makeUser();
      const reportId = await makeReport(submitter);
      const started = await inTx((tx) => engine.startInstance(tx, 'EXPENSE_REPORT', reportId));
      expect(started).toMatchObject({ instanceId: null, status: 'NO_WORKFLOW' });
    });
  });

  describe('the policy currency', () => {
    /** Over 14,000 minor in the policy currency → `big`; otherwise the catch-all. */
    const setUp = async () => {
      const big = await publish('big', {
        priority: 10,
        matchCondition: { all: [{ field: 'amount', op: 'gte', value: 14_000 }] },
      });
      const fallback = await publish('fallback', { isDefault: true });
      // 1 USD = 1.5 CAD.
      await h.admin.query(
        `INSERT INTO fx_rate (organization_id, base, quote, rate) VALUES ($1, 'USD', 'CAD', 1.5)`,
        [h.orgId],
      );
      const manager = await makeUser();
      const submitter = await makeUser({ managerId: manager });
      return { big, fallback, reportId: await makeReport(submitter, 'USD', 10_000n) };
    };

    it("converts the report total into the organization's policy currency", async () => {
      const { big, reportId } = await setUp();
      // USD 100.00 is CAD 150.00: over the 140.00 line.
      const started = await inTx((tx) => engine.startInstance(tx, 'EXPENSE_REPORT', reportId));
      expect(await versionOf(started.instanceId)).toBe(big);
    });

    it('reads the column, not a default: a USD policy currency leaves the total as it is', async () => {
      const { fallback, reportId } = await setUp();
      await h.admin.query(`UPDATE organization SET policy_currency_code = 'USD' WHERE id = $1`, [h.orgId]);
      const started = await inTx((tx) => engine.startInstance(tx, 'EXPENSE_REPORT', reportId));
      expect(await versionOf(started.instanceId)).toBe(fallback);
    });
  });

  describe('policy violations', () => {
    it('routes on a finding in policy_violation, and not without one', async () => {
      const flagged = await publish('flagged', {
        priority: 10,
        matchCondition: { all: [{ field: 'hasPolicyViolation', op: 'eq', value: 'true' }] },
      });
      const clean = await publish('clean', { isDefault: true });
      const manager = await makeUser();
      const submitter = await makeUser({ managerId: manager });

      const withFinding = await makeReport(submitter);
      await h.admin.query(
        `INSERT INTO policy_violation (organization_id, report_id, rule_code, severity, message)
         VALUES ($1, $2, 'PER_TRANSACTION_LIMIT', 'WARNING', 'Over the limit')`,
        [h.orgId, withFinding],
      );
      const a = await inTx((tx) => engine.startInstance(tx, 'EXPENSE_REPORT', withFinding));
      expect(await versionOf(a.instanceId)).toBe(flagged);

      const without = await makeReport(submitter);
      const b = await inTx((tx) => engine.startInstance(tx, 'EXPENSE_REPORT', without));
      expect(await versionOf(b.instanceId)).toBe(clean);
    });
  });

  describe('delegation', () => {
    const delegate = async (
      from: string,
      to: string,
      opts: { startsOn?: string; endsOn?: string | null; scope?: string; revoked?: boolean } = {},
    ) =>
      h.admin.query(
        `INSERT INTO delegation (organization_id, from_user_id, to_user_id, starts_on, ends_on, scope,
                                 created_by_id, revoked_at, revoked_by_id)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $2, $7, $8)`,
        [
          h.orgId,
          from,
          to,
          opts.startsOn ?? '2020-01-01',
          opts.endsOn ?? null,
          opts.scope ?? 'ALL',
          opts.revoked ? new Date() : null,
          opts.revoked ? from : null,
        ],
      );

    const assigneeFor = async () => {
      await publish('deleg', { isDefault: true });
      const manager = await makeUser();
      const standIn = await makeUser();
      const submitter = await makeUser({ managerId: manager });
      return { manager, standIn, submitter };
    };

    const startAndRead = async (submitter: string) => {
      const reportId = await makeReport(submitter);
      const started = await inTx((tx) => engine.startInstance(tx, 'EXPENSE_REPORT', reportId));
      return (
        await h.db.approvalTask.findFirstOrThrow({
          where: { instanceId: started.instanceId },
          select: { id: true, assigneeUserId: true },
        })
      ) as { id: string; assigneeUserId: string | null };
    };

    it('hands the task to a live REPORTS delegation', async () => {
      const { manager, standIn, submitter } = await assigneeFor();
      await delegate(manager, standIn, { scope: 'REPORTS' });
      expect((await startAndRead(submitter)).assigneeUserId).toBe(standIn);
    });

    it('ignores a revoked delegation', async () => {
      const { manager, standIn, submitter } = await assigneeFor();
      await delegate(manager, standIn, { revoked: true });
      expect((await startAndRead(submitter)).assigneeUserId).toBe(manager);
    });

    /** VeloExpense: today in the tenant's working timezone — the day the engine compares. */
    const tenantToday = async () =>
      (
        await h.admin.query(
          `SELECT (now() AT TIME ZONE default_timezone)::date::text AS d FROM organization WHERE id = $1`,
          [h.orgId],
        )
      ).rows[0].d as string;

    it('counts the last day as covered (inclusive), and not the day after', async () => {
      const { manager, standIn, submitter } = await assigneeFor();
      // VeloExpense: the tenant's today, not the test database's `current_date` — which is
      // the server's zone, and was a day behind UTC every evening on a Toronto machine.
      const today = await tenantToday();
      await delegate(manager, standIn, { endsOn: today });
      expect((await startAndRead(submitter)).assigneeUserId).toBe(standIn);

      await h.admin.query(`UPDATE delegation SET ends_on = $2::date - 1 WHERE organization_id = $1`, [
        h.orgId,
        today,
      ]);
      expect((await startAndRead(submitter)).assigneeUserId).toBe(manager);
    });

    it("reads today in the tenant's working timezone, not UTC or the server's", async () => {
      /**
       * VeloExpense. Two zones 26 hours apart are ALWAYS on different calendar days, so this
       * holds at any hour: a delegation ending on today's date in UTC−12 covers a tenant
       * working in UTC−12, and has already ended for one working in UTC+14.
       */
      const { manager, standIn, submitter } = await assigneeFor();
      const original = (
        await h.admin.query(`SELECT default_timezone FROM organization WHERE id = $1`, [h.orgId])
      ).rows[0].default_timezone as string;
      try {
        await h.admin.query(`UPDATE organization SET default_timezone = 'Etc/GMT+12' WHERE id = $1`, [h.orgId]);
        await delegate(manager, standIn, { endsOn: await tenantToday() });
        expect((await startAndRead(submitter)).assigneeUserId).toBe(standIn);

        await h.admin.query(`UPDATE organization SET default_timezone = 'Pacific/Kiritimati' WHERE id = $1`, [
          h.orgId,
        ]);
        expect((await startAndRead(submitter)).assigneeUserId).toBe(manager);
      } finally {
        await h.admin.query(`UPDATE organization SET default_timezone = $2 WHERE id = $1`, [h.orgId, original]);
      }
    });

    it('lets the stand-in decide a task still assigned to the person they cover', async () => {
      const { manager, standIn, submitter } = await assigneeFor();
      const task = await startAndRead(submitter); // assigned before the delegation existed
      expect(task.assigneeUserId).toBe(manager);
      await delegate(manager, standIn);
      expect(await inTx((tx) => engine.canDecide(tx, task.id, standIn, false))).toBe(true);
    });
  });

  describe('the expiry sweep', () => {
    it('expires every due task even when one of them fails, in one tenant transaction', async () => {
      await publish('sweep', {
        isDefault: true,
        graph: {
          ...ONE_APPROVAL,
          nodes: ONE_APPROVAL.nodes.map((nd) =>
            nd.id === 'approve-1' ? { ...nd, onExpire: 'REJECT' } : nd,
          ),
        },
      });
      const manager = await makeUser();
      const submitter = await makeUser({ managerId: manager });
      const broken = await startAndPark(submitter);
      const fine = await startAndPark(submitter);
      // Both overdue; the broken one first, so its failure comes before the other's turn.
      await h.admin.query(
        `UPDATE approval_instance_task SET expires_at = now() - interval '2 days' WHERE id = $1`,
        [broken.taskId],
      );
      await h.admin.query(
        `UPDATE approval_instance_task SET expires_at = now() - interval '1 day' WHERE id = $1`,
        [fine.taskId],
      );
      // A DATABASE error part-way through the broken one: its task is already claimed
      // EXPIRED when writing the outcome to its report fails. In Postgres that aborts the
      // whole transaction, which is what the savepoint exists to contain — a JavaScript
      // throw before any write would pass with or without it.
      await h.admin.query(`
        CREATE OR REPLACE FUNCTION w4_test_refuse_report_update() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'w4 test: refused'; END $$ LANGUAGE plpgsql`);
      await h.admin.query(`
        CREATE TRIGGER w4_test_refuse_report_update BEFORE UPDATE ON expense_report
        FOR EACH ROW WHEN (OLD.id = '${broken.reportId}'::uuid)
        EXECUTE FUNCTION w4_test_refuse_report_update()`);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let out: Awaited<ReturnType<typeof engine.sweepExpiredTasks>>;
      try {
        out = await inTx((tx) => engine.sweepExpiredTasks(tx));
      } finally {
        warn.mockRestore();
        await h.admin.query(`DROP TRIGGER IF EXISTS w4_test_refuse_report_update ON expense_report`);
        await h.admin.query(`DROP FUNCTION IF EXISTS w4_test_refuse_report_update()`);
      }

      expect(out).toEqual([
        expect.objectContaining({ outcome: 'REJECTED', subjectId: fine.reportId }),
      ]);
      const rows = (
        await h.admin.query(
          `SELECT id, status FROM approval_instance_task WHERE id = ANY($1::uuid[])`,
          [[broken.taskId, fine.taskId]],
        )
      ).rows as { id: string; status: string }[];
      const status = new Map(rows.map((r) => [r.id, r.status]));
      // The failed task rolled back to where it was; the other committed with the sweep.
      expect(status.get(broken.taskId)).toBe('PENDING');
      expect(status.get(fine.taskId)).toBe('EXPIRED');
      const report = (
        await h.admin.query(`SELECT status FROM expense_report WHERE id = $1`, [fine.reportId])
      ).rows[0];
      expect(report.status).toBe('REJECTED');
    });

    async function startAndPark(submitter: string) {
      const reportId = await makeReport(submitter);
      const started = await inTx((tx) => engine.startInstance(tx, 'EXPENSE_REPORT', reportId));
      const task = await h.db.approvalTask.findFirstOrThrow({
        where: { instanceId: started.instanceId },
        select: { id: true },
      });
      return { reportId, instanceId: started.instanceId as string, taskId: task.id as string };
    }
  });

  // w6-00: travel requests route through the engine now; ExpenseOS's travel cases are in
  // engine.db.test.ts ('a travel request'), including the one that refuses a missing trip.
});
