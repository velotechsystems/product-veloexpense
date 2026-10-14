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
 *   · a mileage line is priced by the traveller's own country (`app_user.country`, 0055,
 *     w2-10), and stops at ExpenseOS's own "no country" refusal for somebody with none;
 *     the address lookup answers unavailable with no key configured;
 *   · `explainTax` admits the submitter and an approver with a pending task (VeloExpense's
 *     approval tables, through `callerCanDecideReport`), and nobody else;
 *   · the line writes audit under VeloExpense's names;
 *   · `report` reads VeloExpense's own tables in ExpenseOS's shape — the violations
 *     (anchored to a line, so `expenseId` is the line's expense), the posting state off
 *     `integration_post`, the currency's symbol — and admits a pending approver;
 *   · `allocationSet` refuses a business unit or department that is unknown or
 *     deactivated, unless the expense already carries it (f09), and stores no NetSuite
 *     business unit or class;
 *   · `attendeeDirectory` searches VeloExpense's one display name and the email, in this
 *     tenant only, leaving deleted people out (ExpenseOS has no server test for it);
 *   · receipts (d29, d30): `receiptCreate` reads the object back — nothing uploaded and an
 *     oversized object are refused, the oversized one deleted — and records storage's size
 *     as STORED; a PENDING row from the old drawer is never shown; another tenant's key is
 *     refused; the report signs a view link for an hour and `receiptList` for five
 *     minutes; a report filed from N receipts counts N against the cap; and the receipt
 *     writes audit as REPORT_CREATED, RECEIPT_ATTACHED and RECEIPT_REMOVED.
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


/**
 * w4-00c: a report out for approval on ExpenseOS's engine, with one pending task assigned to
 * `assigneeId` — an instance on a one-step workflow, pointed at by the report, as a submit
 * leaves it. Written as the admin, so a suite can put it anywhere a submit cannot.
 */
async function pendingEngineTask(reportId: string, assigneeId: string): Promise<string> {
  const graph = {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'n1', type: 'approval', approver: { kind: 'manager' } },
      { id: 'done', type: 'approved' },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'n1' },
      { id: 'e2', source: 'n1', target: 'done' },
    ],
  };
  const wf = await h.admin.query(
    `INSERT INTO approval_workflow (organization_id, key, name, subject_type)
     VALUES ($1, $2, 'harness', 'EXPENSE_REPORT') RETURNING id`,
    [h.orgId, `harness-${Date.now()}-${Math.floor(Math.random() * 1e6)}`],
  );
  const v = await h.admin.query(
    `INSERT INTO approval_workflow_version (organization_id, workflow_id, version, match_condition, graph)
     VALUES ($1, $2, 1, '{}', $3::jsonb) RETURNING id`,
    [h.orgId, wf.rows[0].id, JSON.stringify(graph)],
  );
  const inst = await h.admin.query(
    `INSERT INTO approval_instance (organization_id, workflow_version_id, subject_type, subject_id, cursor, effective_graph)
     VALUES ($1, $2, 'EXPENSE_REPORT', $3, '{}', $4::jsonb) RETURNING id`,
    [h.orgId, v.rows[0].id, reportId, JSON.stringify(graph)],
  );
  const task = await h.admin.query(
    `INSERT INTO approval_instance_task (organization_id, instance_id, node_id, assignee_user_id)
     VALUES ($1, $2, 'n1', $3) RETURNING id`,
    [h.orgId, inst.rows[0].id, assigneeId],
  );
  await h.admin.query(`UPDATE expense_report SET approval_instance_id = $1 WHERE id = $2`, [
    inst.rows[0].id,
    reportId,
  ]);
  return task.rows[0].id as string;
}

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

