// @vitest-environment node
/**
 * w5-04 — the Google Workspace directory sync, against a real Postgres.
 *
 * ExpenseOS's `apply.test.ts` and `directory-sync.test.ts` (1e682dd6) assert on the Prisma
 * calls the code makes; here each claim that survives the port is asserted on the tables,
 * with a fake Directory client (`opts.client`) so nothing reaches Google. The claims that do
 * not survive are replaced by VeloExpense's (d84), and each says so:
 *
 *   · never creates a person — ExpenseOS's "creates a placeholder" cases are inverted;
 *   · status moves one way: Directory can offboard, never reactivate, never clear ON_LEAVE;
 *   · the last active admin is held;
 *   · per tenant: one tenant's run touches only that tenant, with that tenant's key.
 *
 * The handler's own claims are ExpenseOS's: one summary audit row per run, the roll-up of
 * leavers' open reports, no-op on `disabled`, and an error run audited before it throws.
 * VeloExpense adds the run recorded on the connection row in the same transaction.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SYSTEM_ROLE_IDS } from '@expenseos/rbac';
import type { DirectoryClient, GoogleUser } from '@expenseos/integrations-google';
import { withOrg } from '@/lib/tenant/context';
import {
  getDirectoryConnection,
  saveDirectoryConnection,
} from '@/lib/directory/googleConnection';
import { inTenant } from '../lib/tenant';
import { handleDirectorySync } from './directory-sync';

process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 17).toString('base64');

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
const EMPLOYEE = SYSTEM_ROLE_IDS.employee;
const ADMIN = SYSTEM_ROLE_IDS.admin;

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'svc@p.iam.gserviceaccount.com',
  private_key: PEM,
});

let A: string;
let B: string;
let bossA: string;

/** A fake Directory: one page of these users. */
function directory(users: GoogleUser[]): DirectoryClient {
  return { users: { list: async () => ({ data: { users } }) } };
}
const sync = (org: string, users: GoogleUser[], trigger: 'cron' | 'manual' = 'cron') =>
  inTenant({ organizationId: org }, () =>
    handleDirectorySync({ organizationId: org, trigger }, { client: directory(users) }),
  );

async function mkUser(org: string, email: string, name: string, role = EMPLOYEE) {
  return (
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [org, email, name, role],
    )
  ).rows[0].id as string;
}
async function person(id: string) {
  return (
    await admin.query(
      `SELECT email, first_name, last_name, avatar_url, department_id, business_unit_id,
              legal_entity_id, job_level_id, country, manager_id, employee_status,
              termination_date, deleted_at
         FROM app_user WHERE id = $1`,
      [id],
    )
  ).rows[0];
}
async function audits(org: string) {
  return (
    await admin.query(
      `SELECT details, actor_name FROM audit_entry
        WHERE organization_id = $1 AND action = 'DIRECTORY_SYNCED' ORDER BY sequence`,
      [org],
    )
  ).rows as Array<{ details: Record<string, unknown>; actor_name: string }>;
}
const label = (en: string) => JSON.stringify({ en });

