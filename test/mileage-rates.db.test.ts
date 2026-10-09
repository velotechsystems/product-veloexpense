/**
 * Wave 1 — ExpenseOS's mileage-rate router (`policies.mileageRate`), ported, against a
 * real database (migration 0052).
 *
 * The screen's tests cover what the drawer sends; this proves what the router and the
 * tables do with it:
 *
 *   · a rule round-trips with its bands and the people it covers (the display name in
 *     ExpenseOS's first/last shape);
 *   · SUCCESSION: a new rule for the same scope closes the incumbent at its start and
 *     records the successor, in one transaction; a start on or before the incumbent's is
 *     refused; a country default and a car allowance coexist, and an allowance only
 *     supersedes the allowance covering the same person;
 *   · the bands: the first must start at 0, no two may share a bound, and (VeloExpense)
 *     no rate may be negative — the tables refuse the same;
 *   · retire and delete, including the delete guard ExpenseOS keeps for a rule a claim
 *     was priced under, read off `expense_line_item.mileage_rate_id`;
 *   · VeloExpense: another tenant's person, rule or GL account, and a non-postable
 *     account, are refused as BAD_REQUEST or NOT_FOUND rather than as a 500; the delete
 *     is audited; the chain verifies;
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
let driver: string;
let otherDriver: string;
let betaPerson: string;

const as = (email: string, organizationId: string) =>
  createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } });
const boss = () => as('boss@alpha.test', A);

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

const rule = (over: Record<string, unknown> = {}) => ({
  country: 'CA',
  unit: 'KM' as const,
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  tiers: [{ fromDistance: 0, rateMinor: 72 }],
  ...over,
});

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha MR', slug: 'alpha-mr', adminEmail: 'boss@alpha.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta MR', slug: 'beta-mr', adminEmail: 'boss@beta.test', adminName: 'Other' }))
    .organizationId;
  // A GL account is visible only with the accounting module on (0022's backstop in
  // gl_account's policy), so both tenants have it.
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled) VALUES ($1,'accounting',true), ($2,'accounting',true)`,
    [A, B],
  );
  const ins = async (org: string, email: string, name: string, role = 'EMPLOYEE') =>
    (
      await admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
        [org, email, name, role],
      )
    ).rows[0].id as string;
  driver = await ins(A, 'driver@alpha.test', 'Dana Driver');
  otherDriver = await ins(A, 'other@alpha.test', 'Omar Other');
  betaPerson = await ins(B, 'person@beta.test', 'Bea Beta');
});

afterAll(async () => {
  await admin.end();
});

describe('a rule', () => {
  it('round-trips with its bands and the people it covers', async () => {
    const c = boss();
    const { id } = await c.policies.mileageRate.create(
      rule({
        country: 'US',
        unit: 'MI',
        subjectUserIds: [driver],
        tiers: [
          { fromDistance: 5000, rateMinor: 60 },
          { fromDistance: 0, rateMinor: 70 },
        ],
      }),
    );
    const row = (await c.policies.mileageRate.list()).find((r) => r.id === id);
    expect(row).toMatchObject({
      country: 'US',
      unit: 'MI',
      effectiveTo: null,
      supersededById: null,
      tiers: [
        { fromDistance: '0', rateMinor: '70' },
        { fromDistance: '5000', rateMinor: '60' },
      ],
      // VeloExpense: one display name, in ExpenseOS's first/last shape.
      subjects: [{ userId: driver, user: { firstName: 'Dana Driver', lastName: null, email: 'driver@alpha.test' } }],
    });
  });
});

describe('succession', () => {
  it('closes the incumbent at the new rule’s start and records the successor', async () => {
    const c = boss();
    const first = await c.policies.mileageRate.create(rule());
    const second = await c.policies.mileageRate.create(
      rule({ effectiveFrom: new Date('2027-01-01T00:00:00Z'), tiers: [{ fromDistance: 0, rateMinor: 75 }] }),
    );
    const old = (await admin.query('SELECT effective_to, superseded_by_id FROM mileage_rate WHERE id = $1', [first.id]))
      .rows[0];
    expect(old.effective_to.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(old.superseded_by_id).toBe(second.id);

    const audit = (
      await admin.query(`SELECT action, details FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`, [second.id])
    ).rows;
    expect(audit).toEqual([
      { action: 'MILEAGE_RATE_CHANGED', details: { country: 'CA', subjects: 0, supersedes: [first.id] } },
    ]);
  });

  it('refuses a start on or before the rule it would supersede', async () => {
    expect(
      await codeOf(boss().policies.mileageRate.create(rule({ effectiveFrom: new Date('2026-06-01T00:00:00Z') }))),
    ).toBe('BAD_REQUEST');
  });

  it('lets a car allowance coexist with the country default, and supersedes only the same person’s', async () => {
    const c = boss();
    const dana = await c.policies.mileageRate.create(rule({ country: 'FR', subjectUserIds: [driver] }));
    const omar = await c.policies.mileageRate.create(rule({ country: 'FR', subjectUserIds: [otherDriver] }));
    const frDefault = await c.policies.mileageRate.create(rule({ country: 'FR' }));
    const danaNew = await c.policies.mileageRate.create(
      rule({ country: 'FR', subjectUserIds: [driver], effectiveFrom: new Date('2026-03-01T00:00:00Z') }),
    );
    const state = Object.fromEntries(
      (
        await admin.query('SELECT id, superseded_by_id FROM mileage_rate WHERE id = ANY($1::uuid[])', [
          [dana.id, omar.id, frDefault.id],
        ])
      ).rows.map((r) => [r.id, r.superseded_by_id]),
    );
    expect(state).toEqual({ [dana.id]: danaNew.id, [omar.id]: null, [frDefault.id]: null });
  });
});

describe('the bands', () => {
  it('refuses a first band above 0, two bands with one bound, and (VeloExpense) a negative rate', async () => {
    const c = boss();
    const at = { country: 'DE', effectiveFrom: new Date('2026-01-01T00:00:00Z') };
    expect(await codeOf(c.policies.mileageRate.create(rule({ ...at, tiers: [{ fromDistance: 10, rateMinor: 5 }] })))).toBe(
      'BAD_REQUEST',
    );
    expect(
      await codeOf(
        c.policies.mileageRate.create(
          rule({
            ...at,
            tiers: [
              { fromDistance: 0, rateMinor: 5 },
              { fromDistance: 0, rateMinor: 4 },
            ],
          }),
        ),
      ),
    ).toBe('BAD_REQUEST');
    expect(await codeOf(c.policies.mileageRate.create(rule({ ...at, tiers: [{ fromDistance: 0, rateMinor: -1 }] })))).toBe(
      'BAD_REQUEST',
    );
    expect((await admin.query(`SELECT count(*)::int AS n FROM mileage_rate WHERE country = 'DE'`)).rows[0].n).toBe(0);

    const r = (await admin.query(`SELECT id FROM mileage_rate WHERE organization_id = $1 LIMIT 1`, [A])).rows[0].id;
    await expect(
      admin.query(`INSERT INTO mileage_rate_tier (organization_id, rate_id, from_distance, rate_minor) VALUES ($1,$2,99,-5)`, [
        A,
        r,
      ]),
    ).rejects.toThrow(/mileage_rate_tier_rate_nonnegative/);
    await expect(
      admin.query(`INSERT INTO mileage_rate (organization_id, country, unit, effective_from) VALUES ($1,'CA','MILES',now())`, [A]),
    ).rejects.toThrow(/mileage_rate_unit/);
  });
});

describe('retire and delete', () => {
  it('retires a rule, but not one already superseded or before it starts', async () => {
    const c = boss();
    const it = await c.policies.mileageRate.create(rule({ country: 'GB' }));
    expect(
      await codeOf(c.policies.mileageRate.retire({ id: it.id, effectiveTo: new Date('2025-12-31T00:00:00Z') })),
    ).toBe('BAD_REQUEST');
    await c.policies.mileageRate.retire({ id: it.id, effectiveTo: new Date('2026-12-31T00:00:00Z') });
    expect(
      (await admin.query('SELECT effective_to FROM mileage_rate WHERE id = $1', [it.id])).rows[0].effective_to.toISOString(),
    ).toBe('2026-12-31T00:00:00.000Z');

    const superseded = (await admin.query(`SELECT id FROM mileage_rate WHERE superseded_by_id IS NOT NULL LIMIT 1`)).rows[0]
      .id;
    expect(
      await codeOf(c.policies.mileageRate.retire({ id: superseded, effectiveTo: new Date('2030-01-01T00:00:00Z') })),
    ).toBe('BAD_REQUEST');
  });

  it('refuses to delete a rule a claim was priced under, deletes one nothing used, and audits it', async () => {
    const c = boss();
    const used = await c.policies.mileageRate.create(rule({ country: 'IE' }));
    const spare = await c.policies.mileageRate.create(rule({ country: 'NL' }));
    await withOrg(A, async (tx) => {
      const boss = (await tx.query(`SELECT id FROM app_user WHERE email = 'boss@alpha.test'`)).rows[0].id;
      const cat = (
        await tx.query(`INSERT INTO expense_category (organization_id, code, label) VALUES ($1, 'mileage', '{"en":"Mileage"}') RETURNING id`, [A])
      ).rows[0].id;
      const rep = (
        await tx.query(
          `INSERT INTO expense_report (organization_id, title, currency_code, submitter_id) VALUES ($1, 'Trip', 'CAD', $2) RETURNING id`,
          [A, boss],
        )
      ).rows[0].id;
      const exp = (
        await tx.query(`INSERT INTO expense (organization_id, report_id, currency_code) VALUES ($1, $2, 'CAD') RETURNING id`, [
          A,
          rep,
        ])
      ).rows[0].id;
      await tx.query(
        `INSERT INTO expense_line_item (organization_id, expense_id, category_id, amount_minor, mileage_rate_id)
         VALUES ($1, $2, $3, 7200, $4)`,
        [A, exp, cat, used.id],
      );
    });
    expect(await codeOf(c.policies.mileageRate.delete({ id: used.id }))).toBe('BAD_REQUEST');

    expect(await c.policies.mileageRate.delete({ id: spare.id })).toEqual({ ok: true });
    expect((await admin.query('SELECT count(*)::int AS n FROM mileage_rate WHERE id = $1', [spare.id])).rows[0].n).toBe(0);
    const audit = (
      await admin.query(`SELECT action, details ->> 'country' AS country FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`, [
        spare.id,
      ])
    ).rows;
    expect(audit).toEqual([
      { action: 'MILEAGE_RATE_CHANGED', country: 'NL' },
      { action: 'MILEAGE_RATE_DELETED', country: 'NL' },
    ]);
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });
});

describe('VeloExpense: references are the tenant’s own', () => {
  it('refuses another tenant’s person and GL account, and a non-postable account', async () => {
    const c = boss();
    expect(await codeOf(c.policies.mileageRate.create(rule({ country: 'IT', subjectUserIds: [betaPerson] })))).toBe(
      'BAD_REQUEST',
    );
    const betaAccount = (
      await admin.query(
        `INSERT INTO gl_account (organization_id, number, name, type) VALUES ($1, '6810', 'Beta mileage', 'expense') RETURNING id`,
        [B],
      )
    ).rows[0].id;
    expect(await codeOf(c.policies.mileageRate.create(rule({ country: 'IT', glAccountId: betaAccount })))).toBe('BAD_REQUEST');
    const header = (
      await admin.query(
        `INSERT INTO gl_account (organization_id, number, name, type, is_postable) VALUES ($1, '6800', 'Travel header', 'expense', false) RETURNING id`,
        [A],
      )
    ).rows[0].id;
    expect(await codeOf(c.policies.mileageRate.create(rule({ country: 'IT', glAccountId: header })))).toBe('BAD_REQUEST');
    const own = (
      await admin.query(
        `INSERT INTO gl_account (organization_id, number, name, type) VALUES ($1, '6810', 'Mileage', 'expense') RETURNING id`,
        [A],
      )
    ).rows[0].id;
    const ok = await c.policies.mileageRate.create(rule({ country: 'IT', glAccountId: own }));
    expect((await admin.query('SELECT gl_account_id FROM mileage_rate WHERE id = $1', [ok.id])).rows[0].gl_account_id).toBe(own);
  });

  it('keeps each tenant’s rules to itself; another tenant’s rule is NOT_FOUND', async () => {
    const beta = await as('boss@beta.test', B).policies.mileageRate.create(rule());
    expect((await boss().policies.mileageRate.list()).map((r) => r.id)).not.toContain(beta.id);
    expect(await codeOf(boss().policies.mileageRate.retire({ id: beta.id, effectiveTo: new Date('2027-01-01T00:00:00Z') }))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(boss().policies.mileageRate.delete({ id: beta.id }))).toBe('NOT_FOUND');
  });

  it('refuses an employee', async () => {
    const emp = as('driver@alpha.test', A);
    expect(await codeOf(emp.policies.mileageRate.list())).toBe('FORBIDDEN');
    expect(await codeOf(emp.policies.mileageRate.create(rule({ country: 'ES' })))).toBe('FORBIDDEN');
  });
});
