/**
 * Wave 1 — ExpenseOS's per-diem-rate router (`policies.perDiemRate`), ported, against a
 * real database (migration 0053).
 *
 *   · a rate round-trips with its scopes, the cap as a minor-unit string, and the
 *     currency as its ISO code (VeloExpense keys a currency by it);
 *   · `options` lists the tenant's own active categories, levels, entities and units,
 *     and the currencies in ExpenseOS's `{ id, code, symbol }` shape;
 *   · VeloExpense: every write is audited (ExpenseOS's are not), into a chain that verifies;
 *   · VeloExpense: what the table refuses — another tenant's category or scope, an end
 *     before the start, a negative cap, a lowercase country — is BAD_REQUEST, another
 *     tenant's rate is NOT_FOUND, and a job level a rate is scoped to cannot be deleted
 *     out from under it (BAD_REQUEST, not a 500);
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
let lodging: string;
let betaMeals: string;

const as = (email: string, organizationId: string) =>
  createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } });
const boss = () => as('boss@alpha.test', A);

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

const rate = (over: Record<string, unknown> = {}) => ({
  country: 'CA',
  city: 'Toronto',
  categoryId: meals,
  amountMinor: 7500,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha PD', slug: 'alpha-pd', adminEmail: 'boss@alpha.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta PD', slug: 'beta-pd', adminEmail: 'boss@beta.test', adminName: 'Other' }))
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
  meals = await cat(A, 'pd-meals', 'Per-diem meals');
  lodging = await cat(A, 'pd-lodging', 'Per-diem lodging');
  betaMeals = await cat(B, 'pd-meals', 'Beta meals');
});

afterAll(async () => {
  await admin.end();
});

describe('a rate', () => {
  it('round-trips with its scopes, and every write is audited into a chain that verifies', async () => {
    const c = boss();
    const level = await c.appSettings.jobLevels.create({ code: 'D1', track: 'MANAGER', label: { en: 'Director' } });
    const created = await c.policies.perDiemRate.create(
      rate({ jobLevelId: level.id, currencyId: 'USD', firstLastDay: true, amountMinor: '12550' }),
    );
    expect(created).toMatchObject({
      country: 'CA',
      city: 'Toronto',
      categoryId: meals,
      amountMinor: '12550',
      firstLastDay: true,
      jobLevelId: level.id,
      currencyId: 'USD',
      effectiveTo: null,
    });
    expect(
      (await admin.query('SELECT currency_code FROM per_diem_rate WHERE id = $1', [created.id])).rows[0].currency_code,
    ).toBe('USD');

    const updated = await c.policies.perDiemRate.update({
      id: created.id,
      patch: { categoryId: lodging, effectiveTo: new Date('2026-12-31T00:00:00Z'), currencyId: null },
    });
    expect(updated).toMatchObject({ categoryId: lodging, currencyId: null });
    expect((await c.policies.perDiemRate.list()).map((r) => r.id)).toContain(created.id);

    await c.policies.perDiemRate.delete({ id: created.id });
    const audit = (
      await admin.query(`SELECT action, entity_type FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`, [created.id])
    ).rows;
    expect(audit).toEqual([
      { action: 'PER_DIEM_RATE_CREATED', entity_type: 'PerDiemRate' },
      { action: 'PER_DIEM_RATE_UPDATED', entity_type: 'PerDiemRate' },
      { action: 'PER_DIEM_RATE_DELETED', entity_type: 'PerDiemRate' },
    ]);
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });

  it('lists the tenant’s own options, and the currencies in ExpenseOS’s shape', async () => {
    const o = await boss().policies.perDiemRate.options();
    expect(o.categories.map((c) => c.id)).toEqual(expect.arrayContaining([meals, lodging]));
    expect(o.categories.map((c) => c.id)).not.toContain(betaMeals);
    expect(o.jobLevels.map((j) => j.code)).toContain('D1');
    expect(o.currencies).toEqual(
      expect.arrayContaining([
        { id: 'CAD', code: 'CAD', symbol: '$' },
        { id: 'USD', code: 'USD', symbol: '$' },
      ]),
    );
  });
});

describe('VeloExpense: what the table refuses is a 4xx', () => {
  it('refuses another tenant’s category, an unknown currency, an end before the start, a negative cap, a lowercase country', async () => {
    const c = boss();
    expect(await codeOf(c.policies.perDiemRate.create(rate({ categoryId: betaMeals })))).toBe('BAD_REQUEST');
    expect(await codeOf(c.policies.perDiemRate.create(rate({ currencyId: 'ZZZ' })))).toBe('BAD_REQUEST');
    expect(
      await codeOf(c.policies.perDiemRate.create(rate({ effectiveTo: new Date('2025-01-01T00:00:00Z') }))),
    ).toBe('BAD_REQUEST');
    expect(await codeOf(c.policies.perDiemRate.create(rate({ amountMinor: -1 })))).toBe('BAD_REQUEST');
    expect(await codeOf(c.policies.perDiemRate.create(rate({ country: 'ca' })))).toBe('BAD_REQUEST');
    expect((await admin.query('SELECT count(*)::int AS n FROM per_diem_rate WHERE organization_id = $1', [A])).rows[0].n).toBe(0);
  });

  it('f69: refuses the same on an UPDATE', async () => {
    const c = boss();
    const r = await c.policies.perDiemRate.create(rate());
    expect(
      await codeOf(c.policies.perDiemRate.update({ id: r.id, patch: { effectiveTo: new Date('2025-01-01T00:00:00Z') } })),
    ).toBe('BAD_REQUEST');
    expect(await codeOf(c.policies.perDiemRate.update({ id: r.id, patch: { amountMinor: -1 } }))).toBe('BAD_REQUEST');
    await c.policies.perDiemRate.delete({ id: r.id });
  });

  it('keeps a job level a rate is scoped to from being deleted out from under it', async () => {
    const c = boss();
    const level = await c.appSettings.jobLevels.create({ code: 'VP1', track: 'EXECUTIVE', label: { en: 'VP' } });
    await c.policies.perDiemRate.create(rate({ jobLevelId: level.id }));
    expect(await codeOf(c.appSettings.jobLevels.delete({ id: level.id }))).toBe('BAD_REQUEST');
    expect((await admin.query('SELECT count(*)::int AS n FROM job_level WHERE id = $1', [level.id])).rows[0].n).toBe(1);
  });
});

describe('tenancy and permissions', () => {
  it('keeps each tenant’s rates to itself; another tenant’s rate is NOT_FOUND', async () => {
    const beta = await as('boss@beta.test', B).policies.perDiemRate.create(rate({ categoryId: betaMeals, city: 'Montreal' }));
    expect((await boss().policies.perDiemRate.list()).map((r) => r.id)).not.toContain(beta.id);
    expect(await codeOf(boss().policies.perDiemRate.update({ id: beta.id, patch: { city: 'Stolen' } }))).toBe('NOT_FOUND');
    expect(await codeOf(boss().policies.perDiemRate.delete({ id: beta.id }))).toBe('NOT_FOUND');
    expect((await admin.query('SELECT city FROM per_diem_rate WHERE id = $1', [beta.id])).rows[0].city).toBe('Montreal');
  });

  it('refuses an employee', async () => {
    const emp = as('emp@alpha.test', A);
    expect(await codeOf(emp.policies.perDiemRate.list())).toBe('FORBIDDEN');
    expect(await codeOf(emp.policies.perDiemRate.create(rate()))).toBe('FORBIDDEN');
  });
});
