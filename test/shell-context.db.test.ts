/**
 * Wave 0 — the server half of ExpenseOS's app shell (server/shell.ts), against a real
 * database: what the root layout hands the ported `AppShell`.
 *
 *   · the reader is resolved exactly as the tRPC `tenant` middleware resolves them
 *     (one function, `resolveTenantMember`), role from the DATABASE;
 *   · `canSeeOthers` is ExpenseOS's rule — an admin, or anybody with a non-deleted report —
 *     counted through the tenant-scoped Prisma `User` model, so RLS bounds it;
 *   · no session, a non-member and a deactivated account get NO shell (`null`), never a
 *     thrown layout.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const h = vi.hoisted(() => ({
  session: null as { user: { email: string; organizationId: string } } | null,
}));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => h.session) }));
vi.mock('@/lib/tenant/request', () => ({ hostTenantSlug: async () => null }));

const { createOrganization } = await import('@/lib/onboarding/provision');
const { shellContext, shellState } = await import('@/server/shell');
const { MODULE_FOR_SLUG } = await import('@/server/platform/modules');

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });

let A: string;
let B: string;
let managerId: string;

const as = (email: string | null, organizationId: string) => {
  h.session = email ? { user: { email, organizationId } } : null;
  return shellContext();
};

const addUser = async (org: string, email: string, role: string, extra = '') =>
  (
    await admin.query(
      `INSERT INTO app_user (organization_id, email, display_name, role_id${extra ? ', manager_id' : ''})
       VALUES ($1, $2, $2, $3${extra ? ', $4' : ''}) RETURNING id`,
      extra ? [org, email, (role === 'ADMIN' ? '019e3000-0000-7000-8000-000000000001' : '019e3000-0000-7000-8000-000000000004'), extra] : [org, email, (role === 'ADMIN' ? '019e3000-0000-7000-8000-000000000001' : '019e3000-0000-7000-8000-000000000004')],
    )
  ).rows[0].id as string;

beforeAll(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  A = (await createOrganization({ name: 'Alpha Shell', slug: 'alpha-shell', adminEmail: 'boss@alpha.test', adminName: 'Boss' }))
    .organizationId;
  B = (await createOrganization({ name: 'Beta Shell', slug: 'beta-shell', adminEmail: 'boss@beta.test', adminName: 'Other' }))
    .organizationId;
  await addUser(A, 'loner@alpha.test', 'EMPLOYEE');
  managerId = await addUser(A, 'lead@alpha.test', 'MANAGER');
  await addUser(A, 'report@alpha.test', 'EMPLOYEE', managerId);
  const gone = await addUser(A, 'gone@alpha.test', 'EMPLOYEE');
  await admin.query('UPDATE app_user SET deleted_at = now() WHERE id = $1', [gone]);
  const off = await addUser(A, 'off@alpha.test', 'EMPLOYEE');
  await admin.query('UPDATE app_user SET has_access = false WHERE id = $1', [off]);
});

beforeEach(() => {
  h.session = null;
});

afterAll(async () => {
  await admin.end();
});

describe('who the shell is drawn for', () => {
  it("an admin: ExpenseOS's System Administrator, who may see everybody", async () => {
    const shell = await as('boss@alpha.test', A);
    expect(shell?.user.email).toBe('boss@alpha.test');
    expect(shell?.user.roleLabel).toBe('System Administrator');
    expect(shell?.canSeeOthers).toBe(true);
    expect(shell?.organizationName).toBe('Alpha Shell');
  });

  it('an employee with no reports may not see others', async () => {
    expect((await as('loner@alpha.test', A))?.canSeeOthers).toBe(false);
  });

  it('a manager with a report may', async () => {
    const shell = await as('lead@alpha.test', A);
    expect(shell?.user.roleLabel).toBe('Employee');
    expect(shell?.canSeeOthers).toBe(true);
  });

  it('a manager whose only report was deleted may not', async () => {
    await admin.query("UPDATE app_user SET deleted_at = now() WHERE email = 'report@alpha.test'");
    try {
      expect((await as('lead@alpha.test', A))?.canSeeOthers).toBe(false);
    } finally {
      await admin.query("UPDATE app_user SET deleted_at = NULL WHERE email = 'report@alpha.test'");
    }
  });

  it('names only module slugs the bridge knows, and always the core one', async () => {
    const shell = await as('boss@alpha.test', A);
    expect(shell?.activeModules.has('expense-management')).toBe(true);
    for (const slug of shell?.activeModules ?? []) expect(Object.keys(MODULE_FOR_SLUG)).toContain(slug);
  });

  it("reads the reader's own organization, not another's", async () => {
    expect((await as('boss@beta.test', B))?.organizationName).toBe('Beta Shell');
  });
});

describe('no shell, and no throw', () => {
  it('without a session', async () => {
    expect(await as(null, A)).toBeNull();
  });

  it('for somebody who is not a member of the organization the session names', async () => {
    expect(await as('boss@beta.test', A)).toBeNull();
  });

  it('for a deactivated account', async () => {
    expect(await as('gone@alpha.test', A)).toBeNull();
  });
});

// f04 — the root layout shows a deactivated person (or one whose access is off) why, rather
// than a blank page; nobody else gets a refusal page from it.
describe('why there is no shell', () => {
  const refusalOf = async (email: string | null, organizationId: string) => {
    h.session = email ? { user: { email, organizationId } } : null;
    return (await shellState()).refusal;
  };

  it('a deactivated account: ACCOUNT_DEACTIVATED', async () => {
    expect(await refusalOf('gone@alpha.test', A)).toBe('ACCOUNT_DEACTIVATED');
  });

  it('access turned off: ACCESS_REVOKED', async () => {
    expect(await refusalOf('off@alpha.test', A)).toBe('ACCESS_REVOKED');
  });

  it('no session, or not a member here: no refusal (the pages handle those as before)', async () => {
    expect(await refusalOf(null, A)).toBeNull();
    expect(await refusalOf('boss@beta.test', A)).toBeNull();
  });

  it('an active member: a shell and no refusal', async () => {
    h.session = { user: { email: 'loner@alpha.test', organizationId: A } };
    const state = await shellState();
    expect(state.refusal).toBeNull();
    expect(state.shell).not.toBeNull();
  });
});
