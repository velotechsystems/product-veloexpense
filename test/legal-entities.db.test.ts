/**
 * Wave 1 — ExpenseOS's legal-entity router (its admin-lookup factory with country, home
 * currency and ITC recoverability), ported, against a real database.
 *
 * `server/routers/adminLookup.test.ts` covers the factory's rules with a stub `db`, and
 * test/business-units.db.test.ts proves them against Postgres for business units. This
 * covers what legal entities add:
 *
 *   · the extra fields round-trip: country, the home currency (VeloExpense keys a
 *     currency by its ISO code, so `homeCurrencyId` IS the code) and `itcRecoverable`,
 *     which defaults to true as in ExpenseOS;
 *   · what the router and the table refuse: a lowercase country, a currency the system
 *     has no row for;
 *   · the currency picker's list (`appSettings.currencies.list`) in ExpenseOS's shape;
 *   · External IDs on legal entities, on the tenant's own sources;
 *   · audit rows under the registry's names, and the chain still verifies;
 *   · migration 0048's country clean-up, run as the APP role — RLS binds it exactly as
 *     it binds the RDS master login (f08), so this proves the per-tenant loop works there.
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

const MIGRATION = readFileSync('prisma/migrations/0048_legal_entity_port/migration.sql', 'utf8');
/** Just the country clean-up loop: the rest of 0048 has already run on this database. */
const COUNTRY_LOOP = MIGRATION.slice(MIGRATION.indexOf('DO $$'), MIGRATION.indexOf('END $$;') + 'END $$;'.length);

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
const app = new Pool({ connectionString: process.env.DATABASE_URL });

let A: string;
let B: string;

const as = (email: string, organizationId: string) =>
  createCallerFactory(appRouter)({ session: null, db, rbac: null, caller: { email, organizationId } });

/** The factory's create/update input types leave out per-entity fields (ExpenseOS's own
 *  callers cast for the same reason); the router validates and takes them. */
type LooseLookup = {
  create: (input: Record<string, unknown>) => Promise<unknown>;
  update: (input: { id: string; patch: Record<string, unknown> }) => Promise<unknown>;
};
const les = (c: ReturnType<typeof as>) => c.legalEntities as unknown as LooseLookup;

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof TRPCError ? e.code : String(e)),
  );

type Row = {
  id: string;
  label: unknown;
  country: string | null;
  homeCurrencyId: string | null;
  homeCurrency: { code: string } | null;
  itcRecoverable: boolean;
  externalIds: unknown;
};

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha LE', slug: 'alpha-le', adminEmail: 'boss@alpha.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta LE', slug: 'beta-le', adminEmail: 'boss@beta.test', adminName: 'Other' }))
    .organizationId;
  await admin.query(
    `INSERT INTO app_user (organization_id, email, display_name, role_id) VALUES ($1, 'emp@alpha.test', 'Emp', '019e3000-0000-7000-8000-000000000004')`,
    [A],
  );
});

afterAll(async () => {
  await admin.end();
  await app.end();
});

describe('the extra fields', () => {
  it('round-trips country, home currency and ITC recoverability, audited into a chain that verifies', async () => {
    const c = as('boss@alpha.test', A);
    const created = (await les(c).create({
      label: { en: 'Alpha Holdings Inc.', 'fr-CA': '' },
      country: 'CA',
      homeCurrencyId: 'CAD',
      externalIds: { ledger: 'LE-1' },
    })) as Row;
    expect(created).toMatchObject({
      label: { en: 'Alpha Holdings Inc.' },
      country: 'CA',
      homeCurrencyId: 'CAD',
      homeCurrency: { code: 'CAD' },
      // ExpenseOS's default: an entity reclaims input tax unless told otherwise.
      itcRecoverable: true,
      externalIds: { ledger: 'LE-1' },
    });

    const updated = (await les(c).update({
      id: created.id,
      patch: { country: 'US', homeCurrencyId: 'USD', itcRecoverable: false }
    })) as Row;
    expect(updated).toMatchObject({
      country: 'US',
      homeCurrency: { code: 'USD' },
      itcRecoverable: false,
    });
    const row = (
      await admin.query('SELECT country, currency_code, itc_recoverable FROM legal_entity WHERE id = $1', [created.id])
    ).rows[0];
    expect(row).toEqual({ country: 'US', currency_code: 'USD', itc_recoverable: false });

    const audit = (
      await admin.query(
        `SELECT action, entity_type, details FROM audit_entry WHERE entity_id = $1 ORDER BY sequence`,
        [created.id],
      )
    ).rows;
    expect(audit.map((r) => r.action)).toEqual(['LEGAL_ENTITY_CREATED', 'LEGAL_ENTITY_UPDATED']);
    // ExpenseOS's factory derives it from "Legal entity" by removing the space.
    expect(audit[0].entity_type).toBe('Legalentity');
    expect(audit[1].details).toEqual({ changedFields: ['country', 'homeCurrencyId', 'itcRecoverable'] });
    expect((await withOrg(A, (tx) => verifyChain(tx))).ok).toBe(true);
  });

  it('clears the country and currency', async () => {
    const c = as('boss@alpha.test', A);
    const le = (await les(c).create({ label: { en: 'Clearable' }, country: 'CA', homeCurrencyId: 'CAD' })) as Row;
    const cleared = (await les(c).update({ id: le.id, patch: { country: null, homeCurrencyId: null } })) as Row;
    expect(cleared).toMatchObject({ country: null, homeCurrencyId: null, homeCurrency: null });
  });

  it('refuses a lowercase country and a currency the system has no row for; the table refuses them too', async () => {
    const c = as('boss@alpha.test', A);
    expect(await codeOf(les(c).create({ label: { en: 'Bad country' }, country: 'ca' }))).toBe('BAD_REQUEST');
    expect(await codeOf(les(c).create({ label: { en: 'Bad currency' }, homeCurrencyId: 'cad' }))).toBe(
      'BAD_REQUEST',
    );
    // A well-formed code with no currency row is the foreign key's to refuse.
    expect(await codeOf(les(c).create({ label: { en: 'No such currency' }, homeCurrencyId: 'ZZZ' }))).not.toBe(
      'OK',
    );
    expect(
      (await admin.query(`SELECT count(*)::int AS n FROM legal_entity WHERE label ->> 'en' = 'No such currency'`)).rows[0]
        .n,
    ).toBe(0);
    await expect(
      admin.query(`INSERT INTO legal_entity (organization_id, label, country) VALUES ($1, '{"en":"X"}', 'ca')`, [A]),
    ).rejects.toThrow(/legal_entity_country_iso/);
  });

  it('answers a duplicate English name with CONFLICT', async () => {
    const c = as('boss@alpha.test', A);
    await les(c).create({ label: { en: 'Twin Ltd.' } });
    expect(await codeOf(les(c).create({ label: { en: 'twin ltd.' } }))).toBe('CONFLICT');
  });
});