beforeAll(async () => {
  const { createOrganization } = await import('@/lib/onboarding/provision');
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Dir A', slug: 'dir-a', adminEmail: 'boss@dir-a.test', adminName: 'Boss A' })).organizationId;
  B = (await createOrganization({ name: 'Dir B', slug: 'dir-b', adminEmail: 'boss@dir-b.test', adminName: 'Boss B' })).organizationId;
  bossA = (await admin.query(`SELECT id FROM app_user WHERE email = 'boss@dir-a.test'`)).rows[0].id;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

beforeEach(async () => {
  // Fresh chains per case: the summary rows are counted.
  await admin.query('BEGIN');
  await admin.query(`SELECT set_config('app.audit_purge', 'on', true)`);
  await admin.query('DELETE FROM audit_entry');
  await admin.query('COMMIT');
  await admin.query(`DELETE FROM google_directory_connection`);
  await admin.query(`DELETE FROM expense_report`);
  await admin.query(`DELETE FROM app_user WHERE email NOT LIKE 'boss@%'`);
  await admin.query(`UPDATE app_user SET manager_id = NULL, department_id = NULL, job_level_id = NULL,
                            employee_status = 'ACTIVE', deleted_at = NULL, role_id = $1`, [ADMIN]);
  await admin.query(`DELETE FROM business_unit_external_id`);
  await admin.query(`DELETE FROM legal_entity_external_id`);
  await admin.query(`DELETE FROM external_id_source`);
  await admin.query(`DELETE FROM department`);
  await admin.query(`DELETE FROM business_unit`);
  await admin.query(`UPDATE app_user SET legal_entity_id = NULL`);
  await admin.query(`DELETE FROM legal_entity WHERE label->>'en' LIKE 'Dir %'`);
  await admin.query(`DELETE FROM job_level`);
  await withOrg(A, (tx) => saveDirectoryConnection(tx, bossA, { serviceAccountJson: KEY, impersonateEmail: 'boss@dir-a.test' }));
});

afterAll(async () => {
  vi.restoreAllMocks();
  await admin.end();
});

describe('who it touches — update only (VeloExpense, d84)', () => {
  it('updates a person it has, matched by email whatever its case', async () => {
    const ada = await mkUser(A, 'Ada@Example.test', 'Ada Old');
    await sync(A, [
      {
        primaryEmail: 'ada@example.test',
        name: { givenName: 'Ada', familyName: 'Lovelace' },
        thumbnailPhotoUrl: 'https://example.test/ada.png',
        addresses: [{ primary: true, countryCode: 'CA' }],
      },
    ]);
    expect(await person(ada)).toMatchObject({
      first_name: 'Ada',
      last_name: 'Lovelace',
      avatar_url: 'https://example.test/ada.png',
      country: 'CA',
      // The address itself is VeloExpense's — the join key, not a field the sync writes.
      email: 'Ada@Example.test',
    });
  });

  it('creates NOBODY for a Directory user it does not have — ExpenseOS creates a placeholder', async () => {
    const before = (await admin.query(`SELECT count(*)::int AS n FROM app_user WHERE organization_id = $1`, [A])).rows[0].n;
    const r = await sync(A, [{ primaryEmail: 'stranger@example.test', name: { givenName: 'S' } }]);
    expect(r).toMatchObject({ status: 'completed', scanned: 1, notFound: 1, updated: 0 });
    expect((await admin.query(`SELECT count(*)::int AS n FROM app_user WHERE organization_id = $1`, [A])).rows[0].n).toBe(before);
  });

  it('refuses to guess between two people whose addresses differ only in case', async () => {
    await mkUser(A, 'twin@example.test', 'Twin One');
    await mkUser(A, 'TWIN@example.test', 'Twin Two');
    const r = await sync(A, [{ primaryEmail: 'twin@example.test', name: { givenName: 'X' } }]);
    expect(r).toMatchObject({ errors: 1, updated: 0 });
  });

  it("runs as one tenant, with that tenant's key: B is untouched, and B (not connected) is disabled", async () => {
    const inB = await mkUser(B, 'ada@example.test', 'Ada in B');
    await mkUser(A, 'ada@example.test', 'Ada in A');
    await sync(A, [{ primaryEmail: 'ada@example.test', name: { givenName: 'Changed' } }]);
    expect((await person(inB)).first_name).not.toBe('Changed');
    // B never connected: its run is `disabled` — no audit, nothing recorded, no throw.
    const r = await inTenant({ organizationId: B }, () => handleDirectorySync({ organizationId: B }));
    expect(r.status).toBe('disabled');
    expect(await audits(B)).toHaveLength(0);
  });
});

describe('absent data never blanks an existing field', () => {
  it('leaves names, photo and country alone when Directory omits them', async () => {
    const ada = await mkUser(A, 'ada@example.test', 'Ada Lovelace');
    await admin.query(`UPDATE app_user SET country = 'GB', avatar_url = 'x' WHERE id = $1`, [ada]);
    await sync(A, [{ primaryEmail: 'ada@example.test' }]);
    expect(await person(ada)).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace', country: 'GB', avatar_url: 'x' });
  });
});

describe('org lookups resolve, and never create', () => {
  it('resolves department, business unit and legal entity by label — and by alias', async () => {
    const ada = await mkUser(A, 'ada@example.test', 'Ada');
    const dept = (await admin.query(`INSERT INTO department (organization_id, label) VALUES ($1, $2) RETURNING id`, [A, label('R&D')])).rows[0].id;
    const bu = (await admin.query(`INSERT INTO business_unit (organization_id, label) VALUES ($1, $2) RETURNING id`, [A, label('Dir Prairies')])).rows[0].id;
    const le = (await admin.query(`INSERT INTO legal_entity (organization_id, label, country) VALUES ($1, $2, 'CA') RETURNING id`, [A, label('Dir Inc.')])).rows[0].id;
    const src = (await admin.query(`INSERT INTO external_id_source (organization_id, code, label) VALUES ($1, 'adp', $2) RETURNING id`, [A, label('ADP')])).rows[0].id;
    // A BUILDING rolls up to its business unit; ADP's payroll name is the legal entity.
    await admin.query(`INSERT INTO business_unit_external_id (organization_id, source_id, source_value, business_unit_id) VALUES ($1, $2, 'Logistic Centre - Edmonton', $3)`, [A, src, bu]);
    await admin.query(`INSERT INTO legal_entity_external_id (organization_id, source_id, source_value, legal_entity_id) VALUES ($1, $2, 'DIR INC', $3)`, [A, src, le]);
    await sync(A, [
      {
        primaryEmail: 'ada@example.test',
        organizations: [{ primary: true, department: 'R&D', costCenter: 'DIR INC' }],
        locations: [{ buildingId: 'Logistic Centre - Edmonton' }],
      },
    ]);
    expect(await person(ada)).toMatchObject({ department_id: dept, business_unit_id: bu, legal_entity_id: le });
  });

  it('does NOT create a department, unit or entity Directory names but we do not have', async () => {
    const ada = await mkUser(A, 'ada@example.test', 'Ada');
    const dept = (await admin.query(`INSERT INTO department (organization_id, label) VALUES ($1, $2) RETURNING id`, [A, label('Finance')])).rows[0].id;
    await admin.query(`UPDATE app_user SET department_id = $2 WHERE id = $1`, [ada, dept]);
    await sync(A, [
      {
        primaryEmail: 'ada@example.test',
        organizations: [{ primary: true, department: 'IT Testing', costCenter: 'Nowhere Ltd' }],
        locations: [{ buildingId: 'Remote' }],
      },
    ]);
    // The person keeps what they had; nothing new exists.
    expect((await person(ada)).department_id).toBe(dept);
    expect((await admin.query(`SELECT count(*)::int AS n FROM department WHERE organization_id = $1`, [A])).rows[0].n).toBe(1);
    expect((await admin.query(`SELECT count(*)::int AS n FROM business_unit WHERE organization_id = $1`, [A])).rows[0].n).toBe(0);
  });
});

describe('manager resolution', () => {
  it('links a manager we already have, and never invents one', async () => {
    const ada = await mkUser(A, 'ada@example.test', 'Ada');
    const grace = await mkUser(A, 'grace@example.test', 'Grace');
    await sync(A, [{ primaryEmail: 'ada@example.test', relations: [{ type: 'manager', value: 'Grace@Example.test' }] }]);
    expect((await person(ada)).manager_id).toBe(grace);
    await sync(A, [{ primaryEmail: 'ada@example.test', relations: [{ type: 'manager', value: 'ghost@example.test' }] }]);
    // An unknown manager changes nothing — and creates nobody.
    expect((await person(ada)).manager_id).toBe(grace);
    expect((await admin.query(`SELECT 1 FROM app_user WHERE email = 'ghost@example.test'`)).rows).toHaveLength(0);
  });

  it('leaves the manager UNCHANGED when Directory returns none, and never makes somebody their own', async () => {
    const ada = await mkUser(A, 'ada@example.test', 'Ada');
    await admin.query(`UPDATE app_user SET manager_id = $2 WHERE id = $1`, [ada, bossA]);
    await sync(A, [{ primaryEmail: 'ada@example.test' }]);
    expect((await person(ada)).manager_id).toBe(bossA);
    await sync(A, [{ primaryEmail: 'ada@example.test', relations: [{ type: 'manager', value: 'ada@example.test' }] }]);
    expect((await person(ada)).manager_id).toBe(bossA);
  });
});

describe('job level', () => {
  it("sets the level when the title maps to a code this tenant has; reports a code it lacks", async () => {
    const ada = await mkUser(A, 'ada@example.test', 'Ada');
    const bob = await mkUser(A, 'bob@example.test', 'Bob');
    const ic5 = (
      await admin.query(
        `INSERT INTO job_level (organization_id, code, track, label, sort_order)
         VALUES ($1, 'IC5', 'INDIVIDUAL_CONTRIBUTOR', $2, 5) RETURNING id`,
        [A, label('Senior')],
      )
    ).rows[0].id;
    const r = await sync(A, [
      { primaryEmail: 'ada@example.test', organizations: [{ primary: true, title: 'Senior Engineer' }] },
      // "Manager" maps to M3, which this tenant has not defined.
      { primaryEmail: 'bob@example.test', organizations: [{ primary: true, title: 'Manager' }] },
    ]);
    expect((await person(ada)).job_level_id).toBe(ic5);
    expect((await person(bob)).job_level_id).toBeNull();
    expect(r.missingJobLevels).toEqual([{ code: 'M3', count: 1 }]);
    // No level was invented.
    expect((await admin.query(`SELECT count(*)::int AS n FROM job_level WHERE organization_id = $1`, [A])).rows[0].n).toBe(1);
  });

  it('creates NOTHING for an unrecognised title, and reports it', async () => {
    await mkUser(A, 'ada@example.test', 'Ada');
    const r = await sync(A, [{ primaryEmail: 'ada@example.test', organizations: [{ primary: true, title: 'Barista' }] }]);
    expect(r.unmappedTitles).toEqual([{ title: 'Barista', count: 1 }]);
  });
});

describe('status — one way (VeloExpense)', () => {
  it('offboards a suspended person as users.deactivate does, and rolls their open reports up', async () => {
    const ada = await mkUser(A, 'ada@example.test', 'Ada');
    const grace = await mkUser(A, 'grace@example.test', 'Grace');
    await admin.query(`UPDATE app_user SET manager_id = $2 WHERE id = $1`, [ada, grace]);
    const report = (
      await admin.query(
        `INSERT INTO expense_report (organization_id, submitter_id, title, currency_code)
         VALUES ($1, $2, 'Offsite', 'CAD') RETURNING id`,
        [A, ada],
      )
    ).rows[0].id;
    const r = await sync(A, [{ primaryEmail: 'ada@example.test', suspended: true }]);
    const row = await person(ada);
    expect(row.employee_status).toBe('DEACTIVATED');
    // `deleted_at` is what sign-in, every request and the seat meter read (0071).
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(r.offboarded).toEqual([ada]);
    // ExpenseOS's roll-up: the open report moves to the manager.
    expect((await admin.query(`SELECT submitter_id FROM expense_report WHERE id = $1`, [report])).rows[0].submitter_id).toBe(grace);
    const [audit] = await audits(A);
    expect(audit.details).toMatchObject({ offboarded: [ada], offboardRollup: { users: 1, reportsToManager: 1, reportsOrphaned: 0 } });
  });

  it('marks an archived person TERMINATED with the deletion date', async () => {
    const ada = await mkUser(A, 'ada@example.test', 'Ada');
    await sync(A, [{ primaryEmail: 'ada@example.test', archived: true, deletionTime: '2026-09-30T00:00:00.000Z' }]);
    expect(await person(ada)).toMatchObject({ employee_status: 'TERMINATED', termination_date: new Date('2026-09-30T00:00:00.000Z') });
  });

  it('never reactivates — an active Directory account does not bring back somebody deactivated here', async () => {
    const ada = await mkUser(A, 'ada@example.test', 'Ada');
    await admin.query(`UPDATE app_user SET employee_status = 'DEACTIVATED', deleted_at = now() WHERE id = $1`, [ada]);
    await sync(A, [{ primaryEmail: 'ada@example.test', name: { givenName: 'Ada' } }]);
    expect(await person(ada)).toMatchObject({ employee_status: 'DEACTIVATED' });
    expect((await person(ada)).deleted_at).not.toBeNull();
  });

  it('never clears ON_LEAVE, which Directory cannot express — ExpenseOS resets it to ACTIVE', async () => {
    const ada = await mkUser(A, 'ada@example.test', 'Ada');
    await admin.query(`UPDATE app_user SET employee_status = 'ON_LEAVE' WHERE id = $1`, [ada]);
    await sync(A, [{ primaryEmail: 'ada@example.test' }]);
    expect((await person(ada)).employee_status).toBe('ON_LEAVE');
  });

  it("holds the tenant's last active admin, and reports it", async () => {
    const r = await sync(A, [{ primaryEmail: 'boss@dir-a.test', suspended: true }]);
    expect(r).toMatchObject({ held: 1, offboarded: [] });
    expect(await person(bossA)).toMatchObject({ employee_status: 'ACTIVE', deleted_at: null });
    // With a second admin, the same record offboards them.
    await mkUser(A, 'second@example.test', 'Second', ADMIN);
    const again = await sync(A, [{ primaryEmail: 'boss@dir-a.test', suspended: true }]);
    expect(again.offboarded).toEqual([bossA]);
  });
});

describe('the run — one summary audit row, and the screen\'s copy', () => {
  it('writes one row per run, as the system, and records the run on the connection', async () => {
    await mkUser(A, 'ada@example.test', 'Ada');
    await mkUser(A, 'bob@example.test', 'Bob');
    await sync(
      A,
      [{ primaryEmail: 'ada@example.test' }, { primaryEmail: 'bob@example.test' }, { primaryEmail: 'x@example.test' }],
      'manual',
    );
    const rows = await audits(A);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_name).toBe('system:directory-sync');
    expect(rows[0].details).toMatchObject({ status: 'completed', trigger: 'manual', scanned: 3, updated: 2, notFound: 1, errors: 0 });
    const view = await withOrg(A, (tx) => getDirectoryConnection(tx));
    expect(view.lastSyncAt).toBeInstanceOf(Date);
    expect(view.lastSync).toMatchObject({ status: 'completed', trigger: 'manual', scanned: 3, updated: 2, notFound: 1, offboarded: 0 });
  });

  it('audits an error run BEFORE throwing it, and the screen says so', async () => {
    const failing: DirectoryClient = { users: { list: async () => { throw new Error('429 rate limited'); } } };
    await expect(
      inTenant({ organizationId: A }, () => handleDirectorySync({ organizationId: A }, { client: failing })),
    ).rejects.toThrow(/directory sync failed: directory.users.list failed: 429 rate limited/);
    const [row] = await audits(A);
    expect(row.details).toMatchObject({ status: 'error', message: expect.stringContaining('429') });
    expect((await withOrg(A, (tx) => getDirectoryConnection(tx))).lastSync).toMatchObject({ status: 'error' });
  });

  it("an unreadable stored key is an error run, recorded, and never quotes the ciphertext", async () => {
    await admin.query(`UPDATE google_directory_connection SET service_account_json = 'enc:v1:garbage' WHERE organization_id = $1`, [A]);
    await expect(
      inTenant({ organizationId: A }, () => handleDirectorySync({ organizationId: A })),
    ).rejects.toThrow(/cannot be decrypted/);
    const [row] = await audits(A);
    expect(JSON.stringify(row.details)).not.toContain('garbage');
  });

  it('no-ops on `disabled` — no audit, no roll-up, no throw', async () => {
    await admin.query(`DELETE FROM google_directory_connection`);
    const r = await inTenant({ organizationId: A }, () => handleDirectorySync({ organizationId: A }));
    expect(r.status).toBe('disabled');
    expect(await audits(A)).toHaveLength(0);
  });
});

describe('the connection store', () => {
  it('stores the key encrypted, shows only the account address, and a blank key keeps it', async () => {
    const raw = (await admin.query(`SELECT service_account_json, client_email FROM google_directory_connection WHERE organization_id = $1`, [A])).rows[0];
    expect(raw.service_account_json).toMatch(/^enc:v1:/);
    expect(raw.service_account_json).not.toContain('PRIVATE KEY');
    const view = await withOrg(A, (tx) => getDirectoryConnection(tx));
    expect(view).toMatchObject({ connected: true, clientEmail: 'svc@p.iam.gserviceaccount.com', impersonateEmail: 'boss@dir-a.test' });
    expect(JSON.stringify(view)).not.toContain('PRIVATE KEY');
    // Changing the admin alone keeps the key, and clears the last test (it was about the old admin).
    await admin.query(`UPDATE google_directory_connection SET last_test_at = now(), last_test_ok = true`);
    await withOrg(A, (tx) => saveDirectoryConnection(tx, bossA, { serviceAccountJson: '', impersonateEmail: 'Other@Example.test' }));
    const after = (await admin.query(`SELECT service_account_json, impersonate_email, last_test_at FROM google_directory_connection`)).rows[0];
    expect(after).toMatchObject({ service_account_json: raw.service_account_json, impersonate_email: 'other@example.test', last_test_at: null });
  });

  it('refuses a paste that is not a key file, and an admin that is not an address', async () => {
    await admin.query(`DELETE FROM google_directory_connection`);
    await expect(
      withOrg(A, (tx) => saveDirectoryConnection(tx, bossA, { serviceAccountJson: '{"nope":1}', impersonateEmail: 'boss@dir-a.test' })),
    ).rejects.toMatchObject({ userMessage: { code: 'DIRECTORY_KEY_INVALID' } });
    await expect(
      withOrg(A, (tx) => saveDirectoryConnection(tx, bossA, { serviceAccountJson: '', impersonateEmail: 'boss@dir-a.test' })),
    ).rejects.toMatchObject({ userMessage: { code: 'DIRECTORY_KEY_REQUIRED' } });
    await expect(
      withOrg(A, (tx) => saveDirectoryConnection(tx, bossA, { serviceAccountJson: KEY, impersonateEmail: 'not an email' })),
    ).rejects.toMatchObject({ userMessage: { code: 'DIRECTORY_ADMIN_EMAIL_INVALID' } });
  });
});
