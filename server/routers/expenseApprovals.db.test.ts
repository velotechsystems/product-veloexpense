// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- VeloExpense: ExpenseOS's suite reads its rows untyped (`db: any`); Biome allows it there. */
import { permissions as P } from '@expenseos/rbac';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTenantHarness, type TenantHarness } from '../__test-helpers__/tenantHarness';

/**
 * VeloExpense: ExpenseOS's `expenseApprovals.db.test.ts`, the cases for the procedures ported so
 * far — "expenses + chaseReceipts" (w2-06), and the submitter's `expenses.submit` /
 * `expenses.recall` cases (w2-11), which ExpenseOS keeps here because they drive its approval
 * engine. The rest of ExpenseOS's suite (the inbox, the approver's report, decide / return /
 * reimburse) arrives with the engine in Wave 4.
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
      people: [{ email: 'stranger@expense-approvals.test', name: 'Stranger' }],
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
     * VeloExpense: the submitter is the suite's EMPLOYEE, so the report routes to the
     * tenant's administrator (the founder) on VeloExpense's engine. ExpenseOS's "submit
     * auto-approves when no EXPENSE_REPORT workflow matches" has no counterpart: VeloExpense's
     * engine routes every submit (VX2-3), and refuses one it cannot route rather than
     * approving it unseen.
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
    const runOf = async (reportId: string) =>
      (
        await h.admin.query(
          `SELECT r.status, count(t.id) FILTER (WHERE t.status = 'PENDING')::int AS pending
             FROM approval_request r LEFT JOIN approval_task t ON t.request_id = r.id
            WHERE r.report_id = $1 GROUP BY r.id, r.status, r.opened_at
            ORDER BY r.opened_at DESC LIMIT 1`,
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

    it('submit routes to the approval ladder', async () => {
      // VeloExpense: ExpenseOS's "submit routes to the seeded amount-tiered workflow", on
      // VeloExpense's engine — a RUNNING request parked on a pending task.
      const reportId = await seedReport('DRAFT');
      await addValuedExpense(reportId);
      const res = await owner().submit({ reportId });
      expect(res.report.status).toBe('SUBMITTED');
      const run = await runOf(reportId);
      expect(run?.status).toBe('RUNNING');
      expect(run?.pending, 'the run must park on an approval task').toBeGreaterThan(0);
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
        `INSERT INTO expense_policy (organization_id, kind, severity, params)
         VALUES ($1, 'PER_TRANSACTION_LIMIT', 'WARNING', '{"thresholdMinor": 5000}')`,
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
          `DELETE FROM expense_policy WHERE organization_id = $1 AND kind = 'PER_TRANSACTION_LIMIT'`,
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