describe("mileage and the traveller's country (w2-10)", () => {
  it("stops at ExpenseOS's own refusal for a traveller with no country", async () => {
    // The founder has no legal entity, so 0055 gave them no country.
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

  it('prices the line once the traveller has a country and a rule is in force there', async () => {
    await h.admin.query(`UPDATE app_user SET country = 'CA' WHERE id = $1`, [ownerId]);
    try {
      await h.db.mileageRate.create({
        data: {
          country: 'CA',
          unit: 'KM',
          effectiveFrom: new Date('2000-01-01'),
          tiers: { create: [{ fromDistance: '0.00', rateMinor: 70n }] },
        },
      });
      const caller = h.makeCaller(RW, ownerId);
      const report = await caller.create({ title: 'Miles, priced', currency: 'CAD' });
      const { id } = await caller.createExpense({ reportId: report.id });
      // The rate is resolved by the expense's date.
      await caller.updateExpense({ expenseId: id, date: new Date() });
      const { id: lineId } = await caller.lineItemCreate({
        expenseId: id,
        categoryId: mileageCategoryId,
        mileageDistance: '42.00',
        mileageUnit: 'KM',
      });
      const line = await h.db.expenseLineItem.findUniqueOrThrow({ where: { id: lineId } });
      expect(line.amountMinor).toBe(2940n); // 42 km × 70¢
    } finally {
      await h.admin.query(`UPDATE app_user SET country = NULL WHERE id = $1`, [ownerId]);
    }
  });

  it('answers the address lookup as unavailable with no key, rather than failing', async () => {
    const { mileageRouteRouter } = await import('@/server/routers/mileageRoute');
    const route = h.makeCaller(RW, ownerId, mileageRouteRouter);
    const before = process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;
    try {
      expect(await route.status()).toEqual({ available: false });
      expect(
        await route.searchPlaces({ query: '100 King St', sessionToken: '00000000-0000-4000-8000-000000000001' }),
      ).toEqual({ available: false, items: [], error: null });
    } finally {
      if (before !== undefined) process.env.GOOGLE_PLACES_API_KEY = before;
    }
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
    // w4-00c: a pending task on the approval engine, assigned to the approver.
    await pendingEngineTask(reportId, approverId);
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

describe('a line\'s GL account, with the accounting module off and on (w2-02b)', () => {
  /**
   * VeloExpense's chart is invisible with the accounting module off (0022), and a line filed
   * then carries no GL account — VeloExpense's own `accountForCategory` rule. The ported
   * stamp read the category's column instead, wrote the id of an account the tenant cannot
   * see, and the insert failed on its foreign key: no line could be added on the workbench.
   */
  it('stamps nothing while the module is off, and the account once it is on', async () => {
    const account = (
      await h.admin.query(
        `INSERT INTO gl_account (organization_id, number, name, type)
         VALUES ($1, '68150', 'Velo taxis', 'expense') RETURNING id`,
        [h.orgId],
      )
    ).rows[0].id as string;
    const mapped = (
      await h.admin.query(
        `INSERT INTO expense_category (organization_id, label, gl_account_id)
         VALUES ($1, '{"en":"Velo taxis"}'::jsonb, $2) RETURNING id`,
        [h.orgId, account],
      )
    ).rows[0].id as string;
    const caller = h.makeCaller(RW, ownerId);
    const reportId = (await caller.create({ title: 'GL stamp', currency: 'CAD' })).id;
    const { id: expenseId } = await caller.createExpense({ reportId });
    const glOf = async (lineId: string) =>
      (await h.admin.query('SELECT gl_account_id FROM expense_line_item WHERE id = $1', [lineId]))
        .rows[0].gl_account_id as string | null;

    await h.admin.query(
      `DELETE FROM module_entitlement WHERE organization_id = $1 AND module_code = 'accounting'`,
      [h.orgId],
    );
    const off = await caller.lineItemCreate({ expenseId, categoryId: mapped, amountMinor: '1000' });
    expect(await glOf(off.id)).toBeNull();

    await h.admin.query(
      `INSERT INTO module_entitlement (organization_id, module_code, enabled)
       VALUES ($1, 'accounting', true)`,
      [h.orgId],
    );
    try {
      const on = await caller.lineItemCreate({ expenseId, categoryId: mapped, amountMinor: '1000' });
      expect(await glOf(on.id)).toBe(account);
    } finally {
      await h.admin.query(
        `DELETE FROM module_entitlement WHERE organization_id = $1 AND module_code = 'accounting'`,
        [h.orgId],
      );
    }
  });
});

describe('report — VeloExpense\'s tables, in ExpenseOS\'s shape', () => {
  let reportId: string;
  let expenseId: string;
  let lineId: string;

  beforeAll(async () => {
    const caller = h.makeCaller(RW, ownerId);
    reportId = (await caller.create({ title: 'Read back', currency: 'CAD' })).id;
    expenseId = (await caller.createExpense({ reportId })).id;
    lineId = (await caller.lineItemCreate({ expenseId, categoryId, amountMinor: '2500' })).id;
  });

  it('names the currency by code, with its symbol, as ExpenseOS does', async () => {
    const out = await h.makeCaller(RW, ownerId).report({ reportId });
    expect(out.currency).toEqual({ code: 'CAD', symbol: expect.any(String) });
    expect(out.currency.symbol).not.toBe('');
    expect(out.expenses[0].currency).toMatchObject({ id: 'CAD', code: 'CAD' });
  });

  it("carries a line's violation under its expense, and a report-level one under none", async () => {
    await h.admin.query(
      // w4-02d: ExpenseOS's row — the line's expense is a column the engine writes.
      `INSERT INTO policy_violation (organization_id, report_id, line_item_id, expense_id, rule_code, severity, message)
       VALUES ($1, $2, $3, $4, 'perTransactionLimit', 'WARNING', 'Over the limit'),
              ($1, $2, NULL, NULL, 'receiptMissing', 'BLOCK', 'No receipt')`,
      [h.orgId, reportId, lineId, expenseId],
    );
    const out = await h.makeCaller(RW, ownerId).report({ reportId });
    const byRule = Object.fromEntries(out.violations.map((v: { ruleCode: string }) => [v.ruleCode, v]));
    expect(byRule.perTransactionLimit).toMatchObject({
      reportId,
      expenseId,
      lineItemId: lineId,
      severity: 'WARNING',
      message: 'Over the limit',
      resolvedAt: null,
    });
    expect(byRule.receiptMissing).toMatchObject({ expenseId: null, severity: 'BLOCK' });
  });

  it('carries a finding about one expense — no line — under that expense (w2-02b)', async () => {
    // w4-02d: ExpenseOS anchors an entry-level finding to its expense in a column
    // (`expense_id`, 0066, which also moved v1's `data.expenseId` there). Read as report-level,
    // the workbench showed it on no expense.
    await h.admin.query(
      `INSERT INTO policy_violation (organization_id, report_id, line_item_id, expense_id, rule_code, severity, message)
       VALUES ($1, $2, NULL, $3, 'expenseScoped', 'BLOCK', 'No receipt')`,
      [h.orgId, reportId, expenseId],
    );
    const out = await h.makeCaller(RW, ownerId).report({ reportId });
    const byRule = Object.fromEntries(out.violations.map((v: { ruleCode: string }) => [v.ruleCode, v]));
    expect(byRule.expenseScoped).toMatchObject({ expenseId, lineItemId: null });
  });

  it('reports no posting until one is queued, then its state — a claimed PENDING as PROCESSING', async () => {
    const caller = h.makeCaller(RW, ownerId);
    expect((await caller.report({ reportId })).posting).toBeNull();
    await h.admin.query(
      `INSERT INTO integration_post (organization_id, report_id, status, attempts, idempotency_key, claimed_at)
       VALUES ($1, $2, 'PENDING', 1, $3, now())`,
      [h.orgId, reportId, `velo-${reportId}`],
    );
    expect((await caller.report({ reportId })).posting).toMatchObject({
      status: 'PROCESSING',
      attempts: 1,
      lastError: null,
      externalId: null,
      postedAt: null,
    });
  });

  it('admits an approver with a pending task, and nobody else', async () => {
    await h.admin.query(`UPDATE expense_report SET status = 'SUBMITTED', submitted_at = now() WHERE id = $1`, [
      reportId,
    ]);
    // w4-00c: a pending task on the approval engine, assigned to the approver.
    await pendingEngineTask(reportId, approverId);
    expect(await codeOf(h.makeCaller([], approverId).report({ reportId }))).toBe('OK');
    expect(await codeOf(h.makeCaller(RW, strangerId).report({ reportId }))).toBe('NOT_FOUND');
  });
});

describe('allocationSet — what an expense may be coded to (f09)', () => {
  let buId: string;
  let deptId: string;
  let retiredBuId: string;
  let retiredDeptId: string;

  const draftExpense = async () => {
    const caller = h.makeCaller(RW, ownerId);
    const report = await caller.create({ title: 'Coding', currency: 'CAD' });
    return (await caller.createExpense({ reportId: report.id })).id as string;
  };
  const row = (businessUnitId: string, departmentId: string) => ({
    percentBp: 10_000,
    businessUnitId,
    departmentId,
  });

  beforeAll(async () => {
    const label = (en: string) => ({ label: { en } });
    buId = (await h.db.businessUnit.create({ data: label('Coding BU'), select: { id: true } })).id;
    deptId = (await h.db.department.create({ data: label('Coding dept'), select: { id: true } })).id;
    retiredBuId = (await h.db.businessUnit.create({ data: label('Retired BU'), select: { id: true } })).id;
    retiredDeptId = (await h.db.department.create({ data: label('Retired dept'), select: { id: true } })).id;
  });

  it('refuses a deactivated business unit or department, and writes nothing', async () => {
    const expenseId = await draftExpense();
    await h.db.businessUnit.update({ where: { id: retiredBuId }, data: { active: false } });
    await h.db.department.update({ where: { id: retiredDeptId }, data: { active: false } });
    const caller = h.makeCaller(RW, ownerId);
    for (const allocations of [[row(retiredBuId, deptId)], [row(buId, retiredDeptId)]]) {
      const err = await caller.allocationSet({ expenseId, allocations }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe('BAD_REQUEST');
      expect((err as TRPCError).message).toMatch(/no longer available/);
    }
    expect(await h.db.expenseAllocation.count({ where: { expenseId } })).toBe(0);
  });

  it('refuses an id that is not one of this tenant’s, as a refusal rather than a server error', async () => {
    const expenseId = await draftExpense();
    const err = await h
      .makeCaller(RW, ownerId)
      .allocationSet({ expenseId, allocations: [row('00000000-0000-7000-8000-0000000000ab', deptId)] })
      .catch((e: unknown) => e);
    expect((err as TRPCError).code).toBe('BAD_REQUEST');
  });

  it('keeps a deactivated one the expense already carries, so its other rows stay editable', async () => {
    const expenseId = await draftExpense();
    const caller = h.makeCaller(RW, ownerId);
    // Coded while both were active…
    await h.db.businessUnit.update({ where: { id: retiredBuId }, data: { active: true } });
    await caller.allocationSet({ expenseId, allocations: [row(retiredBuId, deptId)] });
    // …then the business unit is retired, and the owner splits the expense.
    await h.db.businessUnit.update({ where: { id: retiredBuId }, data: { active: false } });
    await caller.allocationSet({
      expenseId,
      allocations: [
        { ...row(retiredBuId, deptId), percentBp: 5_000 },
        { ...row(buId, deptId), percentBp: 5_000 },
      ],
    });
    const rows = await h.db.expenseAllocation.findMany({ where: { expenseId }, select: { businessUnitId: true } });
    expect(rows.map((r: { businessUnitId: string }) => r.businessUnitId).sort()).toEqual([buId, retiredBuId].sort());
  });

  it('stores no NetSuite business unit or class, whatever the client sends', async () => {
    const expenseId = await draftExpense();
    await h.makeCaller(RW, ownerId).allocationSet({
      expenseId,
      allocations: [
        { ...row(buId, deptId), nsBusinessUnitId: '00000000-0000-7000-8000-0000000000cd', classId: buId },
      ],
    });
    const stored = await h.admin.query(`SELECT to_jsonb(a) AS r FROM expense_allocation a WHERE expense_id = $1`, [
      expenseId,
    ]);
    expect(stored.rows).toHaveLength(1);
    expect(Object.keys(stored.rows[0].r)).not.toContain('ns_business_unit_id');
    expect(Object.keys(stored.rows[0].r)).not.toContain('class_id');
    expect(stored.rows[0].r).toMatchObject({ business_unit_id: buId, department_id: deptId });
  });
});

describe('attendeeDirectory — the attendee picker\'s search', () => {
  const search = (query: string, perms: readonly string[] = RW) =>
    h.makeCaller(perms, ownerId).attendeeDirectory({ query });

  beforeAll(async () => {
    const add = (email: string, name: string | null, deleted = false) =>
      h.admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, role_id, deleted_at)
         VALUES ($1, $2, $3, '019e3000-0000-7000-8000-000000000004', $4)`,
        [h.orgId, email, name, deleted ? new Date() : null],
      );
    await add('ada.lovelace@expenses-velo.test', 'Ada Lovelace');
    await add('nameless@expenses-velo.test', null);
    await add('ada.gone@expenses-velo.test', 'Ada Gone', true);
    // Another tenant's Ada, who must never appear.
    const other = (
      await h.admin.query(`INSERT INTO organization (slug, name) VALUES ('attendee-other', 'Other') RETURNING id`)
    ).rows[0].id;
    await h.admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id) VALUES ($1, 'ada@attendee-other.test', 'Ada Elsewhere', '019e3000-0000-7000-8000-000000000004')`,
      [other],
    );
  });

  it('finds a person by display name or email, case-insensitively, with id, name and email only', async () => {
    const byName = await search('LOVELACE');
    expect(byName).toEqual([
      { id: expect.any(String), name: 'Ada Lovelace', email: 'ada.lovelace@expenses-velo.test' },
    ]);
    expect((await search('ada.lovelace@')).map((u: { name: string }) => u.name)).toEqual(['Ada Lovelace']);
  });

  it('names a person with no display name by their email', async () => {
    expect(await search('nameless')).toEqual([
      { id: expect.any(String), name: 'nameless@expenses-velo.test', email: 'nameless@expenses-velo.test' },
    ]);
  });

  it('leaves out deleted people and other tenants', async () => {
    const names = (await search('ada')).map((u: { name: string }) => u.name);
    expect(names).toContain('Ada Lovelace');
    expect(names).not.toContain('Ada Gone');
    expect(names).not.toContain('Ada Elsewhere');
  });

  it('returns at most ten', async () => {
    for (let i = 0; i < 12; i++) {
      await h.admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, role_id) VALUES ($1, $2, $3, '019e3000-0000-7000-8000-000000000004')`,
        [h.orgId, `bulk${i}@expenses-velo.test`, `Bulk ${i}`],
      );
    }
    expect(await search('bulk')).toHaveLength(10);
  });

  it('is refused without the permission to edit a report', async () => {
    expect(await codeOf(search('ada', [P.expense.report.readOwn]))).toBe('FORBIDDEN');
  });
});

describe('receipts — VeloExpense\'s storage rules (d29, d30)', () => {
  let reportId: string;
  let expenseId: string;
  const prefix = () => `org/${h.orgId}/receipts/${reportId}`;
  const pdf = { filename: 'r.pdf', contentType: 'application/pdf' };

  beforeAll(async () => {
    const caller = h.makeCaller(RW, ownerId);
    reportId = (await caller.create({ title: 'Receipts', currency: 'CAD' })).id;
    expenseId = (await caller.createExpense({ reportId })).id;
  });

  it('refuses a receipt nobody uploaded, and records nothing', async () => {
    const err = await h
      .makeCaller(RW, ownerId)
      .receiptCreate({ expenseId, key: `${prefix()}/never-put.pdf`, ...pdf, sizeBytes: 100 })
      .catch((e: unknown) => e);
    expect((err as TRPCError).code).toBe('BAD_REQUEST');
    expect((err as TRPCError).message).toMatch(/No file was uploaded/);
    expect(await h.db.receipt.count({ where: { expenseId } })).toBe(0);
  });

  it('refuses an object over the cap whatever size was declared, and deletes it', async () => {
    const key = `${prefix()}/huge.pdf`;
    h.storage.memory.put(key, new Uint8Array(10 * 1024 * 1024 + 1), 'application/pdf');
    const err = await h
      .makeCaller(RW, ownerId)
      .receiptCreate({ expenseId, key, ...pdf, sizeBytes: 100 })
      .catch((e: unknown) => e);
    expect((err as TRPCError).code).toBe('BAD_REQUEST');
    expect(h.storage.memory.has(key)).toBe(false);
    expect(await h.db.receipt.count({ where: { expenseId } })).toBe(0);
  });

  it("records the size storage reports, not the client's, as STORED", async () => {
    const key = `${prefix()}/real.pdf`;
    h.storage.memory.put(key, new Uint8Array(777), 'application/pdf');
    const { id } = await h.makeCaller(RW, ownerId).receiptCreate({ expenseId, key, ...pdf, sizeBytes: 100 });
    expect(await h.db.receipt.findUnique({ where: { id }, select: { sizeBytes: true, status: true } })).toEqual({
      sizeBytes: 777,
      status: 'STORED',
    });
    expect((await h.lastAudit('Expense', expenseId))?.action).toBe('RECEIPT_ATTACHED');
  });

  it("refuses another tenant's key, even for the same report id", async () => {
    const key = `org/00000000-0000-7000-8000-0000000000ee/receipts/${reportId}/theirs.pdf`;
    h.storage.memory.put(key, new Uint8Array(10), 'application/pdf');
    await expect(
      h.makeCaller(RW, ownerId).receiptCreate({ expenseId, key, ...pdf, sizeBytes: 10 }),
    ).rejects.toThrow(/Invalid receipt key/);
  });

  it('never shows a PENDING row the old drawer left, in the report or the list', async () => {
    await h.admin.query(
      `INSERT INTO receipt (organization_id, expense_id, s3_key, filename, content_type, status, uploaded_by_id)
       VALUES ($1, $2, $3, 'pending.pdf', 'application/pdf', 'PENDING', $4)`,
      [h.orgId, expenseId, `${prefix()}/pending.pdf`, ownerId],
    );
    const caller = h.makeCaller(RW, ownerId);
    const listed = (await caller.receiptList({ expenseId })).items.map((i: { filename: string }) => i.filename);
    const shown = (await caller.report({ reportId })).expenses[0].receipts.map((r: { filename: string }) => r.filename);
    expect(listed).toEqual(['r.pdf']);
    expect(shown).toEqual(['r.pdf']);
  });

  it('signs the report\'s view link for an hour and the list\'s for five minutes', async () => {
    const caller = h.makeCaller(RW, ownerId);
    const [onReport] = (await caller.report({ reportId })).expenses[0].receipts;
    const [onList] = (await caller.receiptList({ expenseId })).items;
    expect(onReport.url).toMatch(/\?ttl=3600$/);
    expect(onList.url).toMatch(/\?ttl=300$/);
  });

  it('audits a removal as RECEIPT_REMOVED and takes the object with it', async () => {
    const key = `${prefix()}/gone.pdf`;
    h.storage.memory.put(key, new Uint8Array(5), 'application/pdf');
    const caller = h.makeCaller(RW, ownerId);
    const { id } = await caller.receiptCreate({ expenseId, key, ...pdf, sizeBytes: 5 });
    await caller.receiptRemove({ id });
    expect((await h.lastAudit('Expense', expenseId))?.action).toBe('RECEIPT_REMOVED');
    expect(h.storage.memory.has(key)).toBe(false);
  });

  it('counts every expense of a report filed from receipts against the cap, creating nothing past it', async () => {
    const used = (
      await h.admin.query(
        `SELECT count(*)::int AS n FROM expense WHERE organization_id = $1 AND created_at > now() - interval '365 days'`,
        [h.orgId],
      )
    ).rows[0].n as number;
    await h.admin.query(
      `INSERT INTO subscription (organization_id, plan_code, plan_name, status, read_only, features, limits, mirrored_at)
       VALUES ($1, 'starter', 'Starter', 'ACTIVE', false, '{}'::jsonb, $2::jsonb, clock_timestamp())`,
      [h.orgId, JSON.stringify({ expensesPerYear: used + 2 })],
    );
    try {
      const caller = h.makeCaller([...RW, P.expense.report.createOwn], ownerId);
      const reports = async () => (await h.admin.query('SELECT count(*)::int AS n FROM expense_report')).rows[0].n;
      const before = await reports();
      const refused = await caller.startFromReceipts({ title: 'Three', count: 3 }).catch((e: unknown) => e);
      expect(refusalData(refused)).toEqual({ key: REFUSAL_KEYS.expenseLimitReached, params: { limit: used + 2 } });
      expect(await reports()).toBe(before);
      // Two fit, and the report is audited as created.
      const ok = await caller.startFromReceipts({ title: 'Two', count: 2 });
      expect(ok.expenseIds).toHaveLength(2);
      expect((await h.lastAudit('ExpenseReport', ok.reportId))?.action).toBe('REPORT_CREATED');
    } finally {
      await h.admin.query('DELETE FROM subscription WHERE organization_id = $1', [h.orgId]);
    }
  });
});
