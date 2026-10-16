// @vitest-environment node
/**
 * People 1 (0072): ACCESS — ExpenseOS's `hasExpenseOSAccess`, here `has_access` — and the
 * two columns sign-in now writes.
 *
 * Decided 16 Oct 2026: access means "may sign in", separate from employment status. A person
 * whose access is off stays an employee — in the org chart, on their reports, in approvals —
 * and cannot get in. ExpenseOS refuses them in its `signIn` callback; VeloExpense refuses them
 * there too (`resolveSsoUser`) and on every request (`requireActor`, the tRPC tenant
 * middleware), so turning access off takes effect on a session that is already open.
 *
 * Gated on DATABASE_URL like every `*.db.test.ts`.
 */
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_PERMISSIONS } from '@expenseos/rbac';
import { withOrg } from '@/lib/tenant/context';
import { createOrganization } from '@/lib/onboarding/provision';
import { issueInvite } from '@/lib/invites/service';
import { resolveSsoUser } from '@/lib/auth/resolve-sso-user';
import { requireActor } from '@/lib/auth/actor';
import type { SsoIdentity } from '@/src/auth-kit';

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }));

const google = (email: string): SsoIdentity => ({
  provider: 'google',
  email,
  emailVerified: true,
  tenantId: null,
  objectId: null,
});

const EMPLOYEE = '019e3000-0000-7000-8000-000000000004';

describe.skipIf(!process.env.DATABASE_URL)('access (has_access, 0072)', () => {
  const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
  let orgId: string;
  let memberId: string;
  let founderId: string;

  const row = async (id: string) =>
    (
      await admin.query(
        'SELECT has_access, last_login_at, first_name, last_name, display_name FROM app_user WHERE id = $1',
        [id],
      )
    ).rows[0];

  beforeEach(async () => {
    await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
    const org = await createOrganization({
      name: 'Acme',
      slug: 'acme',
      adminEmail: 'founder@acme.test',
      adminName: 'Ada Founder',
    });
    orgId = org.organizationId;
    founderId = org.adminUserId;
    memberId = (
      await admin.query(
        `INSERT INTO app_user (organization_id, email, display_name) VALUES ($1, 'kim@acme.test', 'Kim Lee') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await admin.end();
  });

  it('starts every existing member with access', async () => {
    expect((await row(memberId)).has_access).toBe(true);
  });

  it('signs a member in and records when', async () => {
    expect((await row(memberId)).last_login_at).toBeNull();
    const r = await resolveSsoUser('acme', google('kim@acme.test'));
    expect(r).toMatchObject({ userId: memberId });
    expect((await row(memberId)).last_login_at).toBeInstanceOf(Date);
  });

  it('refuses a member whose access is off, as a disabled account, and records nothing', async () => {
    await admin.query('UPDATE app_user SET has_access = false WHERE id = $1', [memberId]);
    await expect(resolveSsoUser('acme', google('kim@acme.test'))).resolves.toEqual({
      denied: 'account_disabled',
    });
    expect((await row(memberId)).last_login_at).toBeNull();
  });

  it('refuses an open session on its next request, not only at sign-in', async () => {
    await expect(withOrg(orgId, (tx) => requireActor(tx, 'kim@acme.test'))).resolves.toMatchObject({
      id: memberId,
      has_access: true,
    });
    await admin.query('UPDATE app_user SET has_access = false WHERE id = $1', [memberId]);
    await expect(withOrg(orgId, (tx) => requireActor(tx, 'kim@acme.test'))).rejects.toMatchObject({
      code: 'NO_ACCESS',
    });
  });

  it('refuses a tRPC call from a member whose access is off', async () => {
    const { resolveTenantMember } = await import('@/server/trpc');
    const { withTenantDb } = await import('@/lib/db/prisma');
    const call = () =>
      withTenantDb(orgId, (tx) => resolveTenantMember(tx, { email: 'kim@acme.test', organizationId: orgId }, null));
    await expect(call()).resolves.toMatchObject({ session: { user: { id: memberId } } });
    await admin.query('UPDATE app_user SET has_access = false WHERE id = $1', [memberId]);
    await expect(call()).rejects.toThrow(/access to this organization has been turned off/);
  });

  it('gives a newly accepted member a first and last name, and records their first sign-in', async () => {
    await withOrg(orgId, (tx) =>
      issueInvite(
        tx,
        { id: founderId, name: 'Ada Founder', role: 'System Administrator' },
        { email: 'new@acme.test', roleId: EMPLOYEE, displayName: 'Grace Brewster Hopper' },
        { permissions: ALL_PERMISSIONS },
      ),
    );
    const r = await resolveSsoUser('acme', google('new@acme.test'));
    if ('denied' in r) throw new Error(`denied: ${r.denied}`);
    expect(await row(r.userId)).toMatchObject({
      display_name: 'Grace Brewster Hopper',
      first_name: 'Grace',
      last_name: 'Brewster Hopper',
      has_access: true,
    });
    expect((await row(r.userId)).last_login_at).toBeInstanceOf(Date);
  });
});
