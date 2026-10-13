/**
 * w4-02c — ExpenseOS's per-category policy router (`policies.expensePolicy`), ported,
 * against a real database (migration 0065).
 *
 *   · `byCategory` lists the tenant's active categories, each with its policy or null, and
 *     the limits as minor-unit strings;
 *   · `upsert` creates the row the first time and changes it after, each write audited
 *     (`EXPENSE_POLICY_CHANGED`) into a chain that verifies;
 *   · VeloExpense: `currency` is the organization's policy currency; another tenant's
 *     category and a negative limit are BAD_REQUEST; deleting a category takes its policy;
 *     the policy currency is set per tenant (d68, w4-02d), audited;
 *   · tenancy and permissions.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { TRPCError } from '@trpc/server';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const { createOrganization } = await import('@/lib/onboarding/provision');
const { createCallerFactory } = await import('@/server/trpc');
const { appRouter } = await import('@/server/routers/_app');
const { db } = await import('@/lib/db/prisma');
const { withOrg } = await import('@/lib/tenant/context');
const { verifyChain } = await import('@/lib/audit/verify');

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

let A: string;
let B: string;
let meals: string;
let betaMeals: string;

const as = (email: string, organizationId: string) =>
  createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } });
const boss = () => as('boss@alpha.test', A);

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha EP', slug: 'alpha-ep', adminEmail: 'boss@alpha.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta EP', slug: 'beta-ep', adminEmail: 'boss@beta.test', adminName: 'Other' }))
    .organizationId;
  await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name, role) VALUES ($1, 'emp@alpha.test', 'Emp', 'EMPLOYEE')`,
    [A],
  );
  const cat = async (org: string, code: string, label: string) =>
    (
      await admin.query(
        `INSERT INTO expense_category (organization_id, code, label) VALUES ($1, $2, jsonb_build_object('en', $3::text)) RETURNING id`,
        [org, code, label],
      )
    ).rows[0].id as string;
  meals = await cat(A, 'ep-meals', 'EP Meals');
  betaMeals = await cat(B, 'ep-meals', 'Beta EP Meals');
});

afterAll(async () => {
  await admin.end();
});

describe('a category’s policy', () => {
  it('is null until set, then created and changed, each write audited into a chain that verifies', async () => {
    const c = boss();
    const before = (await c.policies.expensePolicy.byCategory()).find((r) => r.category.id === meals);
    expect(before).toMatchObject({ category: { id: meals, label: { en: 'EP Meals' } }, policy: null });

    const created = await c.policies.expensePolicy.upsert({
      categoryId: meals,
      patch: { perTransactionLimitMinor: '7500', receiptRequired: false },
    });
    expect(created).toMatchObject({
      categoryId: meals,
      perTransactionLimitMinor: '7500',
      receiptRequired: false,
      approvalRequired: true,
      dailyLimitMinor: null,
    });
    await c.policies.expensePolicy.upsert({ categoryId: meals, patch: { dailyLimitMinor: '20000' } });
    const after = (await c.policies.expensePolicy.byCategory()).find((r) => r.category.id === meals);
    expect(after?.policy).toMatchObject({ perTransactionLimitMinor: '7500', dailyLimitMinor: '20000' });
    expect((await c.policies.expensePolicy.list()).map((p) => p.categoryId)).toEqual([meals]);

    const row = (
      await admin.query('SELECT organization_id, per_transaction_limit_minor::text AS ptl FROM expense_category_policy WHERE category_id = $1', [meals])
    ).rows[0];
    expect(row).toEqual({ organization_id: A, ptl: '7500' });
    const audit = (
      await admin.query(`SELECT action, entity_type FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`, [meals])
    ).rows;
    expect(audit).toEqual([
      { action: 'EXPENSE_POLICY_CHANGED', entity_type: 'ExpensePolicy' },
      { action: 'EXPENSE_POLICY_CHANGED', entity_type: 'ExpensePolicy' },
    ]);
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });

  it('is labelled in the organization’s policy currency', async () => {
    await admin.query(`UPDATE organization SET policy_currency_code = 'USD' WHERE id = $1`, [A]);
    try {
      expect(await boss().policies.expensePolicy.currency()).toMatchObject({ code: 'USD' });
      expect(await as('boss@beta.test', B).policies.expensePolicy.currency()).toMatchObject({ code: 'CAD' });
    } finally {
      await admin.query(`UPDATE organization SET policy_currency_code = 'CAD' WHERE id = $1`, [A]);
    }
  });

  it('VeloExpense (d68): is set by an admin for its own tenant only, audited into a chain that verifies', async () => {
    try {
      expect(await boss().policies.expensePolicy.setCurrency({ code: 'eur' })).toEqual({ code: 'EUR' });
      const rows = (
        await admin.query(`SELECT id, policy_currency_code FROM organization WHERE id = ANY($1::uuid[]) ORDER BY name`, [[A, B]])
      ).rows;
      expect(rows).toEqual([
        { id: A, policy_currency_code: 'EUR' },
        { id: B, policy_currency_code: 'CAD' },
      ]);
      const audit = (
        await admin.query(
          `SELECT organization_id, entity_type, entity_id, details FROM audit_entry WHERE action = 'POLICY_CURRENCY_SET'`,
        )
      ).rows;
      expect(audit).toEqual([
        { organization_id: A, entity_type: 'Organization', entity_id: A, details: { from: 'CAD', to: 'EUR' } },
      ]);
      expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
      expect(await codeOf(as('emp@alpha.test', A).policies.expensePolicy.setCurrency({ code: 'USD' }))).toBe('FORBIDDEN');
    } finally {
      await admin.query(`UPDATE organization SET policy_currency_code = 'CAD' WHERE id = $1`, [A]);
    }
  });

  it('goes with its category', async () => {
    const tmp = (
      await admin.query(
        `INSERT INTO expense_category (organization_id, code, label) VALUES ($1, 'ep-tmp', '{"en":"Tmp"}') RETURNING id`,
        [A],
      )
    ).rows[0].id as string;
    await boss().policies.expensePolicy.upsert({ categoryId: tmp, patch: { annualLimitMinor: '1' } });
    await admin.query('DELETE FROM expense_category WHERE id = $1', [tmp]);
    expect((await admin.query('SELECT count(*)::int AS n FROM expense_category_policy WHERE category_id = $1', [tmp])).rows[0].n).toBe(0);
  });
});

describe('VeloExpense: what the table refuses is a 4xx', () => {
  it('refuses another tenant’s category and a negative limit', async () => {
    const c = boss();
    expect(await codeOf(c.policies.expensePolicy.upsert({ categoryId: betaMeals, patch: { receiptRequired: true } }))).toBe(
      'BAD_REQUEST',
    );
    expect(await codeOf(c.policies.expensePolicy.upsert({ categoryId: meals, patch: { monthlyLimitMinor: '-1' } }))).toBe(
      'BAD_REQUEST',
    );
    expect((await admin.query('SELECT count(*)::int AS n FROM expense_category_policy WHERE category_id = $1', [betaMeals])).rows[0].n).toBe(0);
  });

  it('refuses a category another tenant already has a policy for, without saying so', async () => {
    await as('boss@beta.test', B).policies.expensePolicy.upsert({ categoryId: betaMeals, patch: { notes: 'Beta' } });
    expect(await codeOf(boss().policies.expensePolicy.upsert({ categoryId: betaMeals, patch: { notes: 'Stolen' } }))).toBe(
      'BAD_REQUEST',
    );
    expect((await admin.query('SELECT notes FROM expense_category_policy WHERE category_id = $1', [betaMeals])).rows[0].notes).toBe(
      'Beta',
    );
  });
});

describe('tenancy and permissions', () => {
  it('keeps each tenant’s policies to itself', async () => {
    expect((await boss().policies.expensePolicy.list()).map((p) => p.categoryId)).not.toContain(betaMeals);
    expect((await boss().policies.expensePolicy.byCategory()).map((r) => r.category.id)).not.toContain(betaMeals);
  });

  it('refuses an employee', async () => {
    const emp = as('emp@alpha.test', A);
    expect(await codeOf(emp.policies.expensePolicy.byCategory())).toBe('FORBIDDEN');
    expect(await codeOf(emp.policies.expensePolicy.upsert({ categoryId: meals, patch: { receiptRequired: true } }))).toBe(
      'FORBIDDEN',
    );
  });
});
