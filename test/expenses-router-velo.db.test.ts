// @vitest-environment node
/**
 * VeloExpense's adaptations in the ported expense, line and tax procedures (w2-08b) —
 * what ExpenseOS's own suites cannot cover, because ExpenseOS does not have them:
 *
 *   · `queryRunnerOf` hands VeloExpense's `pg` services the SAME tenant transaction:
 *     parameters stay parameters, `pg`'s shapes come back, RLS still applies, and a
 *     rollback takes both sides with it;
 *   · a new expense counts against the plan's yearly expense cap, refused as a
 *     translatable refusal — and reusing a blank expense creates nothing, so counts nothing;
 *   · a mileage line stops at ExpenseOS's own "no country" refusal until w2-10;
 *   · `explainTax` admits the submitter and an approver with a pending task (VeloExpense's
 *     approval tables, through `callerCanDecideReport`), and nobody else;
 *   · the line writes audit under VeloExpense's names.
 */
import { permissions as P } from '@expenseos/rbac';
import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REFUSAL_KEYS, refusalData } from '@/server/refusal';
import { createTenantHarness, type TenantHarness } from '@/server/__test-helpers__/tenantHarness';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const RW = [P.expense.report.readOwn, P.expense.report.createOwn, P.expense.report.updateOwn] as const;

let h: TenantHarness;
let ownerId: string;
let approverId: string;
let strangerId: string;
let categoryId: string;
let mileageCategoryId: string;

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

beforeAll(async () => {
  h = await createTenantHarness({
    slug: 'expenses-velo',
    name: 'Expenses Velo',
    people: [
      { email: 'approver@expenses-velo.test', name: 'Approver' },
      { email: 'stranger@expenses-velo.test', name: 'Stranger' },
    ],
  });
  ownerId = h.people[0].id;
  approverId = h.people[1].id;
  strangerId = h.people[2].id;
  categoryId = (await h.db.expenseCategory.create({ data: { label: { en: 'Velo meals' } }, select: { id: true } })).id;
  mileageCategoryId = (
    await h.db.expenseCategory.create({ data: { label: { en: 'Velo mileage' }, isMileage: true }, select: { id: true } })
  ).id;
});

afterAll(async () => {
  await h.end();
});

describe('queryRunnerOf — a pg QueryRunner on the Prisma tenant transaction', () => {
  it('passes values as parameters, never as SQL', async () => {
    const { withTenantDb } = await import('@/lib/db/prisma');
    const { queryRunnerOf } = await import('@/lib/db/prisma-pg-bridge');
    const hostile = "x'); DROP TABLE expense; --";
    const r = await withTenantDb(h.orgId, (tx) => queryRunnerOf(tx).query('SELECT $1::text AS v', [hostile]));
    expect(r.rows).toEqual([{ v: hostile }]);
    expect((await h.admin.query(`SELECT to_regclass('expense') IS NOT NULL AS ok`)).rows[0].ok).toBe(true);
  });

  it("returns pg's shapes: int8 and numeric as strings, rowCount for a write", async () => {
    const { withTenantDb } = await import('@/lib/db/prisma');
    const { queryRunnerOf } = await import('@/lib/db/prisma-pg-bridge');
    const out = await withTenantDb(h.orgId, async (tx) => {
      const q = queryRunnerOf(tx);
      const read = await q.query(`SELECT 9007199254740993::bigint AS big, 1.25::numeric AS dec, 3::int AS n`);
      const write = await q.query(`UPDATE app_user SET locale = locale WHERE id = ANY($1::uuid[])`, [
        [ownerId, approverId],
      ]);
      return { row: read.rows[0], rowCount: write.rowCount };
    });
    expect(out.row).toEqual({ big: '9007199254740993', dec: '1.25', n: 3 });
    expect(out.rowCount).toBe(2);
  });

  it('is the SAME transaction: it sees the uncommitted write, and rolls back with it', async () => {
    const { withTenantDb } = await import('@/lib/db/prisma');
    const { queryRunnerOf } = await import('@/lib/db/prisma-pg-bridge');
    const title = `bridge-tx-${Date.now()}`;
    const seen = await withTenantDb(h.orgId, async (tx) => {
      await tx.expenseReport.create({ data: { title, currencyId: 'CAD', submitterId: ownerId } });
      const r = await queryRunnerOf(tx).query('SELECT count(*)::int AS n FROM expense_report WHERE title = $1', [title]);
      throw Object.assign(new Error('rollback'), { seen: r.rows[0].n });
    }).catch((e: { seen?: number }) => e.seen);
    expect(seen).toBe(1);
    expect((await h.admin.query('SELECT count(*)::int AS n FROM expense_report WHERE title = $1', [title])).rows[0].n).toBe(0);
  });

  it('is still under RLS: another tenant’s rows are invisible through it', async () => {
    const { withTenantDb } = await import('@/lib/db/prisma');
    const { queryRunnerOf } = await import('@/lib/db/prisma-pg-bridge');
    const other = (
      await h.admin.query(`INSERT INTO organization (slug, name) VALUES ('velo-other', 'Other') RETURNING id`)
    ).rows[0].id;
    await h.admin.query(`INSERT INTO app_user (organization_id, email) VALUES ($1, 'x@velo-other.test')`, [other]);
    const r = await withTenantDb(h.orgId, (tx) =>
      queryRunnerOf(tx).query(`SELECT count(*)::int AS n FROM app_user WHERE email = 'x@velo-other.test'`),
    );
    expect(r.rows[0].n).toBe(0);
  });
});

