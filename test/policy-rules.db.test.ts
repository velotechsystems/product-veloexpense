/**
 * w4-02b — ExpenseOS's policy-rule router (`policies.policyRule`), ported, against a real
 * database (migration 0064).
 *
 *   · a rule round-trips: the scope comes from its kind, an aggregate kind's absent
 *     condition is SQL NULL, the creator is recorded, and every write is audited
 *     (`POLICY_RULE_CHANGED`, the operation in `details.op`) into a chain that verifies;
 *   · `kinds` labels money in the organization's own policy currency (0015);
 *   · VeloExpense: what the table refuses — another tenant's scope or category, an end
 *     before the start, another tenant's role — is BAD_REQUEST, another tenant's rule is
 *     NOT_FOUND, and a job level a rule is scoped to cannot be deleted out from under it;
 *   · VeloExpense (w4-10c, d64): a rule scoped to a role is checked on the reports of the
 *     people who hold that role, and on nobody else's;
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
let betaRole: string;

const as = (email: string, organizationId: string) =>
  createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } });
const boss = () => as('boss@alpha.test', A);

const EMPLOYEE = '019e3000-0000-7000-8000-000000000004';
const EXECUTIVE = '019e3000-0000-7000-8000-000000000007';

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

/** A receipt threshold: an AGGREGATE kind (a built-in check, no condition) with one money param. */
const rule = (over: Record<string, unknown> = {}) => ({
  kindCode: 'RECEIPT_THRESHOLD',
  severity: 'WARNING' as const,
  params: { thresholdMinor: '2500' },
  messageKey: 'policy.receiptThreshold',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha PR', slug: 'alpha-pr', adminEmail: 'boss@alpha.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta PR', slug: 'beta-pr', adminEmail: 'boss@beta.test', adminName: 'Other' }))
    .organizationId;
  await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name, role_id) VALUES ($1, 'emp@alpha.test', 'Emp', '019e3000-0000-7000-8000-000000000004')`,
    [A],
  );
  const cat = async (org: string, code: string, label: string) =>
    (
      await admin.query(
        `INSERT INTO expense_category (organization_id, code, label) VALUES ($1, $2, jsonb_build_object('en', $3::text)) RETURNING id`,
        [org, code, label],
      )
    ).rows[0].id as string;
  meals = await cat(A, 'pr-meals', 'Meals');
  betaMeals = await cat(B, 'pr-meals', 'Beta meals');
  betaRole = (
    await admin.query(
      `INSERT INTO role (organization_id, label, permissions) VALUES ($1, '{"en":"Beta auditor"}', '{}') RETURNING id`,
      [B],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

describe('a rule', () => {
  it('round-trips, and every write is audited into a chain that verifies', async () => {
    const c = boss();
    const created = await c.policies.policyRule.create(rule({ categoryId: meals }));
    expect(created).toMatchObject({
      kindCode: 'RECEIPT_THRESHOLD',
      scope: 'AGGREGATE',
      severity: 'WARNING',
      condition: null,
      params: { thresholdMinor: '2500' },
      enabled: true,
      categoryId: meals,
      roleId: null,
      effectiveTo: null,
    });
    const me = (await admin.query(`SELECT id FROM app_user WHERE email = 'boss@alpha.test'`)).rows[0].id;
    const row = (await admin.query('SELECT created_by, condition, organization_id FROM policy_rule WHERE id = $1', [created.id]))
      .rows[0];
    expect(row).toEqual({ created_by: me, condition: null, organization_id: A });

    const updated = await c.policies.policyRule.update({
      id: created.id,
      patch: rule({ severity: 'BLOCK', enabled: false, effectiveTo: new Date('2026-12-31T00:00:00Z') }),
    });
    expect(updated).toMatchObject({ severity: 'BLOCK', enabled: false, categoryId: null });
    expect((await c.policies.policyRule.list()).map((r) => r.id)).toContain(created.id);

    await c.policies.policyRule.delete({ id: created.id });
    const audit = (
      await admin.query(
        `SELECT action, entity_type, details->>'op' AS op FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`,
        [created.id],
      )
    ).rows;
    expect(audit).toEqual([
      { action: 'POLICY_RULE_CHANGED', entity_type: 'PolicyRule', op: 'create' },
      { action: 'POLICY_RULE_CHANGED', entity_type: 'PolicyRule', op: 'update' },
      { action: 'POLICY_RULE_CHANGED', entity_type: 'PolicyRule', op: 'delete' },
    ]);
    expect((await admin.query('SELECT count(*)::int AS n FROM policy_rule WHERE id = $1', [created.id])).rows[0].n).toBe(0);
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });

  it('stores a predicate kind’s condition as written', async () => {
    const condition = { all: [{ field: 'lineAmount', op: 'gt', value: 50000 }] };
    const created = await boss().policies.policyRule.create(
      rule({ kindCode: 'PREDICATE_LINE', params: {}, messageKey: 'policy.generic', condition }),
    );
    expect(created).toMatchObject({ scope: 'LINE', condition });
    await boss().policies.policyRule.delete({ id: created.id });
  });

  it('labels money in the organization’s policy currency', async () => {
    await admin.query(`UPDATE organization SET policy_currency_code = 'USD' WHERE id = $1`, [A]);
    try {
      expect((await boss().policies.policyRule.kinds()).policyCurrency).toBe('USD');
      expect((await as('boss@beta.test', B).policies.policyRule.kinds()).policyCurrency).toBe('CAD');
    } finally {
      await admin.query(`UPDATE organization SET policy_currency_code = 'CAD' WHERE id = $1`, [A]);
    }
  });

  it('offers the tenant’s own scopes, its roles among them', async () => {
    const o = await boss().policies.policyRule.scopeOptions();
    expect(o.categories.map((c) => c.id)).toContain(meals);
    expect(o.categories.map((c) => c.id)).not.toContain(betaMeals);
    // VeloExpense (w4-10c): the tenant's six system roles, and not another tenant's.
    expect(o.roles.map((r) => r.id)).toContain(EMPLOYEE);
    expect(o.roles).toHaveLength(6);
    expect(o.roles.map((r) => r.id)).not.toContain(betaRole);
  });
});

describe('VeloExpense: what the table refuses is a 4xx', () => {
  it('refuses another tenant’s category, an end before the start, and another tenant’s role', async () => {
    const c = boss();
    const before = (await admin.query('SELECT count(*)::int AS n FROM policy_rule WHERE organization_id = $1', [A])).rows[0].n;
    expect(await codeOf(c.policies.policyRule.create(rule({ categoryId: betaMeals })))).toBe('BAD_REQUEST');
    expect(
      await codeOf(c.policies.policyRule.create(rule({ effectiveTo: new Date('2025-01-01T00:00:00Z') }))),
    ).toBe('BAD_REQUEST');
    expect(
      await codeOf(c.policies.policyRule.create(rule({ roleId: betaRole }))),
    ).toBe('BAD_REQUEST');
    expect((await admin.query('SELECT count(*)::int AS n FROM policy_rule WHERE organization_id = $1', [A])).rows[0].n).toBe(
      before,
    );
  });

  it('keeps a job level a rule is scoped to from being deleted out from under it', async () => {
    const c = boss();
    const level = await c.appSettings.jobLevels.create({ code: 'PR1', track: 'MANAGER', label: { en: 'Lead' } });
    const r = await c.policies.policyRule.create(rule({ jobLevelId: level.id }));
    expect(await codeOf(c.appSettings.jobLevels.delete({ id: level.id }))).toBe('BAD_REQUEST');
    expect((await admin.query('SELECT count(*)::int AS n FROM job_level WHERE id = $1', [level.id])).rows[0].n).toBe(1);
    await c.policies.policyRule.delete({ id: r.id });
  });
});

describe('tenancy and permissions', () => {
  it('keeps each tenant’s rules to itself; another tenant’s rule is NOT_FOUND', async () => {
    const beta = await as('boss@beta.test', B).policies.policyRule.create(rule({ categoryId: betaMeals }));
    expect((await boss().policies.policyRule.list()).map((r) => r.id)).not.toContain(beta.id);
    expect(await codeOf(boss().policies.policyRule.update({ id: beta.id, patch: rule({ severity: 'INFO' }) }))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(boss().policies.policyRule.delete({ id: beta.id }))).toBe('NOT_FOUND');
    expect((await admin.query('SELECT severity FROM policy_rule WHERE id = $1', [beta.id])).rows[0].severity).toBe('WARNING');
  });

  it('refuses an employee', async () => {
    const emp = as('emp@alpha.test', A);
    expect(await codeOf(emp.policies.policyRule.list())).toBe('FORBIDDEN');
    expect(await codeOf(emp.policies.policyRule.create(rule()))).toBe('FORBIDDEN');
  });
});

describe('VeloExpense: a rule scoped to a role (w4-10c, d64)', () => {
  /** An employee's report with one receiptless $60 meal, validated: the rules it broke (a v2
   *  finding's `rule_code` is the rule instance's id). */
  const employeeFindings = async () => {
    const expenses = as('emp@alpha.test', A).expenses;
    const report = await expenses.create({ title: 'role scope', currency: 'CAD' });
    const created = await expenses.createExpense({ reportId: report.id });
    await expenses.lineItemCreate({ expenseId: created.id, categoryId: meals, amountMinor: '6000' });
    await expenses.validate({ reportId: report.id });
    return (await admin.query(`SELECT rule_code FROM policy_violation WHERE report_id = $1`, [report.id])).rows.map(
      (r) => r.rule_code as string,
    );
  };

  it('is checked on the reports of the role’s holders, and nobody else’s', async () => {
    const c = boss();
    const executives = await c.policies.policyRule.create(rule({ roleId: EXECUTIVE }));
    expect(executives).toMatchObject({ roleId: EXECUTIVE });
    try {
      expect(await employeeFindings()).not.toContain(executives.id);
    } finally {
      await c.policies.policyRule.delete({ id: executives.id });
    }

    const employees = await c.policies.policyRule.create(rule({ roleId: EMPLOYEE }));
    try {
      expect(await employeeFindings()).toContain(employees.id);
    } finally {
      await c.policies.policyRule.delete({ id: employees.id });
    }
  });
});
