// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * VeloExpense: ExpenseOS's `expenseApprovals.db.test.ts`, the cases for the procedures ported so
 * far — "expenses + chaseReceipts" (w2-06), and the submitter's `expenses.submit` /
 * `expenses.recall` cases (w2-11), which ExpenseOS keeps here because they drive its approval
 * engine. And since w2-02a the approver's procedures — `decide`, `reassign`, `returnForEdit`,
 * `setFxOverride` — against VeloExpense's real engine, which is where the cases of ExpenseOS's
 * mocked `expenseApprovals.test.ts` about the engine's own work (the audit label, the ledger
 * hand-off, the notification) are proven, with the thread showing each reason (d37). Since
 * w4-00c all of it runs on ExpenseOS's approval engine, the tenant's default flow (d54/d59):
 * the submitter's manager, or the administrators when there is none. The approver's report,
 * decideBulk, myDecided and myTeam came with the inbox (w4-05/w4-07); ExpenseOS's reimburse case
 * is not ported (d71).
 *
 * The cases are ExpenseOS's; the harness is VeloExpense's (`createTenantHarness`: the suite's own
 * tenant and people, every call under RLS). Adaptations, each marked:
 *   · a currency is keyed by its code, and the fixture receipt is STORED under the tenant's
 *     prefix (w2-09);
 *   · activity is read with SQL — VeloExpense's `activity` table has no Prisma model — and its
 *     type column is `event_type`;
 *   · the cases after ExpenseOS's cover what VeloExpense adds: a PENDING receipt is not a
 *     receipt, an expense with no date still pages, and the submitter's bell says who asked.
 */

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const REIMBURSER_PERMS = [P.expense.report.reimburse] as const;
/** The submitter's grants, as ExpenseOS's `OWNER_PERMS`. */
const OWNER_PERMS = [
  P.expense.report.readOwn,
  P.expense.report.createOwn,
  P.expense.report.updateOwn,
] as const;