describe('the yearly expense cap', () => {
  const setLimits = async (limits: unknown) => {
    await h.admin.query('DELETE FROM subscription WHERE organization_id = $1', [h.orgId]);
    if (limits === undefined) return;
    await h.admin.query(
      `INSERT INTO subscription (organization_id, plan_code, plan_name, status, read_only, features, limits, mirrored_at)
       VALUES ($1, 'starter', 'Starter', 'ACTIVE', false, '{}'::jsonb, $2::jsonb, clock_timestamp())`,
      [h.orgId, JSON.stringify(limits)],
    );
  };

  it('refuses a new expense past the cap, as a refusal the screen can translate', async () => {
    const caller = h.makeCaller(RW, ownerId);
    const report = await caller.create({ title: 'Capped', currency: 'CAD' });
    const used = (
      await h.admin.query(
        `SELECT count(*)::int AS n FROM expense WHERE organization_id = $1 AND created_at > now() - interval '365 days'`,
        [h.orgId],
      )
    ).rows[0].n as number;
    await setLimits({ expensesPerYear: used + 1 });
    try {
      const first = await caller.createExpense({ reportId: report.id });
      // Give it a merchant so the next call cannot simply reuse it as "blank".
      await caller.updateExpense({ expenseId: first.id, merchant: 'Kept' });
      const refused = await caller.createExpense({ reportId: report.id }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(TRPCError);
      expect((refused as TRPCError).code).toBe('FORBIDDEN');
      expect(refusalData(refused)).toEqual({
        key: REFUSAL_KEYS.expenseLimitReached,
        params: { limit: used + 1 },
      });
    } finally {
      await setLimits(undefined);
    }
  });

  it('counts nothing when it reuses a blank expense — nothing was created', async () => {
    const caller = h.makeCaller(RW, ownerId);
    const report = await caller.create({ title: 'Reuse', currency: 'CAD' });
    const blank = await caller.createExpense({ reportId: report.id });
    const used = (
      await h.admin.query(
        `SELECT count(*)::int AS n FROM expense WHERE organization_id = $1 AND created_at > now() - interval '365 days'`,
        [h.orgId],
      )
    ).rows[0].n as number;
    await setLimits({ expensesPerYear: used });
    try {
      const again = await caller.createExpense({ reportId: report.id });
      expect(again.id).toBe(blank.id);
    } finally {
      await setLimits(undefined);
    }
  });
});

describe('mileage, until a traveller has a country (w2-10)', () => {
  it("stops at ExpenseOS's own refusal for a traveller with no country", async () => {
    const caller = h.makeCaller(RW, ownerId);
    const report = await caller.create({ title: 'Miles', currency: 'CAD' });
    const { id } = await caller.createExpense({ reportId: report.id });
    const err = await caller
      .lineItemCreate({ expenseId: id, categoryId: mileageCategoryId, mileageDistance: '42.00', mileageUnit: 'KM' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect((err as TRPCError).message).toMatch(/No country on the traveller/);
    expect(await h.db.expenseLineItem.count({ where: { expenseId: id } })).toBe(0);
  });
});

describe('explainTax — who may read it', () => {
  let expenseId: string;
  let reportId: string;

  beforeAll(async () => {
    const caller = h.makeCaller(RW, ownerId);
    reportId = (await caller.create({ title: 'Explained', currency: 'CAD' })).id;
    expenseId = (await caller.createExpense({ reportId })).id;
    await caller.lineItemCreate({ expenseId, categoryId, amountMinor: '11300' });
    // Out for approval, with a pending task on the approver (VeloExpense's tables).
    await h.admin.query(`UPDATE expense_report SET status = 'SUBMITTED', submitted_at = now() WHERE id = $1`, [reportId]);
    const request = (
      await h.admin.query(
        `INSERT INTO approval_request (organization_id, report_id, policy_snapshot, status, total_steps,
                                       subject_total_minor, subject_currency_code, opened_by_id)
         VALUES ($1, $2, '{}'::jsonb, 'RUNNING', 1, 11300, 'CAD', $3) RETURNING id`,
        [h.orgId, reportId, ownerId],
      )
    ).rows[0].id;
    await h.admin.query(
      `INSERT INTO approval_task (organization_id, request_id, step, assignee_id) VALUES ($1, $2, 1, $3)`,
      [h.orgId, request, approverId],
    );
  });

  it('answers the submitter', async () => {
    const out = await h.makeCaller(RW, ownerId).explainTax({ expenseId });
    expect(out).toMatchObject({ expenseId, totalMinor: '11300', currency: 'CAD' });
  });

  it('answers an approver with a pending task, who holds no read permission of their own', async () => {
    expect(await codeOf(h.makeCaller([], approverId).explainTax({ expenseId }))).toBe('OK');
  });

  it('hides it from anybody else, as NOT_FOUND', async () => {
    expect(await codeOf(h.makeCaller(RW, strangerId).explainTax({ expenseId }))).toBe('NOT_FOUND');
  });
});

describe('the line writes audit under VeloExpense’s names', () => {
  it('LINE_ITEM_ADDED, LINE_ITEM_EDITED, LINE_ITEM_REMOVED', async () => {
    const caller = h.makeCaller(RW, ownerId);
    const report = await caller.create({ title: 'Audited', currency: 'CAD' });
    const { id: expenseId } = await caller.createExpense({ reportId: report.id });
    const { id } = await caller.lineItemCreate({ expenseId, categoryId, amountMinor: '100' });
    expect((await h.lastAudit('Expense', expenseId))?.action).toBe('LINE_ITEM_ADDED');
    await caller.lineItemUpdate({ id, amountMinor: '200' });
    expect((await h.lastAudit('ExpenseLineItem', id))?.action).toBe('LINE_ITEM_EDITED');
    await caller.lineItemRemove({ id });
    expect((await h.lastAudit('ExpenseLineItem', id))?.action).toBe('LINE_ITEM_REMOVED');
  });
});
