/**
 * Wave 1 — ExpenseOS's FX-rate router (`policies.fxRate`), ported, against a real
 * database (migration 0051).
 *
 * Proves what only Postgres can:
 *
 *   · append-only history: every add is kept, the newest per pair is "latest", and the
 *     history drawer reads one pair newest first;
 *   · the bounds: the ceiling, and the deviation bound with its reasoned override, each
 *     audited with the figures a reviewer needs;
 *   · VeloExpense: an unknown currency or a pair quoted against itself is BAD_REQUEST;
 *   · VeloExpense (d18): rates are PER TENANT — one tenant's add is invisible to another,
 *     and another tenant's conversions do not move;
 *   · VeloExpense's own readers keep working: `as_of` is the UTC day of `fetched_at`,
 *     and when a pair holds several rates in one day the newest is read first;
 *   · migration 0051's copy of the old global rows into every tenant, run as the APP
 *     role — RLS binds it exactly as it binds the RDS master login (f08).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
const { getPolicyCurrency } = await import('@/lib/policy/service');

const MIGRATION = readFileSync('prisma/migrations/0051_fx_rate_port/migration.sql', 'utf8');
/** Just the copy loop: the rest of 0051 has already run on this database. */
const COPY_LOOP = MIGRATION.slice(MIGRATION.indexOf('DO $$'), MIGRATION.indexOf('END $$;') + 'END $$;'.length);

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
const app = new Pool({ connectionString: process.env.DATABASE_URL });

