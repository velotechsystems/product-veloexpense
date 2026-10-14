/**
 * w4-10a (d73) — roles are rows (0068), and permissions come from them.
 *
 * Until now a person's text role (`app_user.role`) was mapped to an ExpenseOS system role in
 * memory. This proves, against a real database, the three things that replaced that:
 *
 *   · the staged cutover: a write that still sets the text role sets the role it stands for
 *     (ADMIN → System Administrator; MANAGER, EMPLOYEE → Employee), and a write that names
 *     the role itself keeps it;
 *   · a request's permissions and role label are the tenant's role ROW (`resolveTenantMember`,
 *     the function the tRPC middleware and the shell share): an edit to the row is what the
 *     next request sees, and a deactivated role grants nothing — ExpenseOS's loader;
 *   · per tenant: the same system id is a different row in each tenant, so one tenant's edit
 *     to its Employee does not reach another's.
 *
 * No Redis here (the cache is absent without REDIS_URL — packages/rbac/src/cache.ts), so an
 * edit is visible on the very next request. packages/rbac/src/cache.test.ts covers the cache.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SYSTEM_ROLE_IDS, permissions as P } from '@expenseos/rbac';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const { createOrganization } = await import('@/lib/onboarding/provision');
const { resolveTenantMember } = await import('@/server/trpc');
const { withTenantDb } = await import('@/lib/db/prisma');

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

let A: string;
let B: string;

const member = (email: string, organizationId: string) =>
  withTenantDb(organizationId, (tx) => resolveTenantMember(tx, { email, organizationId }, null));

const roleIdOf = async (email: string) =>
  (await admin.query(`SELECT role_id FROM app_user WHERE email = $1`, [email])).rows[0].role_id as string;

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Roles A', slug: 'roles-a', adminEmail: 'boss@roles-a.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Roles B', slug: 'roles-b', adminEmail: 'boss@roles-b.test', adminName: 'Other' }))
    .organizationId;
});

afterAll(async () => {
  await admin.end();
});

describe('the staged cutover from the text role', () => {
  it('gives the founding admin the System Administrator role', async () => {
    expect(await roleIdOf('boss@roles-a.test')).toBe(SYSTEM_ROLE_IDS.admin);
  });

  it('maps each text role on insert, and follows a change to it', async () => {
    for (const [email, text, expected] of [
      ['m@roles-a.test', 'MANAGER', SYSTEM_ROLE_IDS.employee],
      ['e@roles-a.test', 'EMPLOYEE', SYSTEM_ROLE_IDS.employee],
      ['a@roles-a.test', 'ADMIN', SYSTEM_ROLE_IDS.admin],
    ] as const) {
      await admin.query(
        `INSERT INTO app_user (organization_id, email, display_name, role) VALUES ($1, $2, 'P', $3)`,
        [A, email, text],
      );
      expect(await roleIdOf(email)).toBe(expected);
    }
    await admin.query(`UPDATE app_user SET role = 'ADMIN' WHERE email = 'e@roles-a.test'`);
    expect(await roleIdOf('e@roles-a.test')).toBe(SYSTEM_ROLE_IDS.admin);
    await admin.query(`UPDATE app_user SET role = 'EMPLOYEE' WHERE email = 'e@roles-a.test'`);
    expect(await roleIdOf('e@roles-a.test')).toBe(SYSTEM_ROLE_IDS.employee);
  });

  it('keeps a role named directly, and only follows the text role when it changes', async () => {
    await admin.query(`UPDATE app_user SET role_id = $1 WHERE email = 'm@roles-a.test'`, [SYSTEM_ROLE_IDS.executive]);
    expect(await roleIdOf('m@roles-a.test')).toBe(SYSTEM_ROLE_IDS.executive);
    // A write that touches other columns leaves it alone.
    await admin.query(`UPDATE app_user SET display_name = 'Renamed' WHERE email = 'm@roles-a.test'`);
    expect(await roleIdOf('m@roles-a.test')).toBe(SYSTEM_ROLE_IDS.executive);
  });
});

describe("a request's permissions", () => {
  it('are the role row, labelled from it', async () => {
    const { session, rbac } = await member('boss@roles-a.test', A);
    expect(session.user.roleId).toBe(SYSTEM_ROLE_IDS.admin);
    expect(session.user.roleLabel).toBe('System Administrator');
    expect(rbac.permissions).toContain(P.admin.role.list);

    const executive = await member('m@roles-a.test', A);
    expect(executive.session.user.roleLabel).toBe('Executive');
    expect(executive.rbac.permissions).not.toContain(P.admin.role.list);
  });

  it('follow an edit to the row on the next request, in that tenant only', async () => {
    await withTenantDb(A, (tx) =>
      tx.$executeRaw`UPDATE role SET permissions = array_remove(permissions, ${P.admin.role.list}),
                                     label = '{"en":"Platform Admin","fr-CA":"Admin"}'
                      WHERE id = ${SYSTEM_ROLE_IDS.admin}::uuid`,
    );
    try {
      const a = await member('boss@roles-a.test', A);
      expect(a.rbac.permissions).not.toContain(P.admin.role.list);
      expect(a.session.user.roleLabel).toBe('Platform Admin');
      // The same id in another tenant is another row, untouched.
      const b = await member('boss@roles-b.test', B);
      expect(b.rbac.permissions).toContain(P.admin.role.list);
      expect(b.session.user.roleLabel).toBe('System Administrator');
    } finally {
      await withTenantDb(A, (tx) =>
        tx.$executeRaw`UPDATE role SET permissions = array_append(permissions, ${P.admin.role.list}),
                                       label = '{"en":"System Administrator","fr-CA":"Administrateur système"}'
                        WHERE id = ${SYSTEM_ROLE_IDS.admin}::uuid`,
      );
    }
  });

  it('are none while the role is deactivated', async () => {
    await withTenantDb(A, (tx) => tx.$executeRaw`UPDATE role SET active = false WHERE id = ${SYSTEM_ROLE_IDS.executive}::uuid`);
    try {
      expect((await member('m@roles-a.test', A)).rbac.permissions).toEqual([]);
    } finally {
      await withTenantDb(A, (tx) => tx.$executeRaw`UPDATE role SET active = true WHERE id = ${SYSTEM_ROLE_IDS.executive}::uuid`);
    }
    expect((await member('m@roles-a.test', A)).rbac.permissions.length).toBeGreaterThan(0);
  });
});