describe('the currency picker', () => {
  it('lists the system’s currencies in ExpenseOS’s shape, the code as the id', async () => {
    const list = await as('boss@alpha.test', A).appSettings.currencies.list();
    expect(list).toEqual(
      expect.arrayContaining([
        { id: 'CAD', code: 'CAD', symbol: '', label: { en: 'Canadian Dollar' }, precision: 2 },
        { id: 'USD', code: 'USD', symbol: '', label: { en: 'US Dollar' }, precision: 2 },
      ]),
    );
    expect(list.map((c) => c.code)).toEqual([...list.map((c) => c.code)].sort());
  });

  it('is refused to an employee', async () => {
    expect(await codeOf(as('emp@alpha.test', A).appSettings.currencies.list())).toBe('FORBIDDEN');
  });
});

describe('tenancy and permissions', () => {
  it('lists only the tenant’s own entities, and refuses an employee', async () => {
    const beta = (await les(as('boss@beta.test', B)).create({ label: { en: 'Beta Only' } })) as Row;
    const alpha = (await as('boss@alpha.test', A).legalEntities.list({ includeInactive: true })).items;
    expect(alpha.map((r) => r.id)).not.toContain(beta.id);
    expect(
      await codeOf(les(as('boss@alpha.test', A)).update({ id: beta.id, patch: { country: 'FR' } })),
    ).toBe('NOT_FOUND');
    expect(await codeOf(as('emp@alpha.test', A).legalEntities.list())).toBe('FORBIDDEN');
  });
});

describe('migration 0048: the country clean-up', () => {
  it('normalises every tenant’s countries under RLS, as the migration role is on RDS', async () => {
    const a = (await les(as('boss@alpha.test', A)).create({ label: { en: 'Messy A' } })) as Row;
    const b = (await les(as('boss@beta.test', B)).create({ label: { en: 'Messy B' } })) as Row;
    const junk = (await les(as('boss@beta.test', B)).create({ label: { en: 'Junk B' } })) as Row;
    // Put back what a pre-0048 row could hold, which the new CHECK no longer lets in.
    await admin.query('ALTER TABLE legal_entity DROP CONSTRAINT legal_entity_country_iso');
    try {
      await admin.query(`UPDATE legal_entity SET country = ' ca' WHERE id = $1`, [a.id]);
      await admin.query(`UPDATE legal_entity SET country = 'us' WHERE id = $1`, [b.id]);
      await admin.query(`UPDATE legal_entity SET country = 'Canada' WHERE id = $1`, [junk.id]);

      // Without a tenant scope, RLS hides every row from the app role — the trap.
      expect((await app.query(`UPDATE legal_entity SET country = upper(country)`)).rowCount).toBe(0);

      await app.query(COUNTRY_LOOP);
      const countries = Object.fromEntries(
        (
          await admin.query('SELECT id, country FROM legal_entity WHERE id = ANY($1::uuid[])', [[a.id, b.id, junk.id]])
        ).rows.map((r) => [r.id, r.country]),
      );
      expect(countries).toEqual({ [a.id]: 'CA', [b.id]: 'US', [junk.id]: null });
    } finally {
      await admin.query(
        `ALTER TABLE legal_entity ADD CONSTRAINT legal_entity_country_iso CHECK (country IS NULL OR country ~ '^[A-Z]{2}$')`,
      );
    }
  });
});