let A: string;
let B: string;

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
  await admin.query(
    `INSERT INTO currency (code, name, minor_unit) VALUES ('EUR','Euro',2), ('CHF','Swiss Franc',2)
     ON CONFLICT (code) DO NOTHING`,
  );
  A = (await createOrganization({ name: 'Alpha FX', slug: 'alpha-fx', adminEmail: 'boss@alpha.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta FX', slug: 'beta-fx', adminEmail: 'boss@beta.test', adminName: 'Other' }))
    .organizationId;
  await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name, role) VALUES ($1, 'emp@alpha.test', 'Emp', 'EMPLOYEE')`,
    [A],
  );
});

afterAll(async () => {
  await admin.end();
  await app.end();
});

describe('append-only history', () => {
  it('keeps every add, reads the newest per pair as latest, and the pair’s history newest first', async () => {
    const c = boss();
    await c.policies.fxRate.add({ base: 'usd', quote: 'cad', rate: '1.3500' });
    await c.policies.fxRate.add({ base: 'USD', quote: 'CAD', rate: '1.3600' });
    await c.policies.fxRate.add({ base: 'EUR', quote: 'CAD', rate: '1.4700' });

    const latest = await c.policies.fxRate.latest();
    expect(latest.map((r) => [r.base, r.quote, r.rate])).toEqual(
      expect.arrayContaining([
        ['USD', 'CAD', '1.36'],
        ['EUR', 'CAD', '1.47'],
      ]),
    );
    expect(latest).toHaveLength(2);

    const history = await c.policies.fxRate.history({ base: 'usd', quote: 'cad' });
    expect(history.map((r) => r.rate)).toEqual(['1.36', '1.35']);
    expect(
      (await admin.query(`SELECT count(*)::int AS n FROM fx_rate WHERE organization_id = $1`, [A])).rows[0].n,
    ).toBe(3);
  });

  it('derives as_of as the UTC day of fetched_at, and VeloExpense’s readers take a day’s newest rate', async () => {
    const rows = (
      await admin.query(
        `SELECT fetched_at, as_of::text AS as_of FROM fx_rate WHERE organization_id = $1 AND base = 'USD'`,
        [A],
      )
    ).rows;
    for (const r of rows) expect(r.as_of).toBe((r.fetched_at as Date).toISOString().slice(0, 10));

    // The same query lib/policy, lib/budgets and lib/analytics run: the first USD->CAD
    // row is the one buildRateLookup keeps, and it is the newer of the day's two.
    const read = await withOrg(A, (tx) =>
      tx.query('SELECT base, quote, rate, as_of FROM fx_rate ORDER BY as_of DESC, fetched_at DESC'),
    );
    expect(read.rows.find((r) => r.base === 'USD' && r.quote === 'CAD')?.rate).toBe('1.36000000');
  });
});

describe('the bounds', () => {
  it('refuses a zero, an absurd rate and a malformed one', async () => {
    const c = boss();
    expect(await codeOf(c.policies.fxRate.add({ base: 'USD', quote: 'CAD', rate: '0' }))).toBe('BAD_REQUEST');
    expect(await codeOf(c.policies.fxRate.add({ base: 'USD', quote: 'CAD', rate: '1000001' }))).toBe('BAD_REQUEST');
    expect(await codeOf(c.policies.fxRate.add({ base: 'USD', quote: 'CAD', rate: '-1' }))).toBe('BAD_REQUEST');
  });

  it('refuses a move past the deviation bound without a reason, and takes it with one, on the record', async () => {
    const c = boss();
    const refused = await c.policies.fxRate.add({ base: 'USD', quote: 'CAD', rate: '0.7300' }).catch((e) => e);
    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect((refused as TRPCError).message).toMatch(/USD→CAD was last recorded at 1\.36/);

    await c.policies.fxRate.add({
      base: 'USD',
      quote: 'CAD',
      rate: '0.7300',
      confirmDeviation: true,
      reason: 'Correcting an inverted quote entered last week.',
    });
    const audit = (
      await admin.query(
        `SELECT action, entity_type, entity_id, details FROM audit_entry
          WHERE organization_id = $1 AND action = 'FX_RATE_ADDED' ORDER BY sequence DESC LIMIT 1`,
        [A],
      )
    ).rows[0];
    expect(audit).toMatchObject({
      action: 'FX_RATE_ADDED',
      // VeloExpense: no entity id (a rate has no uuid); the type and pair are in details.
      entity_type: null,
      entity_id: null,
      details: {
        entityType: 'FxRate',
        base: 'USD',
        quote: 'CAD',
        rate: '0.7300',
        priorRate: '1.36',
        deviationConfirmed: true,
        reason: 'Correcting an inverted quote entered last week.',
      },
    });
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });

  it('VeloExpense: refuses a currency the system does not know, and a pair quoted against itself', async () => {
    const c = boss();
    expect(await codeOf(c.policies.fxRate.add({ base: 'ZZZ', quote: 'CAD', rate: '1.2' }))).toBe('BAD_REQUEST');
    expect(await codeOf(c.policies.fxRate.add({ base: 'CAD', quote: 'CAD', rate: '1' }))).toBe('BAD_REQUEST');
  });
});

describe('VeloExpense: per tenant (d18)', () => {
  it('keeps one tenant’s rates from another, and another tenant’s conversions do not move', async () => {
    const before = await withOrg(B, (tx) => getPolicyCurrency(tx));
    await as('boss@beta.test', B).policies.fxRate.add({ base: 'CHF', quote: 'CAD', rate: '1.5500' });

    const alpha = await boss().policies.fxRate.latest();
    expect(alpha.map((r) => r.base)).not.toContain('CHF');
    const beta = await as('boss@beta.test', B).policies.fxRate.latest();
    expect(beta.map((r) => `${r.base}->${r.quote}`)).toEqual(['CHF->CAD']);

    // Alpha's many USD and EUR adds above never reached Beta's conversions.
    const after = await withOrg(B, (tx) => getPolicyCurrency(tx));
    expect(after.convertible).toEqual([...before.convertible, 'CHF->CAD'].sort());
    expect(after.convertible).not.toContain('EUR->CAD');
  });

  it('refuses an employee', async () => {
    const emp = as('emp@alpha.test', A);
    expect(await codeOf(emp.policies.fxRate.latest())).toBe('FORBIDDEN');
    expect(await codeOf(emp.policies.fxRate.add({ base: 'USD', quote: 'CAD', rate: '1.36' }))).toBe('FORBIDDEN');
  });
});

describe('migration 0051: the old global rows are copied into every tenant', () => {
  it('copies each row into each tenant at 00:00 UTC on its old date, under RLS, as the migration role is on RDS', async () => {
    await admin.query(`CREATE TABLE fx_rate_0015 (
        base text, quote text, rate numeric(18,8), as_of date, source text, created_at timestamptz DEFAULT now())`);
    try {
      await admin.query('GRANT SELECT ON fx_rate_0015 TO veloapp');
      await admin.query(
        `INSERT INTO fx_rate_0015 (base, quote, rate, as_of, source)
         VALUES ('EUR','USD',1.08,'2024-03-15','MANUAL'), ('USD','CHF',0.9,'2024-03-16','SEED')`,
      );
      // Without a tenant scope, RLS refuses the app role's insert — the trap.
      await expect(
        app.query(
          `INSERT INTO fx_rate (organization_id, base, quote, rate) VALUES ($1, 'EUR', 'USD', 1)`,
          [A],
        ),
      ).rejects.toThrow(/row-level security/);

      await app.query(COPY_LOOP);
      for (const org of [A, B]) {
        const copied = (
          await admin.query(
            `SELECT base, quote, rate::text, fetched_at, as_of::text AS as_of, source FROM fx_rate
              WHERE organization_id = $1 AND fetched_at < '2025-01-01' ORDER BY fetched_at`,
            [org],
          )
        ).rows;
        expect(copied).toEqual([
          { base: 'EUR', quote: 'USD', rate: '1.08000000', fetched_at: new Date('2024-03-15T00:00:00Z'), as_of: '2024-03-15', source: 'MANUAL' },
          { base: 'USD', quote: 'CHF', rate: '0.90000000', fetched_at: new Date('2024-03-16T00:00:00Z'), as_of: '2024-03-16', source: 'SEED' },
        ]);
      }
    } finally {
      await admin.query('DROP TABLE IF EXISTS fx_rate_0015');
      await admin.query(`DELETE FROM fx_rate WHERE fetched_at < '2025-01-01'`);
    }
  });
});
