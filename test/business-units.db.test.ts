/**
 * Wave 1 — ExpenseOS's business-unit router (its admin-lookup factory), ported, against a
 * real database.
 *
 * `server/routers/adminLookup.test.ts` is ExpenseOS's unit suite (a stub `db`, a mocked
 * `withAudit`). This one proves what only Postgres can:
 *
 *   · create / update / setActive write into VeloExpense's per-tenant audit chain, under
 *     the registry's names, and the chain still verifies;
 *   · migration 0047's shape: `label` is `{ en }` JSON, an English-only name and a
 *     one-language description save (French is off), and the English name stays unique
 *     per tenant — a duplicate is a CONFLICT, not a 500;
 *   · External IDs: the alias rows and the tenant's own source are written, replaced and
 *     read back as `{ code: value }`, and one outside id cannot name two units;
 *   · tenancy: a tenant neither lists nor edits another's units, and sources are per
 *     tenant (the same code in two tenants is two rows);
 *   · permissions: an employee is refused, and a refused write leaves nothing behind.
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

const as = (email: string, organizationId: string) =>
  createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } });

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

const auditRows = async (org: string) =>
  (
    await admin.query(
      `SELECT action, entity_type, entity_id, actor_role, details
         FROM audit_entry WHERE organization_id = $1 AND action LIKE 'BUSINESS_UNIT_%'
        ORDER BY sequence`,
      [org],
    )
  ).rows;

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha BU', slug: 'alpha-bu', adminEmail: 'boss@alpha.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta BU', slug: 'beta-bu', adminEmail: 'boss@beta.test', adminName: 'Other' }))
    .organizationId;
  await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name, role) VALUES ($1, 'emp@alpha.test', 'Emp', 'EMPLOYEE')`,
    [A],
  );
});

afterAll(async () => {
  await admin.end();
});

describe('create', () => {
  it('saves an English-only name and a one-language description, audited into a chain that verifies', async () => {
    const created = (await as('boss@alpha.test', A).businessUnits.create({
      label: { en: 'Atlantic', 'fr-CA': '' },
      description: { en: 'Maritime branches', 'fr-CA': '' },
      externalIds: {},
      active: true,
    })) as { id: string; label: unknown; description: unknown; externalIds: unknown; active: boolean };
    expect(created.label).toEqual({ en: 'Atlantic' });
    expect(created.description).toEqual({ en: 'Maritime branches' });
    expect(created.externalIds).toEqual({});
    expect(created.active).toBe(true);

    const row = (await admin.query('SELECT organization_id, label, description FROM business_unit WHERE id = $1', [created.id]))
      .rows[0];
    expect(row.organization_id).toBe(A);
    expect(row.label).toEqual({ en: 'Atlantic' });

    expect(await auditRows(A)).toEqual([
      {
        action: 'BUSINESS_UNIT_CREATED',
        // ExpenseOS's factory derives it from "Business unit" by removing the space.
        entity_type: 'Businessunit',
        entity_id: created.id,
        actor_role: 'ADMIN',
        details: { label: { en: 'Atlantic' } },
      },
    ]);
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });

  it('answers a duplicate English name with CONFLICT, whatever its case and spacing', async () => {
    await as('boss@alpha.test', A).businessUnits.create({ label: { en: 'Pacific' } });
    expect(await codeOf(as('boss@alpha.test', A).businessUnits.create({ label: { en: '  pacific ' } }))).toBe('CONFLICT');
    // Another tenant's "Pacific" is its own.
    expect(await codeOf(as('boss@beta.test', B).businessUnits.create({ label: { en: 'Pacific' } }))).toBe('OK');
  });

  it('refuses a name with no English, and the table refuses one too', async () => {
    expect(await codeOf(as('boss@alpha.test', A).businessUnits.create({ label: { en: '', 'fr-CA': 'Ouest' } }))).toBe(
      'BAD_REQUEST',
    );
    await expect(
      admin.query(`INSERT INTO business_unit (organization_id, label) VALUES ($1, '{"fr-CA":"Ouest"}')`, [A]),
    ).rejects.toThrow(/business_unit_label_en/);
  });
});

describe('external IDs', () => {
  it('writes the aliases and the tenant’s own sources, and reads them back as a map', async () => {
    const c = as('boss@alpha.test', A);
    const bu = (await c.businessUnits.create({
      label: { en: 'Prairies' },
      externalIds: { ledger: 'BU-100', payroll: 'P-7' },
    })) as { id: string; externalIds: unknown };
    expect(bu.externalIds).toEqual({ ledger: 'BU-100', payroll: 'P-7' });

    const sources = (
      await admin.query('SELECT code, label FROM external_id_source WHERE organization_id = $1 ORDER BY code', [A])
    ).rows;
    expect(sources).toEqual([
      { code: 'ledger', label: { en: 'ledger', 'fr-CA': 'ledger' } },
      { code: 'payroll', label: { en: 'payroll', 'fr-CA': 'payroll' } },
    ]);
    // The picker offers them.
    expect(await c.pickers.externalIdSources()).toEqual([
      { code: 'ledger', label: { en: 'ledger', 'fr-CA': 'ledger' } },
      { code: 'payroll', label: { en: 'payroll', 'fr-CA': 'payroll' } },
    ]);

    // Replaced, not merged: the map is the whole truth.
    const updated = (await c.businessUnits.update({ id: bu.id, patch: { externalIds: { ledger: 'BU-101' } } })) as {
      externalIds: unknown;
    };
    expect(updated.externalIds).toEqual({ ledger: 'BU-101' });
    const listed = (await c.businessUnits.list({ includeInactive: true })).items.find((r) => r.id === bu.id);
    expect(listed?.externalIds).toEqual({ ledger: 'BU-101' });
  });

  it('keeps sources per tenant: the same code in another tenant is another row', async () => {
    await as('boss@beta.test', B).businessUnits.create({ label: { en: 'Prairies' }, externalIds: { ledger: 'BU-100' } });
    const n = (await admin.query("SELECT count(*)::int AS n FROM external_id_source WHERE code = 'ledger'")).rows[0].n;
    expect(n).toBe(2);
    // Beta's picker sees only Beta's.
    expect(await as('boss@beta.test', B).pickers.externalIdSources()).toEqual([
      { code: 'ledger', label: { en: 'ledger', 'fr-CA': 'ledger' } },
    ]);
  });

  it('refuses one outside id for two units, and keeps the first unit’s', async () => {
    const c = as('boss@alpha.test', A);
    await c.businessUnits.create({ label: { en: 'North' }, externalIds: { ledger: 'BU-200' } });
    expect(await codeOf(c.businessUnits.create({ label: { en: 'Far North' }, externalIds: { ledger: 'BU-200' } }))).toBe(
      'CONFLICT',
    );
    // The refused create rolled back: no unit, no alias, no audit row.
    expect(
      (await admin.query(`SELECT count(*)::int AS n FROM business_unit WHERE label ->> 'en' = 'Far North'`)).rows[0].n,
    ).toBe(0);
    expect(
      (await auditRows(A)).filter((r) => (r.details as { label?: { en?: string } })?.label?.en === 'Far North'),
    ).toEqual([]);
  });
});

describe('update and setActive', () => {
  it('updates, deactivates and reactivates, each audited under its own name', async () => {
    const c = as('boss@alpha.test', A);
    const bu = (await c.businessUnits.create({ label: { en: 'Central' } })) as { id: string };
    await c.businessUnits.update({ id: bu.id, patch: { label: { en: 'Central Canada' } } });
    await c.businessUnits.setActive({ id: bu.id, active: false });
    expect((await c.businessUnits.list()).items.map((r) => r.id)).not.toContain(bu.id);
    expect((await c.businessUnits.list({ includeInactive: true })).items.map((r) => r.id)).toContain(bu.id);
    await c.businessUnits.setActive({ id: bu.id, active: true });

    const mine = (await auditRows(A)).filter((r) => r.entity_id === bu.id);
    expect(mine.map((r) => [r.action, r.details])).toEqual([
      ['BUSINESS_UNIT_CREATED', { label: { en: 'Central' } }],
      ['BUSINESS_UNIT_UPDATED', { changedFields: ['label'] }],
      ['BUSINESS_UNIT_DEACTIVATED', { active: false }],
      ['BUSINESS_UNIT_UPDATED', { active: true }],
    ]);
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });

  it('clears a description sent with no text left in it', async () => {
    const c = as('boss@alpha.test', A);
    const bu = (await c.businessUnits.create({ label: { en: 'Quebec' }, description: { en: 'QC' } })) as { id: string };
    await c.businessUnits.update({ id: bu.id, patch: { description: { en: ' ', 'fr-CA': '' } } });
    // ExpenseOS writes JSON null (`Prisma.JsonNull`); either way there is no description.
    const d = (await admin.query('SELECT description, jsonb_typeof(description) AS t FROM business_unit WHERE id = $1', [bu.id]))
      .rows[0];
    expect(d.description).toBeNull();
    expect([null, 'null']).toContain(d.t);
  });
});

describe('tenancy and permissions', () => {
  it('lists only the tenant’s own units, and cannot edit another’s', async () => {
    const betaId = (await admin.query(`SELECT id FROM business_unit WHERE organization_id = $1 LIMIT 1`, [B])).rows[0].id;
    const alphaList = (await as('boss@alpha.test', A).businessUnits.list({ includeInactive: true })).items;
    expect(alphaList.map((r) => r.id)).not.toContain(betaId);
    expect(
      await codeOf(as('boss@alpha.test', A).businessUnits.update({ id: betaId, patch: { label: { en: 'Hijacked' } } })),
    ).toBe('NOT_FOUND');
    expect(await codeOf(as('boss@alpha.test', A).businessUnits.setActive({ id: betaId, active: false }))).not.toBe('OK');
    expect((await admin.query('SELECT label, active FROM business_unit WHERE id = $1', [betaId])).rows[0].active).toBe(true);
  });

  it('refuses an employee, and the refusal writes nothing', async () => {
    const before = (await admin.query('SELECT count(*)::int AS n FROM business_unit')).rows[0].n;
    expect(await codeOf(as('emp@alpha.test', A).businessUnits.list())).toBe('FORBIDDEN');
    expect(await codeOf(as('emp@alpha.test', A).businessUnits.create({ label: { en: 'Rogue' } }))).toBe('FORBIDDEN');
    expect((await admin.query('SELECT count(*)::int AS n FROM business_unit')).rows[0].n).toBe(before);
  });
});