describe.skipIf(!process.env.DATABASE_URL)('expense approvals (integration)', () => {
  let h: TenantHarness;
  let db: any;
  let ownerId: string;
  let strangerId: string;
  let router: unknown;
  const approvals = (perms: readonly string[], userId: string) =>
    h.makeCaller(perms, userId, router);

  /** VeloExpense: RECEIPT_REMINDER activity on a report, read as the superuser. */
  const reminders = async (reportId: string) =>
    (
      await h.admin.query(
        `SELECT id, actor_id, payload FROM activity
          WHERE subject_id = $1 AND event_type = 'RECEIPT_REMINDER'
          ORDER BY occurred_at DESC, id DESC`,
        [reportId],
      )
    ).rows as {
      id: string;
      actor_id: string | null;
      payload: Record<string, unknown>;
    }[];

  beforeAll(async () => {
    h = await createTenantHarness({
      slug: 'expense-approvals',
      name: 'Expense Approvals',
      people: [
        { email: 'stranger@expense-approvals.test', name: 'Stranger' },
        // w2-02a: somebody an approval can be handed to, and an AP clerk who holds no task.
        { email: 'deputy@expense-approvals.test', name: 'Deputy' },
        { email: 'clerk@expense-approvals.test', name: 'Clerk' },
      ],
    });
    db = h.db;
    ownerId = h.people[0].id;
    strangerId = h.people[1].id;
    router = (await import('@/server/routers/expenseApprovals')).expenseApprovalsRouter;
  });

  afterAll(async () => {
    // VeloExpense: the next suite truncates the tenants; only the pool is ours to close.
    await h?.end();
  });


  // ── submit / recall, on VeloExpense's lifecycle (w2-11, d23) ──────────
  describe('submit and recall', () => {
    /**
     * VeloExpense: the submitter is the suite's EMPLOYEE, with no manager, so the default flow
     * sends the report to the administrators (d59). ExpenseOS's "submit auto-approves when no
     * EXPENSE_REPORT workflow matches" is refused here instead (d58) — its case below.
     */
    let categoryId: string;
    const owner = () => h.makeCaller(OWNER_PERMS, strangerId);
    const seedReport = async (status = 'DRAFT') =>
      (
        await db.expenseReport.create({
          data: { title: 'Lifecycle fixture', submitterId: strangerId, currencyId: 'CAD', status },
          select: { id: true },
        })
      ).id as string;
    /** VeloExpense: a dated expense with one valued line — VeloExpense refuses an undated
     *  expense at submit (VX4-11), where ExpenseOS's `addValuedExpense` needs no date. */
    const addValuedExpense = async (reportId: string, amountMinor = '2500') => {
      const { id } = await owner().createExpense({ reportId });
      await owner().updateExpense({ expenseId: id, date: new Date(), merchant: 'Cafe' });
      await owner().lineItemCreate({ expenseId: id, categoryId, amountMinor });
      return id as string;
    };
    /** w4-00c: the report's latest approval instance, and how many of its tasks are pending. */
    const runOf = async (reportId: string) =>
      (
        await h.admin.query(
          `SELECT i.status, count(t.id) FILTER (WHERE t.status = 'PENDING')::int AS pending
             FROM approval_instance i LEFT JOIN approval_instance_task t ON t.instance_id = i.id
            WHERE i.subject_id = $1 GROUP BY i.id, i.status, i.started_at
            ORDER BY i.started_at DESC LIMIT 1`,
          [reportId],
        )
      ).rows[0] as { status: string; pending: number } | undefined;

    beforeAll(async () => {
      categoryId = (
        await db.expenseCategory.create({
          data: { label: { en: 'Lifecycle meals' } },
          select: { id: true },
        })
      ).id;
    });

    it('submit refuses a report that totals zero', async () => {
      /**
       * The gap the count check left. `expenseCount === 0` passes the moment ONE blank
       * expense exists, which is all it took: adding an expense and typing nothing enabled
       * Submit at $0.00, and the report went the whole way — EXP-000006 "test 2" sits on
       * DEV at $0.00 with status Approved, so a workflow ran and somebody signed off a
       * claim for nothing (GA readiness report F08 / blocker B10).
       */
      const reportId = await seedReport('DRAFT');
      const { id } = await owner().createExpense({ reportId }); // an expense, but no value
      await expect(owner().submit({ reportId })).rejects.toThrow(/totals zero/i);

      // Give it a value and the same call goes through.
      // VeloExpense: a dated line rather than a hand-set total — VeloExpense's lifecycle
      // refuses a report with no line items, which the hand-set total would leave it.
      await owner().updateExpense({ expenseId: id, date: new Date() });
      await owner().lineItemCreate({ expenseId: id, categoryId, amountMinor: '2500' });
      const res = await owner().submit({ reportId });
      expect(res.report.status).toBe('SUBMITTED');
    });

    it('submit routes to the default workflow', async () => {
      // VeloExpense: ExpenseOS's "submit routes to the seeded amount-tiered workflow", on the
      // tenant's default flow (d54) — a RUNNING instance parked on a pending task, and the
      // report pointing at it.
      const reportId = await seedReport('DRAFT');
      await addValuedExpense(reportId);
      const res = await owner().submit({ reportId });
      expect(res.report.status).toBe('SUBMITTED');
      expect(res.report.approvalInstanceId).toBeTruthy();
      const run = await runOf(reportId);
      expect(run?.status).toBe('RUNNING');
      expect(run?.pending, 'the run must park on an approval task').toBeGreaterThan(0);
    });

    it('VeloExpense: refuses a submit no published workflow governs, where ExpenseOS approves (d58)', async () => {
      const reportId = await seedReport('DRAFT');
      await addValuedExpense(reportId);
      await h.admin.query(`UPDATE approval_workflow SET active = false WHERE organization_id = $1`, [
        h.orgId,
      ]);
      try {
        await expect(owner().submit({ reportId })).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: expect.stringMatching(/No approval workflow applies/),
        });
        expect(await runOf(reportId)).toBeUndefined();
        const row = await h.admin.query(`SELECT status FROM expense_report WHERE id = $1`, [reportId]);
        expect(row.rows[0].status).toBe('DRAFT');
      } finally {
        await h.admin.query(`UPDATE approval_workflow SET active = true WHERE organization_id = $1`, [
          h.orgId,
        ]);
      }
    });

    it('a RETURNED report is editable + resubmittable', async () => {
      // VeloExpense: ExpenseOS's "returnForEdit (admin): SUBMITTED → RETURNED, then editable
      // + resubmittable", from the RETURNED half — the approver's `returnForEdit` arrives with
      // the engine (Wave 4), so the report is returned as a fixture.
      const reportId = await seedReport('SUBMITTED');

      // A SUBMITTED report is not editable by its submitter.
      await expect(owner().createExpense({ reportId })).rejects.toThrow(/not editable/i);

      await h.admin.query(`UPDATE expense_report SET status = 'RETURNED' WHERE id = $1`, [
        reportId,
      ]);

      // Now the submitter can add an expense again (proves RETURNED is editable)…
      const id = await addValuedExpense(reportId);
      expect(id).toBeTruthy();

      // …and resubmit — no longer blocked by the editable-status guard.
      const res = await owner().submit({ reportId });
      expect(res.report.status).toBe('SUBMITTED');
    });

    it('submit is blocked until the report has at least one expense', async () => {
      // A bare report with no expenses can't be submitted.
      const reportId = await seedReport('DRAFT');
      await expect(owner().submit({ reportId })).rejects.toThrow(/expense/i);
      // Add one WITH AN AMOUNT → submit proceeds and routes for approval.
      const id = await addValuedExpense(reportId);
      expect(id).toBeTruthy();
      const res = await owner().submit({ reportId });
      expect(res.report.status).toBe('SUBMITTED');
    });

    it('VeloExpense: refuses an unjustified warning, and lets it through once justified (d34)', async () => {
      const reportId = await seedReport('DRAFT');
      await addValuedExpense(reportId, '9000');
      await h.admin.query(
        // w4-02d: a per-transaction limit as the cutover converts v1's (a line predicate).
        `INSERT INTO policy_rule (organization_id, kind_code, scope, severity, condition, params, message_key, effective_from)
         VALUES ($1, 'PREDICATE_LINE', 'LINE', 'WARNING', '{"all":[{"field":"lineAmount","op":"gt","value":5000}]}',
                 '{}', 'perTransactionLimit', '2000-01-01')`,
        [h.orgId],
      );
      try {
        const refused = await owner()
          .submit({ reportId })
          .catch((e: unknown) => e);
        expect(refused).toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'Report has unresolved policy violations.',
        });
        expect((refused as { cause?: unknown }).cause).toMatchObject({
          counts: { warning: 1, unjustifiedWarning: 1 },
        });

        // A refused submit rolls its own transaction back, findings included — every call
        // here is one tenant transaction — so the finding the submitter justifies is the one
        // the workbench's own `validate` stored, as it does after every edit.
        await owner().validate({ reportId });
        const [warning] = (
          await h.admin.query(`SELECT id FROM policy_violation WHERE report_id = $1`, [reportId])
        ).rows;
        const justified = await owner().justifyViolation({
          violationId: warning.id,
          note: '  Client dinner  ',
        });
        expect(justified).toMatchObject({ resolveNote: 'Client dinner', resolvedBy: strangerId });

        const res = await owner().submit({ reportId });
        expect(res.report.status).toBe('SUBMITTED');
        expect(res.counts).toMatchObject({ warning: 1, unjustifiedWarning: 0 });
      } finally {
        await h.admin.query(
          `DELETE FROM policy_rule WHERE organization_id = $1 AND message_key = 'perTransactionLimit'`,
          [h.orgId],
        );
      }
    });

    it('recall puts a SUBMITTED report back to DRAFT and cancels its run', async () => {
      const reportId = await seedReport('DRAFT');
      await addValuedExpense(reportId);
      await owner().submit({ reportId });
      const res = await owner().recall({ reportId });
      // DRAFT, not RETURNED — see the procedure.
      expect(res).toEqual({ id: reportId, status: 'DRAFT' });
      const run = await runOf(reportId);
      expect(run?.status).toBe('CANCELLED');
      expect(run?.pending).toBe(0);
      // Recalling twice is refused: only a SUBMITTED report can be.
      await expect(owner().recall({ reportId })).rejects.toThrow(/submitted/i);
    });
  });


  // ── the approver's actions, on VeloExpense's engine (w2-02a, d36/d37) ──
  describe("the approver's actions", () => {
    /**
     * The submitter is the suite's EMPLOYEE, whose manager here is the founder, so the default
     * flow (w4-00c) assigns each report's approval to the founder. The deputy can be handed it;
     * the clerk holds ExpenseOS's AP clerk grants and no task.
     */
    const ADMIN_PERMS = [P.expense.report.decideAny] as const;
    const AP_CLERK_PERMS = [P.expense.report.readAll, P.expense.report.reimburse] as const;
    const FX_PERMS = [P.expense.report.fxOverride] as const;
    let deputyId: string;
    let clerkId: string;
    let categoryId: string;
    const owner = () => h.makeCaller(OWNER_PERMS, strangerId);
    const comments = async (userId: string, reportId: string) => {
      const { commentsRouter } = await import('@/server/routers/comments');
      return h
        .makeCaller(OWNER_PERMS, userId, commentsRouter)
        .thread({ subjectType: 'EXPENSE_REPORT', subjectId: reportId });
    };
    /** A submitted report, out for approval with the founder. */
    const submitted = async (title: string, amountMinor = '2500', currency = 'CAD') => {
      const r = await owner().create({ title, currency: 'CAD' });
      const { id } = await owner().createExpense({ reportId: r.id });
      await owner().updateExpense({
        expenseId: id,
        date: new Date(),
        merchant: 'Cafe',
        ...(currency !== 'CAD' ? { currencyId: currency } : {}),
      });
      await owner().lineItemCreate({ expenseId: id, categoryId, amountMinor });
      await owner().submit({ reportId: r.id });
      return r.id as string;
    };
    const pendingTaskOn = async (reportId: string) =>
      (
        await h.admin.query(
          `SELECT t.id, t.assignee_user_id AS assignee_id FROM approval_instance_task t
             JOIN approval_instance i ON i.id = t.instance_id
            WHERE i.subject_id = $1 AND t.status = 'PENDING'`,
          [reportId],
        )
      ).rows[0] as { id: string; assignee_id: string } | undefined;
    const lastAudit = async (reportId: string, action: string) =>
      (
        await h.admin.query(
          `SELECT actor_id, details FROM audit_entry
            WHERE entity_id = $1 AND action = $2 ORDER BY sequence DESC LIMIT 1`,
          [reportId, action],
        )
      ).rows[0] as { actor_id: string; details: Record<string, unknown> } | undefined;
    const statusOf = async (reportId: string) =>
      (await h.admin.query(`SELECT status FROM expense_report WHERE id = $1`, [reportId])).rows[0]
        .status as string;
    const bellFor = async (userId: string, eventType: string, reportId: string) =>
      (
        await h.admin.query(
          `SELECT a.payload FROM notification n JOIN activity a ON a.id = n.activity_id
            WHERE n.recipient_id = $1 AND a.event_type = $2 AND a.subject_id = $3`,
          [userId, eventType, reportId],
        )
      ).rows as { payload: Record<string, unknown> }[];

    beforeAll(async () => {
      deputyId = h.people[2].id;
      clerkId = h.people[3].id;
      // w4-00c: the founder manages the submitter, so the default flow assigns them the task.
      await h.admin.query(`UPDATE app_user SET manager_id = $1 WHERE id = $2`, [ownerId, strangerId]);
      categoryId = (
        await db.expenseCategory.create({
          data: { label: { en: 'Approver meals' } },
          select: { id: true },
        })
      ).id;
    });

    it('records the assigned approver’s decision as an ordinary one', async () => {
      // The other half of the label: the approver the flow named decides on the task's
      // own terms, override or not, and the log must not call it an override.
      const id = await submitted('Assignee decides');
      const task = await pendingTaskOn(id);
      expect(task?.assignee_id).toBe(ownerId);
      await approvals(ADMIN_PERMS, ownerId).decide({
        taskId: task?.id as string,
        approve: true,
      });
      expect(await statusOf(id)).toBe('APPROVED');
      expect((await lastAudit(id, 'REPORT_APPROVED'))?.details).toMatchObject({ override: false });
      // ExpenseOS's "pushes an approved report to NetSuite at once": VeloExpense's engine
      // queues the ledger post on the approving transition.
      const queued = await h.admin.query(`SELECT status FROM integration_post WHERE report_id = $1`, [
        id,
      ]);
      expect(queued.rows).toHaveLength(1);
      // ExpenseOS's "notifies on the decision".
      expect(await bellFor(strangerId, 'APPROVED', id)).toHaveLength(1);
    });

    it('refuses an AP clerk a task routed to somebody else, and lets the override through — audited', async () => {
      /**
       * The segregation-of-duties hole, end to end against the real engine and the
       * real audit chain. The outsider manages nobody and is on no workflow; what
       * they hold is exactly what the seeded AP Clerk holds on this surface —
       * `read.all` + `reimburse`. Before this fix `read.all` WAS the admin override,
       * so this call approved the report; with `reimburse` the same person could then
       * pay it, and the audit row read like any manager's approval.
       *
       * VeloExpense: the override reaches the engine only on `decide.any`.
       */
      const id = await submitted('Override matrix');
      const task = await pendingTaskOn(id);
      await expect(
        approvals(AP_CLERK_PERMS, clerkId).decide({ taskId: task?.id as string, approve: true }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        approvals(AP_CLERK_PERMS, clerkId).reassign({
          taskId: task?.id as string,
          toUserId: clerkId,
          note: 'Taking it',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        approvals(AP_CLERK_PERMS, clerkId).returnForEdit({ reportId: id }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await pendingTaskOn(id))?.id, 'still pending, still the founder’s').toBe(task?.id);

      // The same outsider WITH the override decides it — and the row says override.
      await approvals(ADMIN_PERMS, clerkId).decide({
        taskId: task?.id as string,
        approve: true,
      });
      const row = await lastAudit(id, 'REPORT_APPROVED');
      expect(row?.actor_id).toBe(clerkId);
      expect(row?.details).toMatchObject({ override: true });
    });

    it('VeloExpense: shows the reason a report was rejected on its discussion (d37)', async () => {
      const id = await submitted('Rejected with a reason');
      const task = await pendingTaskOn(id);
      await approvals(ADMIN_PERMS, ownerId).decide({
        taskId: task?.id as string,
        approve: false,
        note: 'Hotel is over the city cap.',
      });
      expect(await statusOf(id)).toBe('REJECTED');
      const thread = await comments(strangerId, id);
      expect(thread.items.find((i: { type: string }) => i.type === 'REJECTED')).toMatchObject({
        note: 'Hotel is over the city cap.',
      });
      // …and the approver, who no longer holds a task, still reads it.
      expect((await comments(ownerId, id)).items).toHaveLength(thread.items.length);
    });

    /*
     * w4-05/w4-07 (d71): ExpenseOS's inbox queries, ported with the inbox — the approver's
     * `report`, `myDecided`, `myTeam` and `decideBulk`. VeloExpense: the "team" here is the
     * founder's one report (the submitter); "someone else decides it" is the deputy, after a
     * reassignment, where ExpenseOS routes a large report past the manager with a tiered flow.
     */
    it('report detail: submitter + reimburser can read; a stranger cannot', async () => {
      const reportId = await submitted('Readable detail');
      await expect(approvals(OWNER_PERMS, strangerId).report({ reportId })).resolves.toMatchObject({
        id: reportId,
      });
      await expect(approvals(REIMBURSER_PERMS, clerkId).report({ reportId })).resolves.toMatchObject({
        id: reportId,
      });
      // VeloExpense: the deputy, holding no task and no grant, is the stranger here.
      await expect(approvals([], deputyId).report({ reportId })).rejects.toThrow(/FORBIDDEN/);
    });

    it('decideBulk is resilient: unknown/undecidable tasks are skipped, not thrown', async () => {
      // A random (non-existent) task id is reported as skipped rather than
      // failing the whole batch — the property that separates decideBulk from a
      // naive loop of `decide` (which would throw NOT_FOUND). Approval mechanics
      // themselves ride on decideTask, covered by the single-decide path.
      const bogus = '00000000-0000-7000-8000-000000000000';
      const res = await approvals(ADMIN_PERMS, ownerId).decideBulk({ taskIds: [bogus] });
      expect(res.approved).toEqual([]);
      expect(res.skipped).toEqual([{ taskId: bogus, reason: 'not_found' }]);
    });

    it('VeloExpense: decideBulk approves through the engine, each one marked as bulk', async () => {
      // Each approval is the single decision's path (`decideThroughEngine`): the report's
      // outcome, its audit row — with `bulk: true` — and the ledger post.
      const a = await submitted('Bulk one');
      const b = await submitted('Bulk two');
      const tasks = [(await pendingTaskOn(a))?.id, (await pendingTaskOn(b))?.id] as string[];
      const res = await approvals([], ownerId).decideBulk({ taskIds: tasks });
      expect(res).toEqual({ approved: tasks, skipped: [] });
      for (const id of [a, b]) {
        expect(await statusOf(id)).toBe('APPROVED');
        expect((await lastAudit(id, 'REPORT_APPROVED'))?.details).toMatchObject({ bulk: true, override: false });
      }
      // The clerk holds no task: the same ids again are not pending, and nothing else moves.
      const again = await approvals(AP_CLERK_PERMS, clerkId).decideBulk({ taskIds: tasks });
      expect(again.skipped.map((s: any) => s.reason)).toEqual(['not_pending', 'not_pending']);
    });

    it("shows a manager their report's submission and who holds it", async () => {
      const id = await submitted('With the manager');
      const { items } = await approvals([], ownerId).myTeam();
      const row = items.find((i: any) => i.report.id === id);
      expect(row, 'the manager sees their report').toBeTruthy();
      expect(row?.pendingWith?.id).toBe(ownerId);
      expect(row?.lastDecision).toBeNull();
    });

    it('keeps the report with the manager after someone else decides it', async () => {
      const id = await submitted('Decided by the deputy');
      const task = await pendingTaskOn(id);
      await approvals([], ownerId).reassign({
        taskId: task?.id as string,
        toUserId: deputyId,
        note: 'Covering this week.',
      });
      await approvals([], deputyId).decide({ taskId: task?.id as string, approve: true });

      const { items } = await approvals([], ownerId).myTeam();
      const row = items.find((i: any) => i.report.id === id);
      expect(row, 'a decided report must not vanish from the manager').toBeTruthy();
      expect(row?.pendingWith).toBeNull();
      expect(row?.lastDecision?.decision).toBe('APPROVED');
      expect(row?.lastDecision?.by?.id).toBe(deputyId);

      // ExpenseOS's "lets an approver open a report they already decided": the deputy holds no
      // readAll / reimburse permission, and the "Decided by me" row must still open.
      await expect(approvals([], deputyId).report({ reportId: id })).resolves.toMatchObject({ id });
      // …and it is in the deputy's own history (myDecided).
      const decided = await approvals([], deputyId).myDecided();
      expect(decided.items.find((i: any) => i.report.id === id)).toMatchObject({ decision: 'APPROVED' });
    });

    it('excludes drafts, and shows nothing to someone who manages nobody', async () => {
      const draft = await owner().create({ title: 'Still a draft', currency: 'CAD' });
      const { items } = await approvals([], ownerId).myTeam();
      expect(items.map((i: any) => i.report.id)).not.toContain(draft.id);
      expect((await approvals([], deputyId).myTeam()).items).toHaveLength(0);
    });

    it('grants read to the manager and submitter, but not to an outsider', async () => {
      const id = await submitted('Read access matrix');
      await expect(approvals([], ownerId).report({ reportId: id })).resolves.toMatchObject({ id });
      await expect(approvals([], strangerId).report({ reportId: id })).resolves.toMatchObject({ id });
      await expect(approvals([], clerkId).report({ reportId: id })).rejects.toThrow(/FORBIDDEN/i);
    });

    it('returnForEdit (approver): SUBMITTED → RETURNED with the reason, then resubmittable', async () => {
      const id = await submitted('Returned');
      await approvals([], ownerId).returnForEdit({ reportId: id, note: 'Attach the receipt.' });
      expect(await statusOf(id)).toBe('RETURNED');
      // The run is closed: nothing pending remains in anybody's queue.
      expect(await pendingTaskOn(id)).toBeUndefined();
      expect(await bellFor(strangerId, 'RETURNED', id)).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ note: 'Attach the receipt.' }) }),
      ]);
      const thread = await comments(strangerId, id);
      expect(thread.items.find((i: { type: string }) => i.type === 'RETURNED')?.note).toBe(
        'Attach the receipt.',
      );
      const res = await owner().submit({ reportId: id });
      expect(res.report.status).toBe('SUBMITTED');
    });

    it('returnForEdit rejects a non-SUBMITTED report', async () => {
      const r = await owner().create({ title: 'Draft only', currency: 'CAD' });
      await expect(approvals(ADMIN_PERMS, ownerId).returnForEdit({ reportId: r.id })).rejects.toThrow(
        /submitted/i,
      );
    });

    it('VeloExpense: reassigns with a reason, and both people hear why (d36, d37)', async () => {
      const id = await submitted('Handed on');
      const task = await pendingTaskOn(id);
      await approvals([], ownerId).reassign({
        taskId: task?.id as string,
        toUserId: deputyId,
        note: 'On leave until the 20th.',
      });
      const after = await pendingTaskOn(id);
      expect(after).toMatchObject({ id: task?.id, assignee_id: deputyId });
      // ExpenseOS's "notifies the new assignee"…
      expect(await bellFor(deputyId, 'TASK_ASSIGNED', id)).toHaveLength(1);
      // …and VeloExpense's: the submitter, with whom and why.
      expect(await bellFor(strangerId, 'REASSIGNED', id)).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ note: 'On leave until the 20th.', assignee: 'Deputy' }),
        }),
      ]);
      const thread = await comments(deputyId, id);
      expect(thread.items.find((i: { type: string }) => i.type === 'REASSIGNED')).toMatchObject({
        note: 'On leave until the 20th.',
        assignee: 'Deputy',
      });
      expect((await lastAudit(id, 'APPROVAL_TASK_REASSIGNED'))?.details).toMatchObject({
        toUserId: deputyId,
        note: 'On leave until the 20th.',
        override: false,
      });
      // The deputy can now decide it; the founder no longer holds it.
      await expect(
        approvals([], ownerId).decide({ taskId: task?.id as string, approve: false, note: 'x' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await approvals([], deputyId).decide({
        taskId: task?.id as string,
        approve: true,
      });
      expect(await statusOf(id)).toBe('APPROVED');
    });

    it('VeloExpense: refuses a reassignment to the submitter, to nobody active, or to the holder', async () => {
      const id = await submitted('Bad hand-offs');
      const task = await pendingTaskOn(id);
      const to = (toUserId: string) =>
        approvals([], ownerId).reassign({ taskId: task?.id as string, toUserId, note: 'Because' });
      await expect(to(strangerId)).rejects.toThrow(/submitted it/);
      await expect(to(ownerId)).rejects.toThrow(/already holds/);
      await h.admin.query(`UPDATE app_user SET employee_status = 'ON_LEAVE' WHERE id = $1`, [
        clerkId,
      ]);
      try {
        // w4-00c: ExpenseOS's own refusal, which the router makes before the engine is asked.
        await expect(to(clerkId)).rejects.toThrow(/Unknown or inactive assignee/);
      } finally {
        await h.admin.query(`UPDATE app_user SET employee_status = 'ACTIVE' WHERE id = $1`, [
          clerkId,
        ]);
      }
      expect((await pendingTaskOn(id))?.assignee_id).toBe(ownerId);
    });

    it('setFxOverride restates the foreign expenses and the total of a SUBMITTED report', async () => {
      // VeloExpense: ExpenseOS's unit cases mock the restatement; this is the real one.
      await h.admin.query(
        `INSERT INTO fx_rate (organization_id, base, quote, rate, source)
         VALUES ($1, 'USD', 'CAD', 1.37, 'MANUAL')`,
        [h.orgId],
      );
      const id = await submitted('Statement rate', '10000', 'USD');
      await approvals(FX_PERMS, ownerId).setFxOverride({
        reportId: id,
        rate: '1.40',
        fromCurrency: 'USD',
      });
      const row = (
        await h.admin.query(
          `SELECT total_minor, fx_rate_override, fx_rate_override_by_id FROM expense_report WHERE id = $1`,
          [id],
        )
      ).rows[0];
      expect(String(row.total_minor)).toBe('14000');
      expect(row.fx_rate_override_by_id).toBe(ownerId);
      expect((await lastAudit(id, 'REPORT_FX_OVERRIDE_SET'))?.details).toMatchObject({
        rate: '1.40',
        fromCurrency: 'USD',
      });
    });
  });

  // ── AP cross-report view + on-demand receipt chase ──────────────────
  describe('expenses + chaseReceipts', () => {
    const NONE: readonly string[] = [];
    let apReportId: string;
    let withReceiptId: string;
    let withoutReceiptId: string;

    beforeAll(async () => {
      // VeloExpense: a currency is keyed by its code.
      const currencyId = 'CAD';
      const r = await db.expenseReport.create({
        data: {
          title: 'AP view fixture',
          submitterId: ownerId,
          currencyId,
          status: 'SUBMITTED',
          submittedAt: new Date(),
        },
        select: { id: true },
      });
      apReportId = r.id;
      const mk = async () =>
        (
          await db.expense.create({
            data: {
              reportId: r.id,
              ownerId,
              date: new Date(),
              amountMinor: 4200n,
              currencyId,
            },
            select: { id: true },
          })
        ).id;
      withoutReceiptId = await mk();
      withReceiptId = await mk();
      await db.receipt.create({
        data: {
          expenseId: withReceiptId,
          uploadedById: ownerId,
          filename: 'r.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          // VeloExpense: under the tenant's prefix, and in storage (w2-09).
          s3Key: `org/${h.orgId}/receipts/${r.id}/r.pdf`,
          status: 'STORED',
        },
      });
    });

    it('lists expenses across reports for AP', async () => {
      const { items } = await approvals(REIMBURSER_PERMS, strangerId).expenses({});
      const ids = items.map((i: { id: string }) => i.id);
      expect(ids).toContain(withoutReceiptId);
      expect(ids).toContain(withReceiptId);
    });

    it('filters to just the receiptless ones', async () => {
      const { items } = await approvals(REIMBURSER_PERMS, strangerId).expenses({
        missingReceipt: true,
      });
      const ids = items.map((i: { id: string }) => i.id);
      expect(ids).toContain(withoutReceiptId);
      expect(ids).not.toContain(withReceiptId);
    });

    it('refuses a caller who is neither AP nor admin', async () => {
      // The view crosses submitters by design, so it can't be self-scoped.
      await expect(approvals(NONE, strangerId).expenses({})).rejects.toThrow(/FORBIDDEN/i);
    });

    it("excludes drafts — those are still the submitter's to finish", async () => {
      const draft = await db.expenseReport.create({
        data: {
          title: 'draft',
          submitterId: ownerId,
          currencyId: 'CAD',
          status: 'DRAFT',
        },
        select: { id: true },
      });
      const e = await db.expense.create({
        data: {
          reportId: draft.id,
          ownerId,
          date: new Date(),
          amountMinor: 100n,
          currencyId: 'CAD',
        },
        select: { id: true },
      });
      const { items } = await approvals(REIMBURSER_PERMS, strangerId).expenses({});
      expect(items.map((i: { id: string }) => i.id)).not.toContain(e.id);
    });

    it('PAGES rather than silently truncating', async () => {
      /**
       * The query took 200 rows and stopped, with no cursor to ask for more and nothing on
       * screen saying it had truncated (GA readiness report F19). On a list AP works from,
       * silently hiding expenses is worse than anywhere else in the product.
       *
       * Driven at limit 1 so the paging is exercised without seeding 200 rows.
       */
      const first = await approvals(REIMBURSER_PERMS, strangerId).expenses({
        limit: 1,
      });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toBeTruthy();

      const second = await approvals(REIMBURSER_PERMS, strangerId).expenses({
        limit: 1,
        cursor: first.nextCursor as string,
      });
      expect(second.items).toHaveLength(1);
      // The whole point of a cursor: page two is not page one again.
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    });

    it('reports the end of the list as a null cursor', async () => {
      /**
       * `useInfiniteQuery` stops on null; anything else and the client asks forever.
       *
       * Asserted as a PROPERTY — a page that is not full is the last one — rather than
       * against a fixture size, because this database carries the whole seeded history and
       * any number written here would be a guess that rots.
       */
      const page = await approvals(REIMBURSER_PERMS, strangerId).expenses({
        limit: 500,
      });
      if (page.items.length < 500) {
        expect(page.nextCursor).toBeNull();
      } else {
        // A full page must offer a way onward, or the rest is unreachable — which is the
        // defect this whole change is about.
        expect(page.nextCursor).toBeTruthy();
      }
    });

    it('never repeats or skips a row across page boundaries', async () => {
      /**
       * The reason `id` is in the ORDER BY and not just the cursor. Two expenses on the same
       * DATE are ordinary — the fixture here creates several at once — and a cursor over a
       * non-unique sort skips or repeats rows at every boundary.
       */
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = await approvals(REIMBURSER_PERMS, strangerId).expenses({
          limit: 1,
          cursor,
        });
        if (page.items.length === 0) break;
        seen.push(...page.items.map((e: { id: string }) => e.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(new Set(seen).size, 'a row appeared on two pages').toBe(seen.length);
    });

    it('chases only the receiptless expenses, one ask per report', async () => {
      const before = (await reminders(apReportId)).length;
      const res = await approvals(REIMBURSER_PERMS, strangerId).chaseReceipts({
        // Deliberately include the one that HAS a receipt.
        expenseIds: [withoutReceiptId, withReceiptId],
      });
      expect(res.reports).toBe(1);
      expect(res.expenses).toBe(1); // only the receiptless one counted
      const after = (await reminders(apReportId)).length;
      expect(after).toBe(before + 1);
    });

    it('ignores the cron cooldown — a person asked explicitly', async () => {
      // Two asks back to back both land. The daily job throttles; this must not,
      // or the button would look broken.
      await approvals(REIMBURSER_PERMS, strangerId).chaseReceipts({
        expenseIds: [withoutReceiptId],
      });
      const first = (await reminders(apReportId)).length;
      await approvals(REIMBURSER_PERMS, strangerId).chaseReceipts({
        expenseIds: [withoutReceiptId],
      });
      const second = (await reminders(apReportId)).length;
      expect(second).toBe(first + 1);
    });

    it('attributes the ask to the requester, not the system', async () => {
      await approvals(REIMBURSER_PERMS, strangerId).chaseReceipts({
        expenseIds: [withoutReceiptId],
      });
      const [latest] = await reminders(apReportId);
      // The submitter should see WHO is waiting on them; the cron reminder is
      // actor-less, this one isn't.
      expect(latest?.actor_id).toBe(strangerId);
    });

    it('reports zero rather than erroring when nothing is chaseable', async () => {
      const res = await approvals(REIMBURSER_PERMS, strangerId).chaseReceipts({
        expenseIds: [withReceiptId],
      });
      expect(res).toMatchObject({ reports: 0, expenses: 0 });
    });

    it('skips a report the caller may neither decide nor administer', async () => {
      const res = await approvals(NONE, strangerId).chaseReceipts({
        expenseIds: [withoutReceiptId],
      });
      expect(res.reports).toBe(0);
      expect(res.skipped).toContain(apReportId);
    });

    // ── VeloExpense: what the port adds ────────────────────────────────

    it('VeloExpense: counts an upload that never arrived as no receipt', async () => {
      // A PENDING row is a link that was signed and never used (w2-09). Treating it as a
      // receipt would hide the expense from the very list that exists to chase it.
      const pendingId = (
        await db.expense.create({
          data: {
            reportId: apReportId,
            ownerId,
            date: new Date(),
            amountMinor: 900n,
            currencyId: 'CAD',
          },
          select: { id: true },
        })
      ).id;
      await db.receipt.create({
        data: {
          expenseId: pendingId,
          uploadedById: ownerId,
          filename: 'never.pdf',
          contentType: 'application/pdf',
          s3Key: `org/${h.orgId}/receipts/${apReportId}/never.pdf`,
        },
      });
      const { items } = await approvals(REIMBURSER_PERMS, strangerId).expenses({
        missingReceipt: true,
      });
      const row = items.find((i: { id: string }) => i.id === pendingId);
      expect(row?.receiptCount).toBe(0);
      const res = await approvals(REIMBURSER_PERMS, strangerId).chaseReceipts({
        expenseIds: [pendingId],
      });
      expect(res.expenses).toBe(1);
    });

    it('VeloExpense: pages an expense with no date, after every dated one', async () => {
      // Two of them, and pages of ONE, so a cursor lands on a dateless row: the comparison a
      // cursor makes against a NULL is where a row would be skipped.
      const mkDateless = async () =>
        (
          await db.expense.create({
            data: {
              reportId: apReportId,
              ownerId,
              amountMinor: 300n,
              currencyId: 'CAD',
            },
            select: { id: true },
          })
        ).id;
      const dateless = [await mkDateless(), await mkDateless()];
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 50; i += 1) {
        const page = await approvals(REIMBURSER_PERMS, strangerId).expenses({
          limit: 1,
          cursor,
        });
        seen.push(...page.items.map((e: { id: string }) => e.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      const all = await approvals(REIMBURSER_PERMS, strangerId).expenses({
        limit: 500,
      });
      // Paging reaches every row the one-shot read has, in the same order, once each.
      expect(seen).toEqual(all.items.map((e: { id: string }) => e.id));
      expect(new Set(seen.slice(-2))).toEqual(new Set(dateless));
    });

    it('VeloExpense: tells the submitter who asked, how many, and on which report', async () => {
      await approvals(REIMBURSER_PERMS, strangerId).chaseReceipts({
        expenseIds: [withoutReceiptId],
      });
      const [latest] = await reminders(apReportId);
      expect(latest?.payload).toMatchObject({
        report: 'AP view fixture',
        missing: 1,
        onDemand: true,
      });
      const bell = (
        await h.admin.query(`SELECT recipient_id FROM notification WHERE activity_id = $1`, [
          latest?.id,
        ])
      ).rows.map((r: { recipient_id: string }) => r.recipient_id);
      expect(bell).toEqual([ownerId]);
    });

    it('VeloExpense: names the submitter in the shape the list reads', async () => {
      const { items } = await approvals(REIMBURSER_PERMS, strangerId).expenses({});
      const row = items.find((i: { id: string }) => i.id === withoutReceiptId);
      expect(row.report.submitter).toMatchObject({
        id: ownerId,
        lastName: null,
      });
      expect(row.report.submitter.email).toBeTruthy();
      expect(row.currency).toEqual({ code: 'CAD', symbol: '$' });
    });
  });
});
