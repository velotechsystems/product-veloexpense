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
      `INSERT INTO policy_violation (organization_id, report_id, line_item_id, rule_code, severity, message, finding_key)
       VALUES ($1, $2, $3, 'perTransactionLimit', 'WARNING', 'Over the limit', 'a'),
              ($1, $2, NULL, 'receiptMissing', 'BLOCK', 'No receipt', 'b')`,
      [h.orgId, reportId, lineId],
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
    const request = (
      await h.admin.query(
        `INSERT INTO approval_request (organization_id, report_id, policy_snapshot, status, total_steps,
                                       subject_total_minor, subject_currency_code, opened_by_id)
         VALUES ($1, $2, '{}'::jsonb, 'RUNNING', 1, 2500, 'CAD', $3) RETURNING id`,
        [h.orgId, reportId, ownerId],
      )
    ).rows[0].id;
    await h.admin.query(
      `INSERT INTO approval_task (organization_id, request_id, step, assignee_id) VALUES ($1, $2, 1, $3)`,
      [h.orgId, request, approverId],
    );
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
        `INSERT INTO app_user (organization_id, email, display_name, role, deleted_at)
         VALUES ($1, $2, $3, 'EMPLOYEE', $4)`,
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
      `INSERT INTO app_user (organization_id, email, display_name, role) VALUES ($1, 'ada@attendee-other.test', 'Ada Elsewhere', 'EMPLOYEE')`,
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
        `INSERT INTO app_user (organization_id, email, display_name, role) VALUES ($1, $2, $3, 'EMPLOYEE')`,
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
