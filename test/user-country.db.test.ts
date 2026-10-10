/**
 * w2-10 — a person's country (`app_user.country`, migration 0055), which ExpenseOS's mileage
 * pricing reads to choose a rate. Not in ExpenseOS: its column is set by an administrator or
 * synced from Google Workspace; VeloExpense's arrives with a backfill and a default.
 *
 *   · 0055's backfill gives every person their legal entity's country, PER TENANT, under
 *     RLS as the migration role is bound on RDS — and leaves alone a person with no entity,
 *     an entity with no country, and a country already set;
 *   · a person added afterwards takes their entity's country unless one is given, so they
 *     are priced the same way as somebody who was here before 0055;
 *   · after that it is the person's own: an administrator changes it, changing the entity
 *     does not move it, and a code that is not a country is refused in a sentence.
 */
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const { createOrganization } = await import('@/lib/onboarding/provision');
const { withOrg } = await import('@/lib/tenant/context');
const employees = await import('@/lib/employees/service');
const { userMessageOf } = await import('@/lib/errors/domain');

const MIGRATION = readFileSync('prisma/migrations/0055_user_country/migration.sql', 'utf8');
/** Just the backfill: the column has already been added on this database. */
const BACKFILL = MIGRATION.slice(MIGRATION.indexOf('DO $$'), MIGRATION.indexOf('END $$;') + 'END $$;'.length);

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
const app = new Pool({ connectionString: process.env.DATABASE_URL });

let A: string;
let B: string;
let caA: string;
let usB: string;
let noCountryA: string;

const entity = async (org: string, name: string, country: string | null) =>
  (
    await admin.query(
      `INSERT INTO legal_entity (organization_id, label, country) VALUES ($1, $2::jsonb, $3) RETURNING id`,
      [org, JSON.stringify({ en: name }), country],
    )
  ).rows[0].id as string;

const person = async (org: string, email: string, legalEntityId: string | null, country: string | null = null) =>
  (
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, legal_entity_id, country)
       VALUES ($1, $2, $2, $3, $4) RETURNING id`,
      [org, email, legalEntityId, country],
    )
  ).rows[0].id as string;

const countryOf = async (id: string) =>
  (await admin.query('SELECT country FROM app_user WHERE id = $1', [id])).rows[0].country as string | null;

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha UC', slug: 'alpha-uc', adminEmail: 'boss@alpha-uc.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta UC', slug: 'beta-uc', adminEmail: 'boss@beta-uc.test', adminName: 'Other' }))
    .organizationId;
  caA = await entity(A, 'Alpha Canada', 'CA');
  usB = await entity(B, 'Beta US', 'US');
  noCountryA = await entity(A, 'Alpha nowhere', null);
});

afterAll(async () => {
  await admin.end();
  await app.end();
});

describe('migration 0055: the backfill', () => {
  it('gives each person their legal entity’s country, in every tenant, under RLS', async () => {
    const a1 = await person(A, 'a1@alpha-uc.test', caA);
    const b1 = await person(B, 'b1@beta-uc.test', usB);
    const unemployed = await person(A, 'free@alpha-uc.test', null);
    const blankEntity = await person(A, 'blank@alpha-uc.test', noCountryA);
    const alreadySet = await person(A, 'set@alpha-uc.test', caA, 'FR');

    // Without a tenant scope, RLS hides every row from the app role — the trap 0055 avoids.
    expect(
      (
        await app.query(
          `UPDATE app_user u SET country = le.country FROM legal_entity le WHERE le.id = u.legal_entity_id`,
        )
      ).rowCount,
    ).toBe(0);

    await app.query(BACKFILL);

    expect(await countryOf(a1)).toBe('CA');
    expect(await countryOf(b1)).toBe('US');
    expect(await countryOf(unemployed)).toBeNull();
    expect(await countryOf(blankEntity)).toBeNull();
    // A country already set is the person's own, and is kept.
    expect(await countryOf(alreadySet)).toBe('FR');
  });

  it('refuses anything that is not two capital letters', async () => {
    await expect(person(A, 'lower@alpha-uc.test', null, 'ca')).rejects.toThrow(/app_user_country_iso/);
  });
});

describe('a person added after 0055', () => {
  it('takes their legal entity’s country unless one is given', async () => {
    const defaulted = await withOrg(A, (tx) =>
      employees.createEmployee(tx, { email: 'new@alpha-uc.test', legalEntityId: caA }),
    );
    expect(defaulted.country).toBe('CA');

    const given = await withOrg(A, (tx) =>
      employees.createEmployee(tx, { email: 'given@alpha-uc.test', legalEntityId: caA, country: 'US' }),
    );
    expect(given.country).toBe('US');

    // An explicit null is a decision, not an omission.
    const none = await withOrg(A, (tx) =>
      employees.createEmployee(tx, { email: 'none@alpha-uc.test', legalEntityId: caA, country: null }),
    );
    expect(none.country).toBeNull();

    const noEntity = await withOrg(A, (tx) => employees.createEmployee(tx, { email: 'loose@alpha-uc.test' }));
    expect(noEntity.country).toBeNull();
  });
});

describe('afterwards, the country is the person’s own', () => {
  it('changes on the employee screen, and does not follow the legal entity', async () => {
    const id = await person(A, 'mover@alpha-uc.test', caA, 'CA');
    const changed = await withOrg(A, (tx) => employees.updateEmployee(tx, id, { country: 'GB' }));
    expect(changed.country).toBe('GB');
    const moved = await withOrg(A, (tx) => employees.updateEmployee(tx, id, { legalEntityId: noCountryA }));
    expect(moved.country).toBe('GB');
    const cleared = await withOrg(A, (tx) => employees.updateEmployee(tx, id, { country: null }));
    expect(cleared.country).toBeNull();
  });

  it('refuses a code that is not a country, in a sentence', async () => {
    const id = await person(A, 'typo@alpha-uc.test', caA, 'CA');
    const err = await withOrg(A, (tx) => employees.updateEmployee(tx, id, { country: 'XX' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(employees.EmployeeError);
    expect((err as InstanceType<typeof employees.EmployeeError>).code).toBe('INVALID_COUNTRY');
    expect(userMessageOf(err)?.code).toBe('COUNTRY_UNKNOWN');
    expect(await countryOf(id)).toBe('CA');
  });
});
